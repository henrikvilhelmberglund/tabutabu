<script lang="ts">
	// Tab-only render page. Loaded inside puppeteer's headless Chrome to
	// produce N tab frames (N = source video's frame count) at the source's
	// native fps. No `<video>` element, no playback, no rVFC — we just call
	// renderTabFrame(t) in a loop at exact fps intervals. JPEG encoding runs
	// in a worker pool. When all frames are POSTed to /finalize, the server
	// composites them onto the source video with ffmpeg's overlay filter.
	//
	// This decouples capture speed from realtime playback: 3000 frames finish
	// as fast as the worker pool can encode them (~10–20 s) instead of the
	// source video's duration.

	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import {
		renderTabFrame,
		DEFAULT_RENDER_CONFIG,
		type RenderMode,
		type PlayheadStyle,
		type Theme
	} from '$lib/tab/renderer';
	import { TUNINGS } from '$lib/tab/tuning';
	import type { Tab } from '$lib/tab/types';

	type JobConfig = {
		videoOffsetSec: number;
		encoder: string;
		bitrate: number;
		tab: Tab;
		tuningKey: keyof typeof TUNINGS;
		renderMode: RenderMode;
		playheadStyle: PlayheadStyle;
		theme: Theme;
		stringFlashEnabled: boolean;
		pixelsPerSecond: number;
		barsPerPage: number;
		peekBeats: number;
		showNoteLengths: boolean;
		compositeLayout: {
			outW: number;
			outH: number;
			videoX: number;
			videoY: number;
			videoW: number;
			videoH: number;
			tabX: number;
			tabY: number;
			tabW: number;
			tabH: number;
		};
		sourceFps: number;
		sourceDurationSec: number;
		sourceFrameCount: number;
	};

	let statusText = $state('Loading job…');
	let progress = $state(0);
	let framesCount = $state(0);
	let jobId = $derived(page.params.jobId);

	function setError(msg: string) {
		statusText = 'Error: ' + msg;
		console.error('[render] error:', msg);
		(window as unknown as { __tabutabuError?: string }).__tabutabuError = msg;
	}

	function setDone() {
		(window as unknown as { __tabutabuDone?: boolean }).__tabutabuDone = true;
	}

	onMount(async () => {
		try {
			const cfgRes = await fetch(`/api/export/jobs/${jobId}/config`);
			if (!cfgRes.ok) throw new Error('config fetch failed: ' + cfgRes.status);
			const cfg = (await cfgRes.json()) as JobConfig;

			statusText = 'Preparing…';
			const tabW = Math.max(1, Math.round(cfg.compositeLayout.tabW));
			const tabH = Math.max(1, Math.round(cfg.compositeLayout.tabH));

			// Tab canvas — the ONLY canvas the render page ever draws to. The
			// server ffmpeg overlays this on the source video, so we don't
			// need to composite the video in here.
			const tabCanvas = new OffscreenCanvas(tabW, tabH);
			const tabCtxOrNull = tabCanvas.getContext('2d');
			if (!tabCtxOrNull) throw new Error('no 2d ctx for tab canvas');
			const tabCtx: OffscreenCanvasRenderingContext2D = tabCtxOrNull;

			// Worker pool for JPEG encoding. Scale with cores but cap.
			const workerCount = Math.min(Math.max(2, navigator.hardwareConcurrency ?? 4), 16);
			const workers: Worker[] = [];
			const pending = new Map<
				number,
				{ resolve: (b: Blob) => void; reject: (m: string) => void }
			>();
			for (let i = 0; i < workerCount; i++) {
				const w = new Worker(new URL('$lib/export/jpeg-worker.ts', import.meta.url), {
					type: 'module'
				});
				w.onmessage = (ev: MessageEvent) => {
					const m = ev.data as
						| { kind: 'result'; id: number; buffer: ArrayBuffer }
						| { kind: 'error'; id: number; message: string };
					const p = pending.get(m.id);
					if (!p) return;
					pending.delete(m.id);
					if (m.kind === 'result') p.resolve(new Blob([m.buffer], { type: 'image/jpeg' }));
					else p.reject(m.message);
				};
				workers.push(w);
			}

			// Bound how many encodes we let queue up so memory doesn't balloon
			// on a slow disk. Each in-flight is ~11 MB of raw ImageBitmap +
			// ~100 KB blob on completion.
			let inflightCount = 0;
			const MAX_INFLIGHT = workerCount * 4;
			const RESUME_UNDER = workerCount * 2;
			let resumeGate: (() => void) | null = null;
			const waitForRoom = () => {
				if (inflightCount < MAX_INFLIGHT) return Promise.resolve();
				return new Promise<void>((res) => {
					resumeGate = res;
				});
			};

			const encodeOne = (bitmap: ImageBitmap, idx: number): Promise<Blob> => {
				const worker = workers[idx % workerCount];
				inflightCount++;
				return new Promise<Blob>((resolve, reject) => {
					pending.set(idx, {
						resolve: (blob) => {
							inflightCount--;
							if (resumeGate && inflightCount <= RESUME_UNDER) {
								const g = resumeGate;
								resumeGate = null;
								g();
							}
							resolve(blob);
						},
						reject: (msg) => {
							inflightCount--;
							if (resumeGate && inflightCount <= RESUME_UNDER) {
								const g = resumeGate;
								resumeGate = null;
								g();
							}
							reject(msg);
						}
					});
					worker.postMessage(
						{ kind: 'encode', id: idx, bitmap, quality: 0.9 },
						[bitmap]
					);
				});
			};

			// Render into a fixed "logical" coordinate space (1280 × 260 —
			// the UI's tab canvas HTML dims) and then use a canvas transform
			// to scale up to the actual OffscreenCanvas pixel dimensions.
			// Same reason we do `setTransform(dpr, ...)` in the browser UI:
			// it keeps proportions and font density identical to what the
			// user sees on-screen, regardless of the video's tab-region
			// pixel size (usually ~1728 for 1920-wide sources). Without this
			// the fixed 18 px font looks tiny on a wider canvas and the
			// inline h/p markers develop huge empty gaps around them.
			const LOGICAL_W = 1280;
			const LOGICAL_H = 260;
			const scaleX = tabCanvas.width / LOGICAL_W;
			const scaleY = tabCanvas.height / LOGICAL_H;

			function renderTab(t: number) {
				const cfgObj = { ...DEFAULT_RENDER_CONFIG };
				cfgObj.width = LOGICAL_W;
				cfgObj.height = LOGICAL_H;
				cfgObj.mode = cfg.renderMode;
				cfgObj.playheadStyle = cfg.playheadStyle;
				cfgObj.theme = cfg.theme;
				cfgObj.stringFlashEnabled = cfg.stringFlashEnabled;
				cfgObj.pixelsPerSecond = cfg.pixelsPerSecond;
				cfgObj.barsPerPage = cfg.barsPerPage;
				cfgObj.peekBeats = cfg.peekBeats;
				cfgObj.showNoteLengths = cfg.showNoteLengths;
				tabCtx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
				renderTabFrame(
					tabCtx as unknown as CanvasRenderingContext2D,
					cfg.tab,
					TUNINGS[cfg.tuningKey],
					t,
					cfgObj
				);
			}

			const totalFrames = cfg.sourceFrameCount;
			const fps = cfg.sourceFps;
			const capturedPromises: Promise<Blob>[] = [];

			statusText = `Rendering ${totalFrames} frames…`;
			for (let i = 0; i < totalFrames; i++) {
				await waitForRoom();
				const t = i / fps - cfg.videoOffsetSec;
				renderTab(t);
				const bitmap = tabCanvas.transferToImageBitmap();
				capturedPromises.push(encodeOne(bitmap, i));
				progress = i / totalFrames;
				if (i % 32 === 0) framesCount = i;
			}
			framesCount = totalFrames;

			statusText = 'Waiting for worker pool…';
			const blobs = await Promise.all(
				capturedPromises.map((p) =>
					p.catch((err) => {
						console.error('[render] worker encode err:', err);
						return null as Blob | null;
					})
				)
			);
			workers.forEach((w) => w.terminate());
			const goodBlobs: Blob[] = blobs.filter((b): b is Blob => !!b);

			console.log(
				'[render] tab frames done',
				JSON.stringify({
					requested: totalFrames,
					produced: goodBlobs.length,
					fps
				})
			);

			statusText = 'ffmpeg encoding…';
			const framesBlob = new Blob(goodBlobs, { type: 'application/octet-stream' });
			const form = new FormData();
			form.append('frames', framesBlob, 'frames.mjpg');
			const res = await fetch(`/api/export/jobs/${jobId}/finalize`, {
				method: 'POST',
				body: form
			});
			if (!res.ok) {
				const t = await res.text().catch(() => '');
				throw new Error('finalize failed: ' + res.status + ' ' + t);
			}
			statusText = 'Done.';
			setDone();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	});
</script>

<svelte:head>
	<title>Tabutabu render</title>
</svelte:head>

<div class="wrap">
	<h1>Tabutabu render</h1>
	<p class="mono">job: {jobId}</p>
	<p class="mono">{statusText}</p>
	<p class="mono">{(progress * 100).toFixed(1)}% · {framesCount} frames</p>
</div>

<style>
	.wrap {
		font-family: system-ui, -apple-system, sans-serif;
		padding: 16px;
		color: #ddd;
		background: #111;
		min-height: 100vh;
		box-sizing: border-box;
	}
	.mono {
		font-family: 'JetBrains Mono Variable', ui-monospace, monospace;
	}
	h1 {
		margin: 0 0 12px 0;
		font-size: 20px;
	}
</style>
