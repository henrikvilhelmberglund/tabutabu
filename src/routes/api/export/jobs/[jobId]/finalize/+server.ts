// Overlays the tab-only frame sequence (produced by the puppeteer-hosted
// render page) onto the source video via ffmpeg's `overlay` filter, encodes
// with NVENC, and writes out.mp4. Audio comes directly from the source video.
//
// Two composite modes:
//   - Overlay:  output dims = source dims; tab is drawn on top of the video.
//               filter: [0:v][1:v]overlay=tabX:tabY
//   - Extend:   output dims are taller than the source; video is placed inside
//               a black-padded canvas, tab in the extra space.
//               filter: [0:v]pad=W:H:videoX:videoY[bg];[bg][1:v]overlay=tabX:tabY
//
// The render page only produces tab-sized JPEGs (tabW × tabH), which means the
// video track never has to be re-decoded/composited in the browser.

import type { RequestHandler } from './$types';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { outputPath, readConfig, videoPath } from '$lib/server/exportJobs';

export const POST: RequestHandler = async ({ params, request }) => {
	const cfg = await readConfig(params.jobId);
	if (!cfg) return new Response('job not found', { status: 404 });

	const framesEntry = (await request.formData()).get('frames');
	if (!(framesEntry instanceof Blob)) {
		return new Response('missing frames field', { status: 400 });
	}

	const audio = videoPath(params.jobId);
	const out = outputPath(params.jobId);
	const encoder = cfg.encoder;
	const isNvenc = encoder.endsWith('_nvenc');
	const nvencArgs = isNvenc
		? ['-preset', 'medium', '-rc', 'vbr', '-cq', '22']
		: encoder === 'libx264' || encoder === 'libx265'
			? ['-preset', 'medium', '-crf', '20']
			: [];

	const L = cfg.compositeLayout;
	const cropTop = Math.round(L.cropTop ?? 0);
	const cropBottom = Math.round(L.cropBottom ?? 0);
	// Do we need to pad the source frame to a larger output canvas? True for
	// the "extend" modes where output is taller than source. Cropping doesn't
	// need padding on its own but crop+different-out-size does.
	const isCropping = cropTop > 0 || cropBottom > 0;
	const needsPad =
		!isCropping &&
		(L.outW !== L.videoW || L.outH !== L.videoH || L.videoX !== 0 || L.videoY !== 0);

	// Build the filter graph. Tab is the second input (index 1). Video is 0.
	//   crop-top-bottom:    crop top AND bottom of source, pad to output size,
	//                       overlay tab in the freed bottom band.
	//   extend-below/above: pad source into a taller canvas, then overlay tab.
	//   overlay:            no source transform, just overlay tab.
	let filter: string;
	if (isCropping) {
		// crop=w:h:x:y — keep iw wide, keep (ih - cropTop - cropBottom) tall,
		// starting cropTop pixels down from the top of the source.
		filter =
			`[0:v]crop=iw:ih-${cropTop + cropBottom}:0:${cropTop},` +
			`pad=${L.outW}:${L.outH}:${L.videoX}:${L.videoY}:color=black[bg];` +
			`[bg][1:v]overlay=${L.tabX}:${L.tabY}[v]`;
	} else if (needsPad) {
		filter =
			`[0:v]pad=${L.outW}:${L.outH}:${L.videoX}:${L.videoY}:color=black[bg];` +
			`[bg][1:v]overlay=${L.tabX}:${L.tabY}[v]`;
	} else {
		filter = `[0:v][1:v]overlay=${L.tabX}:${L.tabY}[v]`;
	}

	const args: string[] = [
		'-hide_banner',
		'-loglevel', 'info',
		'-y',
		// Input 0: source video (includes audio).
		'-i', audio,
		// Input 1: tab-only JPEG stream.
		'-f', 'image2pipe',
		'-vcodec', 'mjpeg',
		'-framerate', String(cfg.sourceFps),
		'-i', 'pipe:0',
		'-filter_complex', filter,
		'-map', '[v]',
		'-map', '0:a:0?',
		'-c:v', encoder,
		...nvencArgs,
		'-b:v', String(cfg.bitrate),
		'-pix_fmt', 'yuv420p',
		'-r', String(cfg.sourceFps),
		'-c:a', 'aac',
		'-b:a', '192k',
		'-shortest',
		'-movflags', '+faststart',
		out
	];

	console.log('[finalize]', params.jobId, 'ffmpeg', args.join(' '));
	const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });

	let stderrTail = '';
	ff.stderr.on('data', (d: Buffer) => {
		const t = d.toString();
		stderrTail += t;
		if (stderrTail.length > 40_000) stderrTail = stderrTail.slice(-20_000);
		process.stderr.write(t);
	});
	ff.stdin.on('error', (err: NodeJS.ErrnoException) => {
		if (err.code !== 'EPIPE') console.error('[finalize] stdin err', err);
	});

	const pump = (async () => {
		const reader = (framesEntry as Blob).stream().getReader();
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				if (value && !ff.stdin.write(value)) {
					await new Promise<void>((r) => ff.stdin.once('drain', () => r()));
				}
			}
		} finally {
			try {
				ff.stdin.end();
			} catch {
				// already closed
			}
		}
	})();

	const exit = await new Promise<number>((resolve) => {
		let pumpDone = false;
		let ffCode: number | null = null;
		const maybe = () => {
			if (pumpDone && ffCode !== null) resolve(ffCode);
		};
		pump.then(() => {
			pumpDone = true;
			maybe();
		});
		ff.on('close', (c) => {
			ffCode = c ?? -1;
			maybe();
		});
		ff.on('error', (err) => {
			console.error('[finalize] ffmpeg err', err);
			ffCode = -1;
			maybe();
		});
	});

	if (exit !== 0) {
		console.error('[finalize] ffmpeg failed. stderr tail:\n' + stderrTail.slice(-4000));
		return new Response(`ffmpeg exit ${exit}\n\n` + stderrTail.slice(-4000), { status: 500 });
	}
	const stat = await fs.stat(out).catch(() => null);
	if (!stat) return new Response('output missing after ffmpeg', { status: 500 });
	console.log('[finalize]', params.jobId, 'out.mp4', stat.size, 'bytes');
	return new Response(JSON.stringify({ ok: true, size: stat.size }), {
		headers: { 'Content-Type': 'application/json' }
	});
};
