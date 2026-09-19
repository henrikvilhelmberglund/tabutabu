<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { parseMidi } from '$lib/midi/parse';
	import { parseDawproject } from '$lib/dawproject/parse';
	import { inspectMidi, type MidiInspection } from '$lib/midi/expressions';
	import {
		renderTabFrame,
		DEFAULT_RENDER_CONFIG,
		type RenderMode,
		type PlayheadStyle,
		type Theme
	} from '$lib/tab/renderer';
	import { TUNINGS, STRING_COUNT, MAX_FRET } from '$lib/tab/tuning';
	import type { Tab } from '$lib/tab/types';
	import { overrideKey } from '$lib/midi/arrange';
	import { Synth, DEFAULT_SYNTH_OPTIONS } from '$lib/audio/synth';
	import { DawSync, type SyncPortInfo } from '$lib/midi/sync';
	import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';

	let tab = $state<Tab | null>(null);
	let tuningKey = $state<keyof typeof TUNINGS>('standard');
	let currentTime = $state(0);
	let playing = $state(false);
	let pixelsPerSecond = $state(DEFAULT_RENDER_CONFIG.pixelsPerSecond);
	let renderMode = $state<RenderMode>(DEFAULT_RENDER_CONFIG.mode);
	let playheadStyle = $state<PlayheadStyle>(DEFAULT_RENDER_CONFIG.playheadStyle);
	let theme = $state<Theme>(DEFAULT_RENDER_CONFIG.theme);
	let stringFlashEnabled = $state(DEFAULT_RENDER_CONFIG.stringFlashEnabled);
	let barsPerPage = $state(DEFAULT_RENDER_CONFIG.barsPerPage);
	let peekBeats = $state(DEFAULT_RENDER_CONFIG.peekBeats);
	let showNoteLengths = $state(DEFAULT_RENDER_CONFIG.showNoteLengths);
	let fileName = $state<string | null>(null);
	let parseError = $state<string | null>(null);
	// Off by default so MPE MIDI (Bitwig per-note expressions) isn't misinterpreted.
	let honorChannelStrings = $state(false);
	// Per-note manual string overrides. Keyed by overrideKey(time, midi, channel).
	// Reactive so the tab re-parses when they change.
	let overrides = $state<Record<string, number>>({});
	// Per-note manual technique annotations. 'off' means "remove any auto-detected".
	let annotations = $state<Record<string, 'hammer' | 'pull' | 'tap' | 'off'>>({});

	let canvas: HTMLCanvasElement;
	let timelineCanvas: HTMLCanvasElement;
	// Kept out of $state so buffer identity doesn't drive reactivity.
	let midiBuffer: ArrayBuffer | null = null;
	let isDawprojectFile = false;
	// Non-reactive gate: when true, per-file persistence effects skip writing to
	// IndexedDB. Used while loading a file so the initial empty state isn't
	// saved on top of the file's actual persisted overrides/annotations.
	let suppressPerFilePersist = false;
	let inspection = $state<MidiInspection | null>(null);
	let timelineDragging = false;

	let audioOn = $state(true);
	let volume = $state(DEFAULT_SYNTH_OPTIONS.masterVolume);
	let metronomeOn = $state(DEFAULT_SYNTH_OPTIONS.metronomeEnabled);
	let metronomeVol = $state(DEFAULT_SYNTH_OPTIONS.metronomeVolume);

	// Performance-video overlay
	let videoUrl = $state<string | null>(null);
	let videoFileName = $state<string | null>(null);
	// Video time when tab time = 0. Positive value → video is that many seconds
	// ahead of the tab (start the video farther in). Adjust until they align.
	let videoOffsetSec = $state(0);
	let videoAudioOn = $state(false);
	let videoElement = $state<HTMLVideoElement | null>(null);
	let videoDuration = $state<number | null>(null);
	// Composite canvas: shows video + tab overlay both during preview (WYSIWYG)
	// and during export. Drawn every rAF frame when a video is loaded.
	let compositeCanvas = $state<HTMLCanvasElement | null>(null);

	// Video export state
	let isExporting = $state(false);
	let exportProgress = $state(0);
	let exportError = $state<string | null>(null);
	let exportStage = $state<'idle' | 'encoding' | 'flushing' | 'finalizing' | 'done'>('idle');
	// After a successful export: blob URL of the resulting MP4 for in-page
	// preview, and the filename we'd download it as. The URL is revoked when
	// the user starts a new export or clears the result.
	let exportResultUrl = $state<string | null>(null);
	let exportResultName = $state<string | null>(null);
	let exportResultSize = $state(0);
	let exportFramesEncoded = $state(0);
	let tabPositionOnVideo = $state<
		'bottom' | 'top' | 'extend-below' | 'extend-above' | 'crop-top-bottom'
	>('bottom');
	let tabSizePercent = $state(90);
	let tabPaddingPercent = $state(2);
	let exportFps = $state(60);
	// Which ffmpeg encoder the server should use. h264_nvenc is fastest on
	// NVIDIA hardware; libx264 is the software fallback. We probe on mount.
	let exportEncoder = $state<'h264_nvenc' | 'hevc_nvenc' | 'av1_nvenc' | 'libx264' | 'libx265'>(
		'h264_nvenc'
	);
	let availableEncoders = $state<string[]>([]);
	let exportRecorder: MediaRecorder | null = null;
	// Used to only issue play/pause commands when playing state changes, not on
	// every rAF tick.
	let lastVideoPlayCommand: 'play' | 'pause' | null = null;
	// Debounce timer for offset-driven seeks. Non-null = a seek is pending.
	let offsetSeekTimer: ReturnType<typeof setTimeout> | null = null;
	// Set to true while we've auto-paused playback for an offset change so we
	// know to resume once the video seek completes.
	let pausedForOffsetSeek = false;
	const synth = new Synth();
	$effect(() => synth.setVolume(volume));
	$effect(() => synth.setMetronome(metronomeOn, metronomeVol));
	// If playback is in progress and the metronome is toggled on/off, re-queue so
	// the change is audible immediately rather than only on the next play() call.
	let lastMetronomeState = false;
	$effect(() => {
		if (playing && tab && metronomeOn !== lastMetronomeState) {
			if (audioOn) synth.play(tab, currentTime);
		}
		lastMetronomeState = metronomeOn;
	});

	// DAW transport sync (loopMIDI etc.)
	let syncPorts = $state<SyncPortInfo[]>([]);
	let syncSelectedPort = $state<string>('');
	let syncConnected = $state(false);
	let syncError = $state<string | null>(null);
	// Positive = Tabutabu jumps forward this many ms whenever the DAW starts or
	// seeks. Compensates for loopMIDI + browser event delivery (usually 10–30 ms).
	let syncOffsetMs = $state(20);
	let keepLeadingSilence = $state(false);
	let preservePositionOnStart = $state(false);
	let syncDebug = $state(false);
	// DAW positions are in "song time" (bar 1 beat 1 = 0). Tab positions can be
	// shifted forward if we trimmed leading silence when parsing the file. This
	// converts one to the other. If the tab preserved leading silence, the trim
	// is 0 and DAW time == tab time.
	function dawToTabTime(dawSec: number): number {
		if (!tab) return 0;
		return dawSec - tab.trimmedLeadingSec + syncOffsetMs / 1000;
	}

	const dawSync = new DawSync({
		onStart: () => {
			if (!tab) return;
			const start = Math.max(0, Math.min(effectiveDurationSec, dawToTabTime(0)));
			currentTime = start;
			lastSeekTime = start;
			if (!playing) playing = true;
			if (audioOn) synth.play(tab, start);
		},
		onContinue: () => {
			if (!tab) return;
			if (!playing) {
				playing = true;
				if (audioOn) synth.play(tab, currentTime);
			}
		},
		onStop: () => {
			if (playing) {
				playing = false;
				synth.stop();
			}
		},
		onSeek: (pos: number) => {
			if (!tab) return;
			const t = Math.max(0, Math.min(effectiveDurationSec, dawToTabTime(pos)));
			currentTime = t;
			lastSeekTime = t;
			if (playing && audioOn) synth.play(tab, t);
		}
	});
	// Keep SPP conversion accurate when a new tab is loaded (its BPM may differ).
	$effect(() => {
		if (tab) dawSync.setTempo(tab.bpm);
	});
	$effect(() => {
		dawSync.preservePositionOnStart = preservePositionOnStart;
	});
	$effect(() => {
		dawSync.debug = syncDebug;
	});

	async function refreshSyncPorts() {
		try {
			syncError = null;
			syncPorts = await dawSync.listPorts();
			if (!syncSelectedPort && syncPorts.length > 0) syncSelectedPort = syncPorts[0].id;
		} catch (err) {
			syncError = err instanceof Error ? err.message : String(err);
		}
	}

	async function syncConnect() {
		try {
			syncError = null;
			await dawSync.connect(syncSelectedPort);
			syncConnected = true;
			try {
				localStorage.setItem('tabutabu.syncPort', syncSelectedPort);
			} catch {
				// ignore
			}
		} catch (err) {
			syncError = err instanceof Error ? err.message : String(err);
			syncConnected = false;
		}
	}

	function syncDisconnect() {
		dawSync.disconnect();
		syncConnected = false;
	}

	// Expose parsed tab on window for interactive debugging in the DevTools
	// console (e.g. `tabDebug.notes.filter(n => Math.abs(n.time - 21.5) < 0.2)`).
	$effect(() => {
		if (typeof window !== 'undefined') {
			(window as unknown as { tabDebug?: Tab | null }).tabDebug = tab;
		}
	});


	async function loadFileFromBuffer(
		buffer: ArrayBuffer,
		name: string,
		persist: boolean
	): Promise<void> {
		parseError = null;
		// Gate persistence effects while we swap in the new file's state. Otherwise
		// the effects would fire between `fileName = name` and the awaited IDB
		// reads and clobber the saved overrides/annotations with the empty ones
		// that are still in memory.
		suppressPerFilePersist = true;
		fileName = name;
		try {
			midiBuffer = buffer;
			// Load per-file overrides + annotations before parsing so the first
			// render applies them.
			try {
				const saved = (await idbGet(`overrides:${name}`)) as
					| Record<string, number>
					| undefined;
				overrides = saved ?? {};
			} catch {
				overrides = {};
			}
			try {
				const savedAnno = (await idbGet(`annotations:${name}`)) as
					| Record<string, 'hammer' | 'pull' | 'tap' | 'off'>
					| undefined;
				annotations = savedAnno ?? {};
			} catch {
				annotations = {};
			}
			suppressPerFilePersist = false;
			const isDawproject = /\.dawproject$/i.test(name);
			const opts = { honorChannelStrings, keepLeadingSilence, overrides, annotations };
			if (isDawproject) {
				inspection = null;
				tab = await parseDawproject(midiBuffer, TUNINGS[tuningKey], opts);
			} else {
				inspection = inspectMidi(midiBuffer);
				tab = parseMidi(midiBuffer, TUNINGS[tuningKey], opts);
			}
			isDawprojectFile = isDawproject;
			currentTime = 0;
			if (persist) {
				try {
					await idbSet('lastFile', { name, buffer, isDawproject });
				} catch {
					// storage might be full or blocked — best-effort persistence
				}
			}
		} catch (err) {
			parseError = err instanceof Error ? err.message : String(err);
			tab = null;
			midiBuffer = null;
		} finally {
			suppressPerFilePersist = false;
		}
	}

	async function onFile(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const buf = await file.arrayBuffer();
		await loadFileFromBuffer(buf, file.name, true);
	}

	async function onVideoFile(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		if (videoUrl) URL.revokeObjectURL(videoUrl);
		videoUrl = URL.createObjectURL(file);
		videoFileName = file.name;
		lastVideoPlayCommand = null;
		try {
			const buf = await file.arrayBuffer();
			await idbSet('lastVideo', { name: file.name, buffer: buf, type: file.type });
		} catch {
			// storage full or blocked — video still works this session
		}
	}

	// Compute the composite layout in a target coordinate system. `outW`/`outH`
	// are the canvas dimensions we're drawing into; the function derives where
	// the video and tab go and whether the canvas needs to be taller than the
	// video (extend modes).
	type CompositeLayout = {
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
		// Pixels to crop from the SOURCE video's top / bottom before placing
		// it in the output. Used by the "crop-top-bottom" mode so the output
		// stays at source aspect while the tab occupies the (cropped) bottom
		// band. Zero for every other mode.
		cropTop: number;
		cropBottom: number;
	};

	function computeCompositeLayout(baseW: number, baseH: number): CompositeLayout {
		const videoAspect = baseH / baseW;
		// Match the UI canvas's aspect exactly so the export looks like the
		// on-screen tab. The renderer's padding constants determine string
		// spacing — see DEFAULT_RENDER_CONFIG in lib/tab/renderer.ts.
		const tabAspect = canvas ? canvas.height / canvas.width : 260 / 1280;
		const tabW = (baseW * tabSizePercent) / 100;
		const tabH = tabW * tabAspect;
		const padPx = (baseH * tabPaddingPercent) / 100;

		if (tabPositionOnVideo === 'extend-below' || tabPositionOnVideo === 'extend-above') {
			const outH = baseH + tabH + padPx * 2;
			const isBelow = tabPositionOnVideo === 'extend-below';
			return {
				outW: baseW,
				outH,
				videoX: 0,
				videoY: isBelow ? 0 : tabH + padPx * 2,
				videoW: baseW,
				videoH: baseH,
				tabX: (baseW - tabW) / 2,
				tabY: isBelow ? baseH + padPx : padPx,
				tabW,
				tabH,
				cropTop: 0,
				cropBottom: 0
			};
		}

		if (tabPositionOnVideo === 'crop-top-bottom') {
			// Output stays at source aspect. To fit the tab, we crop the
			// source both from the top (removing headroom) AND from the
			// bottom (removing the strip the tab will occupy). Split 50/50.
			// No source pixels get scaled — just cropped — so the visible
			// person/guitar is at the same size they'd be in the raw source.
			const totalCrop = tabH + padPx;
			const cropTop = Math.floor(totalCrop / 2);
			const cropBottom = totalCrop - cropTop;
			const videoH = baseH - cropTop - cropBottom;
			return {
				outW: baseW,
				outH: baseH,
				videoX: 0,
				videoY: 0,
				videoW: baseW,
				videoH,
				tabX: (baseW - tabW) / 2,
				tabY: baseH - tabH,
				tabW,
				tabH,
				cropTop,
				cropBottom
			};
		}

		// Overlay modes — same size as source video.
		const isBottomOverlay = tabPositionOnVideo === 'bottom';
		return {
			outW: baseW,
			outH: baseH,
			videoX: 0,
			videoY: 0,
			videoW: baseW,
			videoH: baseH,
			tabX: (baseW - tabW) / 2,
			tabY: isBottomOverlay ? baseH - tabH - padPx : padPx,
			tabW,
			tabH,
			cropTop: 0,
			cropBottom: 0
		};
	}

	function drawCompositeInto(
		cctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
		layout: CompositeLayout,
		bgColor: string,
		tabSource: HTMLCanvasElement | null = null
	): void {
		if (!videoElement) return;
		cctx.fillStyle = bgColor;
		cctx.fillRect(0, 0, layout.outW, layout.outH);
		try {
			// When crop-top-bottom mode is active, we need drawImage's 9-arg
			// form to pull only the middle band of the source. Source coords
			// (sx, sy, sw, sh) are in native video pixels; layout.cropTop/
			// cropBottom are in output coords, but for crop-top-bottom mode
			// the output height equals source height so they line up 1:1
			// with the source's native height (via the source's own aspect).
			if (layout.cropTop > 0 || layout.cropBottom > 0) {
				const vw = videoElement.videoWidth;
				const vh = videoElement.videoHeight;
				// The crop values were expressed in *output* pixel space; here
				// we need them in *source* pixel space. Map by the ratio of
				// the source's native height to the layout's implied full
				// source height (= layout.videoH + cropTop + cropBottom).
				const impliedSrcH = layout.videoH + layout.cropTop + layout.cropBottom;
				const srcScale = impliedSrcH > 0 ? vh / impliedSrcH : 1;
				const sy = layout.cropTop * srcScale;
				const sh = layout.videoH * srcScale;
				cctx.drawImage(
					videoElement,
					0,
					sy,
					vw,
					sh,
					layout.videoX,
					layout.videoY,
					layout.videoW,
					layout.videoH
				);
			} else {
				cctx.drawImage(
					videoElement,
					layout.videoX,
					layout.videoY,
					layout.videoW,
					layout.videoH
				);
			}
		} catch {
			return;
		}
		const src = tabSource ?? canvas;
		if (src) {
			cctx.drawImage(src, layout.tabX, layout.tabY, layout.tabW, layout.tabH);
		}
	}

	// Off-screen tab canvas used during export so we can render the tab at any
	// arbitrary time synchronously, without having to wait for the app's rAF
	// loop to catch up. Sized at a fixed logical resolution (2560×520 gives
	// crisp output regardless of the display DPR).
	let exportTabCanvas: HTMLCanvasElement | null = null;

	// Ensures the offscreen export tab canvas exists at the target width/height
	// requested by the caller. If the size changed since the last call, resize.
	// Callers pass the exact composite tab region size so text is 1:1 (no
	// scaling in drawImage → same font-to-canvas ratio as the live UI).
	function renderExportTabAt(t: number, targetW: number, targetH: number): void {
		if (!tab) return;
		if (!exportTabCanvas) {
			exportTabCanvas = document.createElement('canvas');
		}
		const w = Math.max(1, Math.round(targetW));
		const h = Math.max(1, Math.round(targetH));
		if (exportTabCanvas.width !== w || exportTabCanvas.height !== h) {
			exportTabCanvas.width = w;
			exportTabCanvas.height = h;
		}
		const ectx = exportTabCanvas.getContext('2d');
		if (!ectx) return;
		const cfg = { ...DEFAULT_RENDER_CONFIG };
		cfg.width = w;
		cfg.height = h;
		cfg.mode = renderMode;
		cfg.playheadStyle = playheadStyle;
		cfg.theme = theme;
		cfg.stringFlashEnabled = stringFlashEnabled;
		cfg.pixelsPerSecond = pixelsPerSecond;
		cfg.barsPerPage = barsPerPage;
		cfg.peekBeats = peekBeats;
		cfg.showNoteLengths = showNoteLengths;
		// Match the UI's paddings (already in DEFAULT_RENDER_CONFIG) so the
		// exported tab looks identical to what the user sees on screen.
		ectx.setTransform(1, 0, 0, 1, 0, 0);
		renderTabFrame(ectx, tab, TUNINGS[tuningKey], t, cfg);
	}

	function drawComposite(): void {
		if (!compositeCanvas || !videoElement) return;
		const cctx = compositeCanvas.getContext('2d');
		if (!cctx) return;

		// Base dimensions come from the source video, but the DISPLAY canvas is
		// sized to its CSS box × devicePixelRatio for a crisp preview. The
		// layout scales up/down to match.
		const srcW = videoElement.videoWidth || 1920;
		const srcH = videoElement.videoHeight || 1080;
		const layout = computeCompositeLayout(srcW, srcH);
		const cssW = compositeCanvas.clientWidth;
		if (cssW <= 0) return;
		const dpr = window.devicePixelRatio || 1;
		const scale = cssW / layout.outW;
		const cssH = Math.round(layout.outH * scale);
		const dW = Math.round(cssW * dpr);
		const dH = Math.round(cssH * dpr);
		if (compositeCanvas.width !== dW || compositeCanvas.height !== dH) {
			compositeCanvas.width = dW;
			compositeCanvas.height = dH;
			compositeCanvas.style.height = cssH + 'px';
		}

		const displayLayout = computeCompositeLayout(dW, dH);
		// Recompute with actual device pixels for the display target.
		void displayLayout;

		// Scale the layout to device pixels and draw.
		const displayScale = dW / layout.outW;
		const scaled: CompositeLayout = {
			outW: dW,
			outH: dH,
			videoX: layout.videoX * displayScale,
			videoY: layout.videoY * displayScale,
			videoW: layout.videoW * displayScale,
			videoH: layout.videoH * displayScale,
			tabX: layout.tabX * displayScale,
			tabY: layout.tabY * displayScale,
			tabW: layout.tabW * displayScale,
			tabH: layout.tabH * displayScale,
			cropTop: layout.cropTop * displayScale,
			cropBottom: layout.cropBottom * displayScale
		};
		drawCompositeInto(cctx, scaled, '#000');
	}

	let exportCancelled = false;

	// Seek and wait for the `seeked` event, with a timeout so a browser that
	// never fires it doesn't block the whole export. If the video is already
	// at the target time we skip the wait entirely.
	async function seekVideoTo(el: HTMLVideoElement, t: number): Promise<void> {
		if (Math.abs(el.currentTime - t) < 1e-3) return;
		await new Promise<void>((resolve) => {
			const onSeeked = () => {
				el.removeEventListener('seeked', onSeeked);
				resolve();
			};
			el.addEventListener('seeked', onSeeked);
			const timeout = setTimeout(() => {
				el.removeEventListener('seeked', onSeeked);
				resolve();
			}, 2000);
			void timeout;
			el.currentTime = t;
		});
	}

	// Puppeteer-driven server export. The client just packages tab data +
	// source video + render config and POSTs to /api/export. The server
	// launches puppeteer, which loads /render/<jobId> in its own foreground
	// tab (unthrottled), captures frames via rVFC, and pipes them into ffmpeg
	// with NVENC. This lets the user's tab be backgrounded during export.
	async function startExport() {
		if (!tab || !videoElement || !videoUrl || !compositeCanvas) return;
		if (exportResultUrl) {
			URL.revokeObjectURL(exportResultUrl);
			exportResultUrl = null;
			exportResultName = null;
			exportResultSize = 0;
		}
		exportError = null;
		isExporting = true;
		exportProgress = 0;
		exportCancelled = false;
		exportStage = 'encoding';
		exportFramesEncoded = 0;

		const el = videoElement;
		const srcW = el.videoWidth || 1920;
		const srcH = el.videoHeight || 1080;
		const layout = computeCompositeLayout(srcW, srcH);
		// NVENC prefers multiples of 16. Round up and center-letterbox.
		const align = 16;
		const width = Math.ceil(layout.outW / align) * align;
		const height = Math.ceil(layout.outH / align) * align;
		const offsetX = Math.floor((width - layout.outW) / 2);
		const offsetY = Math.floor((height - layout.outH) / 2);
		const scaledLayout: CompositeLayout = {
			outW: width,
			outH: height,
			videoX: layout.videoX + offsetX,
			videoY: layout.videoY + offsetY,
			videoW: layout.videoW,
			videoH: layout.videoH,
			tabX: layout.tabX + offsetX,
			tabY: layout.tabY + offsetY,
			tabW: layout.tabW,
			tabH: layout.tabH,
			cropTop: layout.cropTop,
			cropBottom: layout.cropBottom
		};

		// Grab the source video bytes so we can send it with the config.
		let videoBlob: Blob | null = null;
		try {
			videoBlob = await (await fetch(videoUrl)).blob();
		} catch (err) {
			exportError = 'Could not read source video: ' + (err instanceof Error ? err.message : String(err));
			isExporting = false;
			return;
		}

		const configPayload = {
			width,
			height,
			offsetX,
			offsetY,
			compositeLayout: scaledLayout,
			videoOffsetSec,
			encoder: exportEncoder,
			bitrate: 8_000_000,
			tab,
			tuningKey,
			renderMode,
			playheadStyle,
			theme,
			stringFlashEnabled,
			pixelsPerSecond,
			barsPerPage,
			peekBeats,
			showNoteLengths,
			videoMime: videoBlob.type || 'video/mp4'
		};

		const form = new FormData();
		form.append('config', JSON.stringify(configPayload));
		form.append(
			'video',
			videoBlob,
			videoFileName || 'source' + (videoBlob.type.includes('webm') ? '.webm' : '.mp4')
		);

		exportStage = 'finalizing';
		console.log('[export] uploading job to server', {
			width,
			height,
			encoder: exportEncoder,
			videoBytes: videoBlob.size
		});
		let response: Response;
		try {
			response = await fetch('/api/export', { method: 'POST', body: form });
		} catch (err) {
			exportError = 'Server request failed: ' + (err instanceof Error ? err.message : String(err));
			isExporting = false;
			return;
		}
		console.log('[export] response status', response.status);
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			console.error('[export] server error body:', text);
			exportError = `Server error ${response.status}: ${text}`;
			isExporting = false;
			return;
		}

		if (!exportCancelled && !exportError) {
			const blob = await response.blob();
			console.log('[export] response blob', { size: blob.size, type: blob.type });
			if (blob.size === 0) {
				exportError = 'server returned empty body';
				isExporting = false;
				return;
			}
			if (exportResultUrl) URL.revokeObjectURL(exportResultUrl);
			exportResultUrl = URL.createObjectURL(blob);
			exportResultName = ((fileName ?? 'tabutabu').replace(/\.[^.]+$/, '')) + '-tab.mp4';
			exportResultSize = blob.size;
			exportStage = 'done';
			console.log('[export] preview ready', exportResultName);
		}

		isExporting = false;
		exportProgress = 0;
		setTimeout(() => {
			if (!isExporting) exportStage = 'idle';
		}, 2000);
	}

	function cancelExport() {
		exportCancelled = true;
	}

	function clearVideo() {
		if (videoUrl) URL.revokeObjectURL(videoUrl);
		videoUrl = null;
		videoFileName = null;
		lastVideoPlayCommand = null;
		void idbDel('lastVideo');
	}

	// Called every rAF. Handles two things:
	//   - Drift correction: if the video's currentTime has drifted from the
	//     desired target (tab time + offset), snap it back. Skipped while an
	//     offset-driven seek is already pending so we don't race.
	//   - Play/pause: mirror the tab's playing state.
	// Offset-change-driven seeks are handled by a separate $effect below, so
	// they only fire when the offset actually changes (rather than being
	// rescheduled every frame, which is what stopped them from ever firing).
	function syncVideo(): void {
		if (!videoElement || !videoUrl) return;
		// During export we drive the video directly (play() + rVFC). Any drift
		// correction here would yank currentTime back to the tab's playhead
		// and reset the export playback to 0.
		if (isExporting) return;

		if (!offsetSeekTimer) {
			const target = Math.max(0, currentTime + videoOffsetSec);
			// 300ms tolerance rather than 100. Small clock drift between audio and
			// video decoders is normal; an in-play seek to correct it causes
			// visible stutter. Only correct when they meaningfully diverge.
			if (Math.abs(videoElement.currentTime - target) > 0.3) {
				videoElement.currentTime = target;
			}
		}

		if (playing && audioOn) {
			if (lastVideoPlayCommand !== 'play') {
				videoElement.play().catch(() => {});
				lastVideoPlayCommand = 'play';
			}
		} else {
			if (lastVideoPlayCommand !== 'pause') {
				videoElement.pause();
				lastVideoPlayCommand = 'pause';
			}
		}
	}

	// Debounce offset-change-driven seeks. Fires once on load (offset transitions
	// from default 0 to the persisted value) and on every subsequent change.
	// While tuning during playback, we auto-pause and wait for `seeked` to fire
	// before resuming — otherwise audio drifts ahead of the still-decoding video.
	$effect(() => {
		void videoOffsetSec;
		void videoUrl;
		if (!videoUrl) return;

		// Everything below reads reactive state we don't want to track — only the
		// two deps above should trigger this effect. Otherwise every spacebar
		// toggle would cause an unrelated seek storm.
		untrack(() => {
			if (playing && !pausedForOffsetSeek) {
				pausedForOffsetSeek = true;
				playing = false;
				synth.stop();
			}
		});

		if (offsetSeekTimer) clearTimeout(offsetSeekTimer);
		offsetSeekTimer = setTimeout(() => {
			offsetSeekTimer = null;
			const el = videoElement;
			if (!el) {
				resumeAfterOffsetSeek();
				return;
			}
			const target = untrack(() => Math.max(0, currentTime + videoOffsetSec));
			if (Math.abs(el.currentTime - target) < 0.001) {
				resumeAfterOffsetSeek();
				return;
			}
			// Fallback in case `seeked` never fires (rare browser edge case). If
			// the seek is genuinely long, this bails out early — playback resumes
			// even if the video is still mid-decode, and drift correction picks
			// up whatever's left.
			const fallback = setTimeout(() => {
				el.removeEventListener('seeked', onSeeked);
				resumeAfterOffsetSeek();
			}, 800);
			const onSeeked = () => {
				clearTimeout(fallback);
				el.removeEventListener('seeked', onSeeked);
				resumeAfterOffsetSeek();
			};
			el.addEventListener('seeked', onSeeked, { once: true });
			el.currentTime = target;
		}, 150);
	});

	function resumeAfterOffsetSeek(): void {
		if (!pausedForOffsetSeek) return;
		pausedForOffsetSeek = false;
		if (tab) {
			playing = true;
			if (audioOn) synth.play(tab, currentTime);
		}
	}

	function nudgeOffset(deltaSec: number) {
		videoOffsetSec = Math.round((videoOffsetSec + deltaSec) * 1000) / 1000;
	}

	// Track the loaded video's duration so we can extend the tab's effective
	// end to whichever is longer. The tab keeps its notes; the timeline and
	// auto-pause use `effectiveDurationSec` instead of `tab.durationSec`.
	$effect(() => {
		const el = videoElement;
		if (!el) {
			videoDuration = null;
			return;
		}
		const capture = () => {
			if (el.duration && isFinite(el.duration)) videoDuration = el.duration;
		};
		// Prime the video decoder on first metadata load: seek to the target
		// position (tab time + video offset) so drawImage doesn't draw a
		// stale/black frame during the first playback. Without this the very
		// first Play after page load produced a bad preview and had to be
		// worked around by pressing Reset before Play.
		const prime = () => {
			if (playing) return;
			const target = Math.max(0, currentTime + videoOffsetSec);
			if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
		};
		el.addEventListener('loadedmetadata', capture);
		el.addEventListener('loadedmetadata', prime);
		el.addEventListener('durationchange', capture);
		capture();
		return () => {
			el.removeEventListener('loadedmetadata', capture);
			el.removeEventListener('loadedmetadata', prime);
			el.removeEventListener('durationchange', capture);
		};
	});

	const effectiveDurationSec = $derived.by(() => {
		if (!tab) return 0;
		let end = tab.durationSec;
		if (videoDuration !== null) end = Math.max(end, videoDuration - videoOffsetSec);
		return end;
	});

	// Re-run parsing whenever tuning, channel-string mode, or the leading-silence
	// toggle changes.
	$effect(() => {
		const t = TUNINGS[tuningKey];
		const opts = { honorChannelStrings, keepLeadingSilence, overrides, annotations };
		if (!midiBuffer) return;
		const run = async () => {
			try {
				tab = isDawprojectFile
					? await parseDawproject(midiBuffer!, t, opts)
					: parseMidi(midiBuffer!, t, opts);
			} catch (err) {
				parseError = err instanceof Error ? err.message : String(err);
			}
		};
		run();
	});

	function togglePlay() {
		if (!tab) return;
		playing = !playing;
		if (playing) {
			// Prime the video: explicit position + play in the same tick as audio.
			// If we let syncVideo do this on the next rAF, the video is ~16ms behind
			// and any drift correction fires an instant seek right as audio starts,
			// which looks like stutter.
			if (videoElement && videoUrl) {
				const target = Math.max(0, currentTime + videoOffsetSec);
				if (Math.abs(videoElement.currentTime - target) > 0.05) {
					videoElement.currentTime = target;
				}
				videoElement.play().catch(() => {});
			}
			if (audioOn) synth.play(tab, currentTime);
			lastVideoPlayCommand = 'play';
		} else {
			synth.stop();
			if (videoElement) videoElement.pause();
			lastVideoPlayCommand = 'pause';
		}
	}

	function reset() {
		currentTime = 0;
		playing = false;
		synth.stop();
	}

	// Any change to currentTime while playing (scrubbing) reseeds the audio from
	// the new position. Tracker is a plain variable, not $state.
	let lastSeekTime = 0;
	$effect(() => {
		if (!playing || !tab) {
			lastSeekTime = currentTime;
			return;
		}
		// Only reseed if the user actually moved the slider (not just rAF ticks).
		if (Math.abs(currentTime - lastSeekTime) > 0.15) {
			if (audioOn) synth.play(tab, currentTime);
			else synth.stop();
			lastSeekTime = currentTime;
		}
	});

	function seekBy(deltaSec: number) {
		if (!tab) return;
		const next = Math.max(0, Math.min(effectiveDurationSec, currentTime + deltaSec));
		currentTime = next;
		lastSeekTime = next;
		if (playing && audioOn) synth.play(tab, next);
	}

	// Convert a pointer event's page coords to (time, stringIndex) using the
	// same layout math the renderer uses. Handles both page and scroll modes.
	function pointerToTabPos(ev: PointerEvent): { time: number; stringIndex: number } | null {
		if (!tab) return null;
		const rect = canvas.getBoundingClientRect();
		// Renderer works in CSS-pixel logical coords; use rect.width/height (CSS
		// pixels), not canvas.width/height which are now device pixels.
		const cx = ev.clientX - rect.left;
		const cy = ev.clientY - rect.top;
		const cfg = DEFAULT_RENDER_CONFIG;
		const cssW = rect.width;
		const cssH = rect.height;
		const usableHeight = cssH - cfg.paddingTop - cfg.paddingBottom;
		const stringGap = usableHeight / (STRING_COUNT - 1);
		const stringIndex = Math.max(
			0,
			Math.min(STRING_COUNT - 1, Math.round((cy - cfg.paddingTop) / stringGap))
		);
		let time: number;
		if (renderMode === 'page') {
			const pageDur = tab.secondsPerBar * barsPerPage;
			const secondsPerBeat = tab.secondsPerBar / tab.timeSignature[0];
			const peekDur = peekBeats * secondsPerBeat;
			const totalDur = pageDur + peekDur;
			const usableWidth = cssW - cfg.paddingX * 2;
			const pxPerSec = usableWidth / totalDur;
			const pageIndex = Math.floor(currentTime / pageDur);
			const pageStart = pageIndex * pageDur;
			time = pageStart + (cx - cfg.paddingX) / pxPerSec;
		} else {
			const usableWidth = cssW - cfg.paddingX * 2;
			const totalDur = barsPerPage * tab.secondsPerBar +
				peekBeats * (tab.secondsPerBar / tab.timeSignature[0]);
			const pxPerSec = totalDur > 0 ? usableWidth / totalDur : pixelsPerSecond;
			const playheadX = cssW * cfg.playheadFraction;
			time = currentTime + (cx - playheadX) / pxPerSec;
		}
		return { time, stringIndex };
	}

	function findNearestNote(pos: { time: number; stringIndex: number }): Tab['notes'][0] | null {
		if (!tab) return null;
		// Match on same string within a small time window; pick the closest.
		const TIME_TOL = 0.15;
		let closest: Tab['notes'][0] | null = null;
		let bestDt = Infinity;
		for (const n of tab.notes) {
			if (n.stringIndex !== pos.stringIndex) continue;
			const dt = Math.abs(n.time - pos.time);
			if (dt > TIME_TOL) continue;
			if (dt < bestDt) {
				bestDt = dt;
				closest = n;
			}
		}
		return closest;
	}

	// Return the two notes on the same string flanking `clickTime` — the last
	// note at or before, and the first note strictly after. Both must exist for
	// a hammer/pull annotation to make sense (there needs to be a source note).
	function findFlankingNotes(pos: { time: number; stringIndex: number }): {
		prev: Tab['notes'][0];
		next: Tab['notes'][0];
	} | null {
		if (!tab) return null;
		let prev: Tab['notes'][0] | null = null;
		let next: Tab['notes'][0] | null = null;
		for (const n of tab.notes) {
			if (n.stringIndex !== pos.stringIndex) continue;
			if (n.time <= pos.time) prev = n;
			else {
				next = n;
				break;
			}
		}
		return prev && next ? { prev, next } : null;
	}

	let dragging: { note: Tab['notes'][0] } | null = null;

	function toggleAnnotation(
		key: string,
		desired: 'hammer' | 'pull' | 'tap' | 'off'
	): void {
		const current = annotations[key];
		if (current === desired) {
			const { [key]: _, ...rest } = annotations;
			annotations = rest;
		} else {
			annotations = { ...annotations, [key]: desired };
		}
	}

	function onCanvasPointerDown(ev: PointerEvent) {
		if (!tab) return;
		const pos = pointerToTabPos(ev);
		if (!pos) return;

		// Shift+click BETWEEN two notes on the same string → hammer or pull-off
		// (auto direction: fret up = hammer, fret down = pull, equal = hammer).
		if (ev.shiftKey) {
			const flanking = findFlankingNotes(pos);
			if (!flanking) {
				ev.preventDefault();
				return;
			}
			const { prev, next } = flanking;
			const desired: 'hammer' | 'pull' = next.fret < prev.fret ? 'pull' : 'hammer';
			toggleAnnotation(overrideKey(next.time, next.midi, next.channel), desired);
			ev.preventDefault();
			return;
		}

		// Alt+click on a note → toggle tap.
		if (ev.altKey) {
			const hit = findNearestNote(pos);
			if (!hit) {
				ev.preventDefault();
				return;
			}
			toggleAnnotation(overrideKey(hit.time, hit.midi, hit.channel), 'tap');
			ev.preventDefault();
			return;
		}

		const hit = findNearestNote(pos);
		if (!hit) return;
		dragging = { note: hit };
		canvas.setPointerCapture(ev.pointerId);
	}

	function onCanvasPointerMove(ev: PointerEvent) {
		if (!dragging) return;
		// Preview would go here — for now we just wait for release.
		void ev;
	}

	function onCanvasPointerUp(ev: PointerEvent) {
		if (!dragging) return;
		try {
			canvas.releasePointerCapture(ev.pointerId);
		} catch {
			// no-op
		}
		const pos = pointerToTabPos(ev);
		const note = dragging.note;
		dragging = null;
		if (!pos || !tab) return;
		if (pos.stringIndex === note.stringIndex) {
			// Click without a real drag — log info to help with debugging.
			const secondsPerBeat = tab.secondsPerBar / tab.timeSignature[0];
			const bar = Math.floor(note.time / tab.secondsPerBar) + 1;
			const beat = Math.floor((note.time % tab.secondsPerBar) / secondsPerBeat) + 1;
			console.log(`bar ${bar} beat ${beat}`, {
				time: note.time.toFixed(3),
				midi: note.midi,
				fret: note.fret,
				string: note.stringIndex,
				channel: note.channel,
				velocity: note.velocity.toFixed(2),
				articulations: note.articulations.map((a) => a.kind).join(', ') || '—',
				override: overrides[overrideKey(note.time, note.midi, note.channel)] ?? '—'
			});
			return;
		}

		const tuning = TUNINGS[tuningKey];
		const newFret = note.midi - tuning.openNotes[pos.stringIndex];
		if (newFret < 0 || newFret > MAX_FRET) return; // unreachable on that string

		overrides = {
			...overrides,
			[overrideKey(note.time, note.midi, note.channel)]: pos.stringIndex
		};
	}

	function clearOverrides() {
		overrides = {};
	}

	function seekAbs(t: number) {
		if (!tab) return;
		const next = Math.max(0, Math.min(effectiveDurationSec, t));
		currentTime = next;
		lastSeekTime = next;
		if (playing && audioOn) synth.play(tab, next);
	}

	function timelineTimeFromEvent(e: PointerEvent, snap: boolean): number | null {
		if (!tab) return null;
		const rect = timelineCanvas.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const frac = Math.max(0, Math.min(1, x / rect.width));
		let t = frac * effectiveDurationSec;
		if (snap) {
			const secondsPerBeat = tab.secondsPerBar / tab.timeSignature[0];
			const beat = Math.round(t / secondsPerBeat);
			t = beat * secondsPerBeat;
			t = Math.max(0, Math.min(effectiveDurationSec, t));
		}
		return t;
	}

	function onTimelinePointerDown(e: PointerEvent) {
		if (!tab) return;
		timelineCanvas.setPointerCapture(e.pointerId);
		timelineDragging = true;
		const t = timelineTimeFromEvent(e, !e.shiftKey);
		if (t !== null) seekAbs(t);
	}
	function onTimelinePointerMove(e: PointerEvent) {
		if (!timelineDragging) return;
		const t = timelineTimeFromEvent(e, !e.shiftKey);
		if (t !== null) seekAbs(t);
	}
	function onTimelinePointerUp(e: PointerEvent) {
		timelineDragging = false;
		try {
			timelineCanvas.releasePointerCapture(e.pointerId);
		} catch {
			// no-op
		}
	}

	function drawTimeline(): void {
		if (!timelineCanvas) return;
		const tctx = timelineCanvas.getContext('2d');
		if (!tctx) return;
		// HiDPI-aware resize + transform so lines/text stay sharp when the CSS
		// container scales the canvas.
		const dpr = window.devicePixelRatio || 1;
		const cssW = timelineCanvas.clientWidth || timelineCanvas.width / dpr;
		const cssH = timelineCanvas.clientHeight || timelineCanvas.height / dpr;
		const targetW = Math.round(cssW * dpr);
		const targetH = Math.round(cssH * dpr);
		if (timelineCanvas.width !== targetW || timelineCanvas.height !== targetH) {
			timelineCanvas.width = targetW;
			timelineCanvas.height = targetH;
		}
		tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		const w = cssW;
		const h = cssH;
		tctx.fillStyle = '#0b0f14';
		tctx.fillRect(0, 0, w, h);
		if (!tab || effectiveDurationSec <= 0) return;
		const tabRef = tab;
		const durForDraw = effectiveDurationSec;
		const totalBars = Math.max(1, Math.ceil(durForDraw / tabRef.secondsPerBar));
		const xForTime = (t: number) => (t / durForDraw) * w;

		// Filled progress up to currentTime
		tctx.fillStyle = '#1c2734';
		tctx.fillRect(0, 0, xForTime(currentTime), h);

		// Beat lines (thin, subtle)
		const beatsPerBar = tabRef.timeSignature[0];
		const secondsPerBeat = tabRef.secondsPerBar / beatsPerBar;
		tctx.strokeStyle = '#232c36';
		tctx.lineWidth = 1;
		const totalBeats = Math.ceil(durForDraw / secondsPerBeat);
		for (let b = 0; b <= totalBeats; b++) {
			const x = Math.round(xForTime(b * secondsPerBeat)) + 0.5;
			tctx.beginPath();
			tctx.moveTo(x, h * 0.55);
			tctx.lineTo(x, h);
			tctx.stroke();
		}

		// Bar lines (bolder) + bar numbers
		tctx.strokeStyle = '#3a4553';
		tctx.lineWidth = 1.25;
		tctx.fillStyle = '#8a99ad';
		tctx.font = '600 11px ui-monospace, Menlo, Consolas, monospace';
		tctx.textAlign = 'left';
		tctx.textBaseline = 'top';
		// Skip drawing every label if bars would collide; require ~28px between labels
		const minLabelPx = 28;
		const barPx = w / totalBars;
		const labelEvery = Math.max(1, Math.ceil(minLabelPx / barPx));
		for (let b = 0; b <= totalBars; b++) {
			const x = Math.round(xForTime(b * tabRef.secondsPerBar)) + 0.5;
			tctx.beginPath();
			tctx.moveTo(x, 0);
			tctx.lineTo(x, h);
			tctx.stroke();
			if (b < totalBars && b % labelEvery === 0) {
				tctx.fillText(String(b + 1), x + 3, 3);
			}
		}

		// Playhead handle
		const px = xForTime(currentTime);
		const handleW = 10;
		tctx.fillStyle = '#ffcc55';
		tctx.fillRect(Math.round(px - handleW / 2), 0, handleW, h);
		tctx.strokeStyle = '#ff5577';
		tctx.lineWidth = 2;
		tctx.beginPath();
		tctx.moveTo(Math.round(px) + 0.5, 0);
		tctx.lineTo(Math.round(px) + 0.5, h);
		tctx.stroke();
	}

	// Restore persisted settings + last-opened file + last-used sync port on
	// mount. All best-effort — failures are silent.
	onMount(async () => {
		try {
			const b = (k: string, def: boolean) => {
				const v = localStorage.getItem(k);
				return v === null ? def : v === '1';
			};
			const n = (k: string, def: number) => {
				const v = localStorage.getItem(k);
				const p = v === null ? NaN : Number(v);
				return Number.isFinite(p) ? p : def;
			};
			metronomeOn = b('tabutabu.metronomeOn', metronomeOn);
			metronomeVol = n('tabutabu.metronomeVol', metronomeVol);
			syncOffsetMs = n('tabutabu.syncOffsetMs', syncOffsetMs);
			keepLeadingSilence = b('tabutabu.keepLeadingSilence', keepLeadingSilence);
			preservePositionOnStart = b('tabutabu.preservePositionOnStart', preservePositionOnStart);
			syncDebug = b('tabutabu.syncDebug', syncDebug);
			videoOffsetSec = n('tabutabu.videoOffsetSec', videoOffsetSec);
			videoAudioOn = b('tabutabu.videoAudioOn', videoAudioOn);
			const tpos = localStorage.getItem('tabutabu.tabPositionOnVideo');
			if (
				tpos === 'bottom' ||
				tpos === 'top' ||
				tpos === 'extend-below' ||
				tpos === 'extend-above' ||
				tpos === 'crop-top-bottom'
			)
				tabPositionOnVideo = tpos;
			tabSizePercent = n('tabutabu.tabSizePercent', tabSizePercent);
			tabPaddingPercent = n('tabutabu.tabPaddingPercent', tabPaddingPercent);
			exportFps = n('tabutabu.exportFps', exportFps);
			const savedEncoder = localStorage.getItem('tabutabu.exportEncoder');
			if (
				savedEncoder === 'h264_nvenc' ||
				savedEncoder === 'hevc_nvenc' ||
				savedEncoder === 'av1_nvenc' ||
				savedEncoder === 'libx264' ||
				savedEncoder === 'libx265'
			) {
				exportEncoder = savedEncoder;
			}
			const ps = localStorage.getItem('tabutabu.playheadStyle');
			if (ps === 'line' || ps === 'beat' || ps === 'bar') playheadStyle = ps;
			const th = localStorage.getItem('tabutabu.theme');
			if (th === 'dark' || th === 'light') theme = th;
			stringFlashEnabled = b('tabutabu.stringFlashEnabled', stringFlashEnabled);
			const tk = localStorage.getItem('tabutabu.tuningKey');
			if (tk && tk in TUNINGS) tuningKey = tk as keyof typeof TUNINGS;
		} catch {
			// ignore
		}

		try {
			const saved = (await idbGet('lastFile')) as
				| { name: string; buffer: ArrayBuffer; isDawproject: boolean }
				| undefined;
			if (saved?.buffer) {
				await loadFileFromBuffer(saved.buffer, saved.name, false);
			}
		} catch {
			// ignore
		}

		try {
			const savedVideo = (await idbGet('lastVideo')) as
				| { name: string; buffer: ArrayBuffer; type: string }
				| undefined;
			if (savedVideo?.buffer) {
				const blob = new Blob([savedVideo.buffer], { type: savedVideo.type });
				videoUrl = URL.createObjectURL(blob);
				videoFileName = savedVideo.name;
			}
		} catch {
			// ignore
		}

		try {
			const savedPort = localStorage.getItem('tabutabu.syncPort');
			if (savedPort) {
				syncSelectedPort = savedPort;
				await refreshSyncPorts();
				const still = syncPorts.some((p) => p.id === savedPort);
				if (still) {
					syncSelectedPort = savedPort;
					await syncConnect();
				}
			}
		} catch {
			// ignore
		}

		// Ask the dev server which ffmpeg encoders it has. If the saved encoder
		// isn't available, fall back to the first one that is (preferring
		// hardware NVENC over software x264/x265).
		try {
			const res = await fetch('/api/export');
			if (res.ok) {
				const data = (await res.json()) as { ok: boolean; encoders: string[] };
				availableEncoders = data.encoders ?? [];
				if (!availableEncoders.includes(exportEncoder)) {
					const preferred = [
						'h264_nvenc',
						'hevc_nvenc',
						'av1_nvenc',
						'libx264',
						'libx265'
					] as const;
					const pick = preferred.find((e) => availableEncoders.includes(e));
					if (pick) exportEncoder = pick;
				}
			}
		} catch {
			// ffmpeg not on PATH — leave encoder as saved and let the request fail with a clear error.
		}
	});

	// Persist settings on change. Each effect writes one key, so a single
	// toggle only touches its own storage entry.
	const put = (k: string, v: string) => {
		try {
			localStorage.setItem(k, v);
		} catch {
			// storage full or blocked
		}
	};
	$effect(() => put('tabutabu.metronomeOn', metronomeOn ? '1' : '0'));
	$effect(() => put('tabutabu.metronomeVol', String(metronomeVol)));
	$effect(() => put('tabutabu.syncOffsetMs', String(syncOffsetMs)));
	$effect(() => put('tabutabu.keepLeadingSilence', keepLeadingSilence ? '1' : '0'));
	$effect(() => put('tabutabu.preservePositionOnStart', preservePositionOnStart ? '1' : '0'));
	$effect(() => put('tabutabu.syncDebug', syncDebug ? '1' : '0'));
	$effect(() => put('tabutabu.videoOffsetSec', String(videoOffsetSec)));
	$effect(() => put('tabutabu.videoAudioOn', videoAudioOn ? '1' : '0'));
	$effect(() => put('tabutabu.tabPositionOnVideo', tabPositionOnVideo));
	$effect(() => put('tabutabu.tabSizePercent', String(tabSizePercent)));
	$effect(() => put('tabutabu.tabPaddingPercent', String(tabPaddingPercent)));
	$effect(() => put('tabutabu.exportFps', String(exportFps)));
	$effect(() => put('tabutabu.exportEncoder', exportEncoder));
	$effect(() => put('tabutabu.playheadStyle', playheadStyle));
	$effect(() => put('tabutabu.theme', theme));
	$effect(() => put('tabutabu.stringFlashEnabled', stringFlashEnabled ? '1' : '0'));
	$effect(() => put('tabutabu.tuningKey', tuningKey));
	// Persist per-file string overrides and hammer/pull annotations. Skipped
	// when there's no file loaded, and while a file is actively being loaded
	// (so we don't overwrite the saved data with the transient empty state).
	$effect(() => {
		void overrides;
		if (!fileName || suppressPerFilePersist) return;
		const snap = { ...overrides };
		void idbSet(`overrides:${fileName}`, snap).catch(() => {});
	});
	$effect(() => {
		void annotations;
		if (!fileName || suppressPerFilePersist) return;
		const snap = { ...annotations };
		void idbSet(`annotations:${fileName}`, snap).catch(() => {});
	});

	function clearSavedFile() {
		void idbDel('lastFile');
	}

	// Global keyboard shortcuts. Registered on `keydown` with capture so a focused
	// range slider or button can't swallow space/arrows before we handle them —
	// which is what would otherwise trigger the control instead of play/pause.
	onMount(() => {
		const onKey = (e: KeyboardEvent) => {
			// Never intercept when the user is typing into an actual text field.
			const el = e.target as HTMLElement | null;
			const tag = el?.tagName;
			const type = (el as HTMLInputElement | null)?.type;
			const isTextField =
				(tag === 'INPUT' && type && !['range', 'checkbox', 'radio', 'file', 'button'].includes(type)) ||
				tag === 'TEXTAREA' ||
				el?.isContentEditable;
			if (isTextField) return;
			if (e.metaKey || e.ctrlKey || e.altKey) return;

			if (e.code === 'Space') {
				e.preventDefault();
				togglePlay();
			} else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
				if (!tab) return;
				e.preventDefault();
				const beatSec = tab.secondsPerBar / tab.timeSignature[0];
				const step = e.shiftKey ? beatSec * tab.timeSignature[0] : beatSec;
				seekBy(e.code === 'ArrowRight' ? step : -step);
			}
		};
		window.addEventListener('keydown', onKey, { capture: true });
		return () => window.removeEventListener('keydown', onKey, { capture: true });
	});

	// rAF loop drives both `currentTime` advancement and canvas repaints.
	onMount(() => {
		let last = performance.now();
		let raf = 0;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		const config = { ...DEFAULT_RENDER_CONFIG };

		// Resize a canvas so its internal pixel buffer matches the display size
		// times the device pixel ratio. Prevents the "blurry when moving" look
		// caused by CSS scaling the canvas from a fixed 1280×260 buffer to the
		// container width. Returns the CSS width/height in logical pixels for
		// the caller to use as render config dimensions.
		function fitCanvasToDisplay(c: HTMLCanvasElement): { w: number; h: number; dpr: number } {
			const dpr = window.devicePixelRatio || 1;
			const cssW = c.clientWidth || c.width / dpr;
			const cssH = c.clientHeight || c.height / dpr;
			const targetW = Math.round(cssW * dpr);
			const targetH = Math.round(cssH * dpr);
			if (c.width !== targetW || c.height !== targetH) {
				c.width = targetW;
				c.height = targetH;
			}
			return { w: cssW, h: cssH, dpr };
		}

		const loop = (now: number) => {
			const dt = (now - last) / 1000;
			last = now;
			if (playing && tab) {
				const songT = audioOn ? synth.currentSongTime() : null;
				if (songT !== null) {
					currentTime = songT;
					lastSeekTime = songT;
				} else {
					currentTime += dt;
				}
				if (currentTime >= effectiveDurationSec) {
					currentTime = effectiveDurationSec;
					playing = false;
					synth.stop();
				}
			}
			const { w: cssW, h: cssH, dpr } = fitCanvasToDisplay(canvas);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			config.width = cssW;
			config.height = cssH;
			config.mode = renderMode;
			config.playheadStyle = playheadStyle;
			config.theme = theme;
			config.stringFlashEnabled = stringFlashEnabled;
			config.pixelsPerSecond = pixelsPerSecond;
			config.barsPerPage = barsPerPage;
			config.peekBeats = peekBeats;
			config.showNoteLengths = showNoteLengths;
			if (tab) {
				renderTabFrame(ctx, tab, TUNINGS[tuningKey], currentTime, config);
			} else {
				ctx.fillStyle = '#0b0f14';
				ctx.fillRect(0, 0, cssW, cssH);
			}
			drawTimeline();
			syncVideo();
			drawComposite();
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	});
</script>

<div class="app">
	<header>
		<h1>Tabutabu</h1>
		<p class="sub">MIDI → guitar tab video</p>
	</header>

	<section class="controls">
		<label class="file">
			<span>MIDI / dawproject</span>
			<input type="file" accept=".mid,.midi,.dawproject,audio/midi" onchange={onFile} />
		</label>

		{#if fileName}
			<button
				class="link"
				title="Clear the auto-loaded file from browser storage"
				onclick={() => {
					clearSavedFile();
					fileName = null;
					tab = null;
					midiBuffer = null;
				}}>forget saved</button
			>
			{#if Object.keys(overrides).length > 0}
				<button
					class="link"
					title="Remove all drag-reassigned string overrides for this file"
					onclick={clearOverrides}>clear {Object.keys(overrides).length} overrides</button
				>
			{/if}
		{/if}

		<label class="file">
			<span>Video</span>
			<input type="file" accept="video/*" onchange={onVideoFile} />
		</label>
		{#if videoFileName}
			<button class="link" onclick={clearVideo}>clear video</button>
		{/if}
		{#if videoUrl}
			<label title="Video time when tab time = 0. Increase if the video is ahead of the tab; decrease if it's behind.">
				<span>Video offset (s)</span>
				<input type="number" step="0.01" bind:value={videoOffsetSec} style="width:80px" />
			</label>
			<span class="nudge-group" title="Nudge the offset by fixed amounts. Left mouse for negative, right amounts for positive.">
				<button class="nudge" onclick={() => nudgeOffset(-1)}>−1s</button>
				<button class="nudge" onclick={() => nudgeOffset(-0.1)}>−100ms</button>
				<button class="nudge" onclick={() => nudgeOffset(-0.01)}>−10ms</button>
				<button class="nudge" onclick={() => nudgeOffset(0.01)}>+10ms</button>
				<button class="nudge" onclick={() => nudgeOffset(0.1)}>+100ms</button>
				<button class="nudge" onclick={() => nudgeOffset(1)}>+1s</button>
			</span>
			<label title="Play the video's own audio. Off by default so it doesn't stack on top of the synth preview.">
				<input type="checkbox" bind:checked={videoAudioOn} />
				<span>Video audio</span>
			</label>
		{/if}

		<label>
			<span>Tuning</span>
			<select bind:value={tuningKey}>
				{#each Object.entries(TUNINGS) as [key, t] (key)}
					<option value={key}>{t.name}</option>
				{/each}
			</select>
		</label>

		<label>
			<span>View</span>
			<select bind:value={renderMode}>
				<option value="page">Page (playhead moves)</option>
				<option value="scroll">Scroll (tab moves)</option>
			</select>
		</label>

		<label title="How to visualise the current position. Beat/Bar look cleaner in screen recordings because they only step on beat/bar boundaries.">
			<span>Playhead</span>
			<select bind:value={playheadStyle}>
				<option value="line">Line (smooth)</option>
				<option value="beat">Beat column (stepped)</option>
				<option value="bar">Bar column (stepped)</option>
			</select>
		</label>

		<label>
			<span>Theme</span>
			<select bind:value={theme}>
				<option value="dark">Dark</option>
				<option value="light">Light (white bg / black text)</option>
			</select>
		</label>

		<label title="Flash the whole string line when a note plays. Off by default because it can pull the eye away from the fret numbers.">
			<input type="checkbox" bind:checked={stringFlashEnabled} />
			<span>String flash</span>
		</label>

		<label>
			<span>Bars/{renderMode === 'page' ? 'page' : 'view'}</span>
			<input type="range" min="1" max="8" step="1" bind:value={barsPerPage} />
			<span class="mono">{barsPerPage}</span>
		</label>
		<label>
			<span>Peek (beats)</span>
			<input type="range" min="0" max="4" step="0.5" bind:value={peekBeats} />
			<span class="mono">{peekBeats}</span>
		</label>

		<label>
			<input type="checkbox" bind:checked={showNoteLengths} />
			<span>Show note lengths</span>
		</label>

		<label title="Off by default; enable only for non-MPE MIDI where you're using channels 1–6 to pin strings.">
			<input type="checkbox" bind:checked={honorChannelStrings} />
			<span>MIDI channel → string (1=low E, 6=high E)</span>
		</label>
	</section>


	{#if videoUrl}
		<!-- Composite canvas shows the video + tab overlay live (WYSIWYG). The raw
		<video> element stays in the DOM (hidden) for playback + captureStream. -->
		<canvas bind:this={compositeCanvas} class="perf-video"></canvas>
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			bind:this={videoElement}
			src={videoUrl}
			muted={!videoAudioOn}
			playsinline
			preload="auto"
			style="display:none"
		></video>
	{/if}

	<canvas
		bind:this={canvas}
		width="1280"
		height="260"
		class="tab-canvas"
		title="Drag notes up/down to reassign string · shift+click BETWEEN notes to toggle hammer/pull (auto-picked from fret direction) · alt+click a note to toggle tap"
		onpointerdown={onCanvasPointerDown}
		onpointermove={onCanvasPointerMove}
		onpointerup={onCanvasPointerUp}
		onpointercancel={onCanvasPointerUp}
	></canvas>

	<canvas
		class="timeline"
		bind:this={timelineCanvas}
		width="1280"
		height="34"
		title="Drag to seek (snaps to beats — hold Shift for free scrub)"
		onpointerdown={onTimelinePointerDown}
		onpointermove={onTimelinePointerMove}
		onpointerup={onTimelinePointerUp}
		onpointercancel={onTimelinePointerUp}
	></canvas>

	<section class="playback">
		<button onclick={togglePlay} disabled={!tab}>{playing ? 'Pause' : 'Play'}</button>
		<button onclick={reset} disabled={!tab}>Reset</button>
		<span class="mono">
			{#if tab}
				Bar {Math.floor(currentTime / tab.secondsPerBar) + 1}
				beat {Math.floor((currentTime % tab.secondsPerBar) / (tab.secondsPerBar / tab.timeSignature[0])) + 1}
				/ {Math.max(1, Math.ceil(effectiveDurationSec / tab.secondsPerBar))} bars
			{:else}
				—
			{/if}
		</span>

		<label>
			<input
				type="checkbox"
				bind:checked={audioOn}
				onchange={() => {
					if (!audioOn && playing) synth.stop();
					else if (audioOn && playing && tab) synth.play(tab, currentTime);
				}}
			/>
			<span>Audio</span>
		</label>
		<label>
			<span>Vol</span>
			<input type="range" min="0" max="1" step="0.01" bind:value={volume} />
		</label>
		<label title="Audible click on each beat, higher pitch on the downbeat. Useful for lining Tabutabu up against your DAW's audio.">
			<input type="checkbox" bind:checked={metronomeOn} />
			<span>Metronome</span>
		</label>
		{#if metronomeOn}
			<label>
				<span>Click vol</span>
				<input type="range" min="0" max="1" step="0.01" bind:value={metronomeVol} />
			</label>
		{/if}
		<span class="hint">space = play/pause · ←/→ = ±1 beat · shift+←/→ = ±1 bar · shift+drag = free scrub</span>
	</section>

	{#if videoUrl}
		<section class="controls">
			<span title="Encodes the composite (video + tab overlay you see in the preview) into a video-only WebM via WebCodecs. Output has no audio — combine with the source video's audio using ffmpeg: ffmpeg -i tab.webm -i original.mp4 -c:v copy -c:a aac -map 0:v -map 1:a out.mp4">
				<strong>Export video</strong>
			</span>
			<label>
				<span>Tab position</span>
				<select bind:value={tabPositionOnVideo} disabled={isExporting}>
					<option value="bottom">Bottom (overlay)</option>
					<option value="top">Top (overlay)</option>
					<option value="extend-below">Extend video (tab below)</option>
					<option value="extend-above">Extend video (tab above)</option>
					<option value="crop-top-bottom">Crop top → tab bottom (keeps source aspect)</option>
				</select>
			</label>
			<label>
				<span>Tab size</span>
				<input
					type="range"
					min="30"
					max="100"
					step="1"
					bind:value={tabSizePercent}
					disabled={isExporting}
				/>
				<span class="mono">{tabSizePercent}%</span>
			</label>
			<label>
				<span>Padding</span>
				<input
					type="range"
					min="0"
					max="10"
					step="0.5"
					bind:value={tabPaddingPercent}
					disabled={isExporting}
				/>
				<span class="mono">{tabPaddingPercent}%</span>
			</label>
			<label title="Which local ffmpeg encoder to use. NVENC variants run on the GPU — much faster on NVIDIA cards. libx264/libx265 are CPU-only fallbacks.">
				<span>Encoder</span>
				<select bind:value={exportEncoder} disabled={isExporting}>
					{#if availableEncoders.length === 0}
						<option value="h264_nvenc">h264_nvenc</option>
						<option value="hevc_nvenc">hevc_nvenc</option>
						<option value="av1_nvenc">av1_nvenc</option>
						<option value="libx264">libx264 (CPU)</option>
						<option value="libx265">libx265 (CPU)</option>
					{:else}
						{#each availableEncoders as enc (enc)}
							<option value={enc}>{enc}{enc.endsWith('_nvenc') ? ' (GPU)' : ' (CPU)'}</option>
						{/each}
					{/if}
				</select>
			</label>
			{#if !isExporting}
				<button onclick={startExport} disabled={!tab || !videoUrl}>Export</button>
			{:else if exportStage === 'encoding'}
				<button disabled>Uploading job…</button>
			{:else if exportStage === 'finalizing'}
				<button disabled>Rendering + encoding on server…</button>
			{/if}
			{#if exportError}
				<span class="err">{exportError}</span>
			{/if}
		</section>

		{#if exportResultUrl && exportResultName}
			<section class="controls" style="flex-direction:column;align-items:stretch;gap:8px">
				<div style="display:flex;align-items:center;gap:12px">
					<strong>Export ready</strong>
					<span class="mono">{exportResultName}</span>
					<span class="hint">
						{(exportResultSize / (1024 * 1024)).toFixed(1)} MB
					</span>
					<span style="flex:1"></span>
					<a href={exportResultUrl} download={exportResultName}>
						<button>Download</button>
					</a>
				</div>
				<!-- svelte-ignore a11y_media_has_caption -->
				<video
					src={exportResultUrl}
					controls
					style="width:100%;max-height:60vh;background:#000"
				></video>
			</section>
		{/if}
	{/if}

	<section class="controls">
		<label title="Sync Tabutabu's transport to a DAW's MIDI clock output (Start / Stop / Continue / Song Position). Data still comes from the file above — this only drives play/pause/seek.">
			<span>DAW sync (MIDI in)</span>
			<select bind:value={syncSelectedPort} disabled={syncConnected}>
				{#each syncPorts as p (p.id)}
					<option value={p.id}>{p.name}{p.manufacturer ? ` — ${p.manufacturer}` : ''}</option>
				{/each}
				{#if syncPorts.length === 0}
					<option value="">(no ports — install loopMIDI / IAC)</option>
				{/if}
			</select>
		</label>
		<button onclick={refreshSyncPorts} disabled={syncConnected}>Refresh</button>
		{#if !syncConnected}
			<button onclick={syncConnect} disabled={!syncSelectedPort}>Connect</button>
		{:else}
			<button onclick={syncDisconnect}>Disconnect</button>
		{/if}

		<label title="Positive value shifts the playhead forward on every Start/Seek. Compensates for loopMIDI + browser event-delivery latency (typically 10–30 ms).">
			<span>Offset (ms)</span>
			<input type="number" min="-500" max="500" step="1" bind:value={syncOffsetMs} style="width:70px" />
		</label>

		<label title="Preserve leading silence in the file so song time 0 = DAW bar 1 beat 1. Write an extra empty bar in Bitwig and it'll be there for the tab too, giving you a preroll and a stable sync reference.">
			<input type="checkbox" bind:checked={keepLeadingSilence} />
			<span>Keep leading silence</span>
		</label>

		<label title="Treat MIDI Start as 'resume from current position' instead of 'reset to 0'. Enable if your DAW sends Start (0xFA) when pressing play mid-song without sending Song Position Pointer first.">
			<input type="checkbox" bind:checked={preservePositionOnStart} />
			<span>Preserve position on Start</span>
		</label>

		<label title="Log Start / Stop / Continue / SPP messages to the DevTools console. Useful for diagnosing what your DAW actually sends.">
			<input type="checkbox" bind:checked={syncDebug} />
			<span>Log MIDI sync</span>
		</label>

		<span class="hint">
			{#if syncError}
				<span class="err">{syncError}</span>
			{:else if syncConnected}
				● listening
			{:else}
				○ idle
			{/if}
		</span>
	</section>

	{#if parseError}
		<p class="err">Failed to parse MIDI: {parseError}</p>
	{:else if tab}
		{@const counts = tab.notes.reduce(
			(acc, n) => {
				for (const a of n.articulations ?? []) acc[a.kind] = (acc[a.kind] ?? 0) + 1;
				return acc;
			},
			{} as Record<string, number>
		)}
		<p class="meta">
			<span class="mono">{fileName}</span> · {tab.notes.length} notes · {tab.bpm.toFixed(1)} bpm
			{#if tab.trimmedLeadingSec > 0}
				· trimmed {tab.trimmedLeadingSec.toFixed(2)}s of leading silence
			{/if}
		</p>
		<p class="meta mono">
			articulations detected:
			bend {counts.bend ?? 0} ·
			slide↑ {counts.slideUp ?? 0} ·
			slide↓ {counts.slideDown ?? 0} ·
			harmonic {counts.harmonic ?? 0} ·
			vibrato {counts.vibrato ?? 0} ·
			PM {counts.palmMute ?? 0} ·
			ghost {counts.ghost ?? 0} ·
			hammer {counts.hammerOn ?? 0} ·
			pull {counts.pullOff ?? 0} ·
			tap {counts.tap ?? 0}
		</p>
		{#if inspection}
			<details class="inspector">
				<summary>Raw MIDI event inspector (per channel)</summary>
				<table>
					<thead>
						<tr>
							<th>ch</th>
							<th>notes</th>
							<th>pitchBend</th>
							<th>pressure</th>
							<th>polyAT</th>
							<th>CCs (num×count)</th>
						</tr>
					</thead>
					<tbody>
						{#each [...inspection.channels.entries()].sort((a, b) => a[0] - b[0]) as [ch, s] (ch)}
							<tr>
								<td>{ch}</td>
								<td>{s.notes}</td>
								<td>{s.pitchBends}</td>
								<td>{s.pressure}</td>
								<td>{s.polyAftertouch}</td>
								<td>
									{[...s.ccs.entries()]
										.sort((a, b) => a[0] - b[0])
										.map(([n, c]) => `CC${n}×${c}`)
										.join(', ') || '—'}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</details>
		{/if}
	{:else}
		<p class="meta">Load a MIDI file to get started.</p>
	{/if}
</div>

<style>
	:global(html, body) {
		background: #0b0f14;
		color: #e6eef7;
		font-family:
			ui-sans-serif,
			system-ui,
			-apple-system,
			Segoe UI,
			Roboto,
			sans-serif;
	}
	.app {
		max-width: 1360px;
		margin: 0 auto;
		padding: 24px 16px 48px;
		display: grid;
		gap: 16px;
	}
	header h1 {
		font-size: 28px;
		margin: 0;
		letter-spacing: -0.02em;
	}
	.sub {
		margin: 4px 0 0;
		color: #8a99ad;
	}
	.controls,
	.playback {
		display: flex;
		align-items: center;
		gap: 16px;
		flex-wrap: wrap;
		background: #141b23;
		border: 1px solid #232c36;
		border-radius: 10px;
		padding: 10px 14px;
	}
	label {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	label > span {
		color: #8a99ad;
		font-size: 13px;
	}
	select,
	input[type='range'],
	input[type='file'] {
		background: #0b0f14;
		color: #e6eef7;
		border: 1px solid #2a3543;
		border-radius: 6px;
		padding: 4px 6px;
	}
	canvas {
		width: 100%;
		max-width: 100%;
		border-radius: 10px;
		border: 1px solid #232c36;
		display: block;
	}
	canvas.timeline {
		border-radius: 6px;
		cursor: grab;
		touch-action: none;
		user-select: none;
	}
	canvas.timeline:active {
		cursor: grabbing;
	}
	canvas.perf-video {
		width: 100%;
		max-width: 100%;
		border-radius: 10px;
		border: 1px solid #232c36;
		background: #000;
		display: block;
	}
	button {
		background: #ffcc55;
		color: #0b0f14;
		border: none;
		border-radius: 6px;
		padding: 6px 14px;
		font-weight: 700;
		cursor: pointer;
	}
	button:disabled {
		background: #2a3543;
		color: #6b788a;
		cursor: not-allowed;
	}
	.mono {
		font-family: ui-monospace, Menlo, Consolas, monospace;
		color: #8a99ad;
	}
	.hint {
		color: #6b788a;
		font-size: 12px;
		margin-left: auto;
	}
	button.link {
		background: none;
		color: #8a99ad;
		border: none;
		padding: 0;
		font-size: 12px;
		text-decoration: underline;
		cursor: pointer;
		font-weight: normal;
	}
	button.link:hover {
		color: #e6eef7;
	}
	.nudge-group {
		display: inline-flex;
		gap: 4px;
	}
	button.nudge {
		background: #1c2734;
		color: #e6eef7;
		border: 1px solid #2a3543;
		border-radius: 4px;
		padding: 3px 8px;
		font-family: ui-monospace, Menlo, Consolas, monospace;
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
	}
	button.nudge:hover {
		background: #232c36;
	}
	.err {
		color: #ff8877;
	}
	.meta {
		color: #8a99ad;
		font-size: 14px;
	}
	.inspector {
		background: #141b23;
		border: 1px solid #232c36;
		border-radius: 10px;
		padding: 10px 14px;
		color: #e6eef7;
		font-size: 13px;
	}
	.inspector summary {
		cursor: pointer;
		color: #8a99ad;
	}
	.inspector table {
		width: 100%;
		border-collapse: collapse;
		margin-top: 8px;
		font-family: ui-monospace, Menlo, Consolas, monospace;
	}
	.inspector th,
	.inspector td {
		text-align: left;
		padding: 4px 8px;
		border-bottom: 1px solid #232c36;
	}
	.inspector th {
		color: #8a99ad;
		font-weight: 600;
	}
</style>
