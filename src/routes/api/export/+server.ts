// Orchestrator endpoint. Client POSTs the tab data + source video + render
// config here; we launch a headless puppeteer that opens /render/<jobId>,
// which does the actual frame capture inside its own always-foreground tab
// (so Chrome doesn't throttle rVFC while the user is doing other things).
//
// Puppeteer's render page POSTs the frames to /api/export/jobs/<jobId>/finalize
// which runs ffmpeg-NVENC and writes out.mp4. When puppeteer's page signals
// completion, we read that file and stream it back as the response.
//
// Flow:
//   client POST /api/export  (multipart: tab, video, config)
//     → server saves inputs, launches puppeteer
//     → puppeteer opens /render/<jobId>
//     → render page captures frames
//     → render page POSTs frames to /api/export/jobs/<jobId>/finalize
//     → finalize runs ffmpeg → out.mp4 on disk
//     → render page sets window.__tabutabuDone = true
//     → orchestrator reads out.mp4, returns it
//     → cleanup

import type { RequestHandler } from './$types';
import { createReadStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import {
	cleanupJob,
	createJob,
	outputPath,
	videoPath,
	writeConfig,
	writeVideo,
	type JobConfig
} from '$lib/server/exportJobs';

// Runs ffprobe on the just-saved source video to learn its native fps and
// duration. The render page uses these to iterate frames at exactly the
// source's own rate.
async function probeVideo(path: string): Promise<{ fps: number; durationSec: number }> {
	return new Promise((resolve, reject) => {
		const args = [
			'-v', 'error',
			'-select_streams', 'v:0',
			'-show_entries', 'stream=r_frame_rate,duration',
			'-show_entries', 'format=duration',
			'-of', 'json',
			path
		];
		const p = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		p.stdout.on('data', (d: Buffer) => (out += d.toString()));
		p.stderr.on('data', (d: Buffer) => (err += d.toString()));
		p.on('error', (e) => reject(e));
		p.on('close', (code) => {
			if (code !== 0) return reject(new Error(`ffprobe exit ${code}: ${err}`));
			try {
				const data = JSON.parse(out) as {
					streams?: Array<{ r_frame_rate?: string; duration?: string }>;
					format?: { duration?: string };
				};
				const stream = data.streams?.[0];
				const rate = stream?.r_frame_rate ?? '30/1';
				const [num, den] = rate.split('/').map((s) => Number(s));
				const fps = den ? num / den : 30;
				const durStr = stream?.duration ?? data.format?.duration ?? '0';
				const durationSec = Number(durStr) || 0;
				resolve({ fps, durationSec });
			} catch (e) {
				reject(e);
			}
		});
	});
}

// Lazy-loaded so `bun run dev` doesn't need puppeteer to boot the server.
let puppeteerLib: typeof import('puppeteer') | null = null;
async function loadPuppeteer() {
	if (!puppeteerLib) puppeteerLib = (await import('puppeteer')).default as never;
	return puppeteerLib!;
}

export const POST: RequestHandler = async ({ request, url }) => {
	let form: FormData;
	try {
		form = await request.formData();
	} catch (err) {
		return new Response(
			'expected multipart with "video", "config", and optionally "tab"',
			{ status: 400 }
		);
	}
	const videoEntry = form.get('video');
	const configEntry = form.get('config');
	if (!(videoEntry instanceof Blob) || typeof configEntry !== 'string') {
		return new Response('missing video or config field', { status: 400 });
	}
	let cfg: JobConfig;
	try {
		cfg = JSON.parse(configEntry) as JobConfig;
	} catch (err) {
		return new Response(
			'invalid config JSON: ' + (err instanceof Error ? err.message : String(err)),
			{ status: 400 }
		);
	}
	cfg.videoMime = videoEntry.type || 'video/mp4';

	const jobId = await createJob();
	console.log('[api/export] job', jobId, 'created');
	try {
		await writeVideo(jobId, Buffer.from(await videoEntry.arrayBuffer()));

		// Probe the source video so the render page knows exactly how many
		// tab frames to emit and at what rate.
		let probe: { fps: number; durationSec: number };
		try {
			probe = await probeVideo(videoPath(jobId));
		} catch (err) {
			return new Response(
				'ffprobe failed: ' + (err instanceof Error ? err.message : String(err)),
				{ status: 500 }
			);
		}
		// Snap non-integer probed fps (e.g. 29.97) to the nearest common rate
		// for clean metadata.
		const commonRates = [24, 25, 30, 48, 50, 60, 120];
		let fps = probe.fps;
		for (const r of commonRates) {
			if (Math.abs(fps - r) / r < 0.03) {
				fps = r;
				break;
			}
		}
		cfg.sourceFps = fps;
		cfg.sourceDurationSec = probe.durationSec;
		cfg.sourceFrameCount = Math.max(1, Math.round(fps * probe.durationSec));
		console.log(
			'[api/export]',
			jobId,
			'probe:',
			fps.toFixed(3),
			'fps ×',
			probe.durationSec.toFixed(3),
			's =',
			cfg.sourceFrameCount,
			'frames'
		);
		await writeConfig(jobId, cfg);

		// The render page lives on the same origin as the current request so
		// we can reuse the incoming URL's host/port. In dev that's Vite; in
		// prod it's whichever adapter is running.
		const origin = url.origin;
		const renderUrl = `${origin}/render/${jobId}`;
		console.log('[api/export]', jobId, 'launching puppeteer for', renderUrl);

		const puppeteer = await loadPuppeteer();
		const browser = await puppeteer.launch({
			headless: true,
			args: [
				'--disable-blink-features=AutomationControlled',
				'--autoplay-policy=no-user-gesture-required',
				'--mute-audio',
				// Keep the tab from being downgraded when it's off-screen.
				'--disable-background-timer-throttling',
				'--disable-renderer-backgrounding',
				'--disable-backgrounding-occluded-windows'
			],
			// Match the compositor to the target output dims so screencast /
			// rVFC operate at 1:1 with our composite.
			defaultViewport: {
				width: cfg.compositeLayout.outW,
				height: cfg.compositeLayout.outH,
				deviceScaleFactor: 1
			}
		});

		try {
			const page = await browser.newPage();
			// Forward the render page's console to our dev terminal so we can
			// diagnose "why didn't it finish?" without opening a browser.
			page.on('console', (msg) => {
				console.log('[render/' + jobId + ']', msg.type(), msg.text());
			});
			page.on('pageerror', (err) => {
				console.error('[render/' + jobId + '] pageerror:', err);
			});

			await page.goto(renderUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

			// The render page signals completion by setting `window.__tabutabuDone`.
			// If it errors it sets `window.__tabutabuError` to a string.
			const timeoutMs = Math.max(60_000, Math.round((cfg.compositeLayout.outH * 300) + 60_000));
			await page.waitForFunction(
				'window.__tabutabuDone === true || typeof window.__tabutabuError === "string"',
				{ timeout: timeoutMs, polling: 500 }
			);

			const pageErr = await page.evaluate(
				() => (window as unknown as { __tabutabuError?: string }).__tabutabuError
			);
			if (pageErr) {
				console.error('[api/export]', jobId, 'render page error:', pageErr);
				return new Response('render page error: ' + pageErr, { status: 500 });
			}

			const outPathAbs = outputPath(jobId);
			const stat = await fs.stat(outPathAbs).catch(() => null);
			if (!stat) {
				return new Response('no output produced', { status: 500 });
			}
			console.log('[api/export]', jobId, 'streaming', stat.size, 'bytes back');
			// Stream the file back. Cleanup happens after the response body is
			// drained (both success and error paths close the stream).
			const fileStream = createReadStream(outPathAbs);
			fileStream.on('close', () => {
				void cleanupJob(jobId);
			});
			const webBody = Readable.toWeb(fileStream) as ReadableStream<Uint8Array>;
			return new Response(webBody, {
				status: 200,
				headers: {
					'Content-Type': 'video/mp4',
					'Content-Length': String(stat.size),
					'Cache-Control': 'no-store',
					'X-Encoder': cfg.encoder,
					'X-Job-Id': jobId
				}
			});
		} finally {
			await browser.close().catch(() => {});
		}
	} catch (err) {
		console.error('[api/export]', jobId, 'orchestrator error:', err);
		void cleanupJob(jobId);
		return new Response(
			'orchestrator error: ' + (err instanceof Error ? err.message : String(err)),
			{ status: 500 }
		);
	}
};

// Probe endpoint: which ffmpeg encoders are available? Called by the UI to
// populate the encoder dropdown.
export const GET: RequestHandler = async () => {
	const result = await new Promise<{ ok: boolean; encoders: string[]; error?: string }>(
		(resolve) => {
			const ff = spawn('ffmpeg', ['-hide_banner', '-encoders'], {
				stdio: ['ignore', 'pipe', 'pipe']
			});
			let out = '';
			ff.stdout.on('data', (d: Buffer) => (out += d.toString()));
			ff.on('error', (err) => resolve({ ok: false, encoders: [], error: err.message }));
			ff.on('close', () => {
				const encoders: string[] = [];
				for (const cand of ['h264_nvenc', 'hevc_nvenc', 'av1_nvenc', 'libx264', 'libx265']) {
					if (new RegExp(`\\b${cand}\\b`).test(out)) encoders.push(cand);
				}
				resolve({ ok: true, encoders });
			});
		}
	);
	return new Response(JSON.stringify(result), {
		headers: { 'Content-Type': 'application/json' }
	});
};
