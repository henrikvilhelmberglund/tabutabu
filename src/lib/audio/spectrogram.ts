// Spectrogram of the reference audio, shown in author mode lined up with
// the tab. The whole file is analysed once (in a worker, see
// spectrogram-analysis.ts) and the result can be stored; drawing then just
// copies the columns for the time span the tab shows.

// The analysis result: what gets stored so it isn't recomputed.
export type SpectrogramData = {
	// Bumped whenever the analysis changes, so stored results are redone.
	version: number;
	// Seconds between frames (columns); frame i is centred on i × hopSec.
	hopSec: number;
	frames: number;
	rows: number;
	minMidi: number;
	rowsPerSemitone: number;
	// frames × rows bytes each, frame-major; row 0 = lowest pitch. See
	// spectrogram-analysis.ts for the three pictures.
	plain: Uint8Array;
	spectrum: Uint8Array;
	notes: Uint8Array;
};

// Which picture is shown: how loud each pitch is (plain), every pitch that
// stands out, or only the picked notes.
export type SpectroStyle = 'plain' | 'spectrum' | 'notes';

export type Spectrogram = SpectrogramData & {
	// Pre-coloured image strips per picture (≤ TILE frames wide each), row 0
	// at the top = highest pitch.
	tiles: Record<SpectroStyle, HTMLCanvasElement[]>;
};

// What part of the stereo image is analysed: everything, only what is
// panned away from the centre (left minus right — hard-panned rhythm
// guitars without the centred bass, drums, vocals and solos), or just the
// left or right channel.
export type SpectroChannel = 'mix' | 'sides' | 'left' | 'right';

export const SPECTROGRAM_VERSION = 10;
const SAMPLE_RATE = 11025; // plenty for guitar notes and their first harmonics
const HOP = 128; // ≈ 12 ms per column
const MIN_MIDI = 36; // C2 (drop-C low string)
const MAX_MIDI = 96; // C7
const ROWS_PER_SEMITONE = 4;
const TILE = 4096;

// Decode `fileBuffer` (any format the browser can play) and resample it to
// the analysis rate, keeping left and right. Also the file's own channel
// count (a mono file comes back as two identical channels).
export async function decodeReference(
	fileBuffer: ArrayBuffer
): Promise<{ audio: AudioBuffer; channels: number }> {
	const decoded = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(fileBuffer.slice(0));
	const length = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE));
	const off = new OfflineAudioContext(2, length, SAMPLE_RATE);
	const src = off.createBufferSource();
	src.buffer = decoded;
	src.connect(off.destination);
	src.start();
	return { audio: await off.startRendering(), channels: decoded.numberOfChannels };
}

// Decode `fileBuffer` (any format the browser can play), analyse the
// chosen `channel` and build the image tiles. `onProgress` gets 0..1 while
// the worker runs.
export async function computeSpectrogram(
	fileBuffer: ArrayBuffer,
	channel: SpectroChannel,
	onProgress?: (p: number) => void,
	separated = false
): Promise<Spectrogram> {
	const { audio, channels } = await decodeReference(fileBuffer);
	if (channel === 'sides' && channels < 2) {
		throw new Error('the reference is mono, so there are no sides — switch to Mix');
	}
	const length = audio.length;
	const left = audio.getChannelData(0);
	const right = audio.getChannelData(1);
	const samples = new Float32Array(length);
	const [gl, gr] =
		channel === 'left'
			? [1, 0]
			: channel === 'right'
				? [0, 1]
				: channel === 'sides'
					? [0.5, -0.5]
					: [0.5, 0.5];
	for (let i = 0; i < length; i++) samples[i] = gl * left[i] + gr * right[i];

	const worker = new Worker(new URL('./spectrogram-worker.ts', import.meta.url), {
		type: 'module'
	});
	const result = await new Promise<{
		frames: number;
		rows: number;
		plain: Uint8Array;
		spectrum: Uint8Array;
		notes: Uint8Array;
	}>((resolve, reject) => {
		worker.onmessage = (e) => {
			if (e.data.done) resolve(e.data);
			else if (typeof e.data.progress === 'number') onProgress?.(e.data.progress);
		};
		worker.onerror = (e) => reject(new Error(e.message));
		worker.postMessage(
			{
				samples,
				sampleRate: SAMPLE_RATE,
				hop: HOP,
				minMidi: MIN_MIDI,
				maxMidi: MAX_MIDI,
				rowsPerSemitone: ROWS_PER_SEMITONE,
				separated
			},
			[samples.buffer]
		);
	}).finally(() => worker.terminate());

	return spectrogramFromData({
		version: SPECTROGRAM_VERSION,
		hopSec: HOP / SAMPLE_RATE,
		frames: result.frames,
		rows: result.rows,
		minMidi: MIN_MIDI,
		rowsPerSemitone: ROWS_PER_SEMITONE,
		plain: result.plain,
		spectrum: result.spectrum,
		notes: result.notes
	});
}

// Rebuild the drawable spectrogram from an analysis result (fresh or
// stored).
export function spectrogramFromData(d: SpectrogramData): Spectrogram {
	return {
		...d,
		tiles: {
			plain: buildTiles(d.frames, d.rows, d.plain),
			spectrum: buildTiles(d.frames, d.rows, d.spectrum),
			notes: buildTiles(d.frames, d.rows, d.notes)
		}
	};
}

// The pitch span worth showing for a tuning: a little below the lowest
// open string up to past the 24th fret of the highest, within what was
// analysed. [low, high] MIDI at the bottom / top edge.
export function spectrogramPitchRange(
	spec: Spectrogram,
	openNotes: readonly number[]
): [number, number] {
	const half = 0.5 / spec.rowsPerSemitone;
	const bottom = spec.minMidi - half;
	const top = spec.minMidi + (spec.rows - 1) / spec.rowsPerSemitone + half;
	const lo = Math.max(bottom, Math.min(...openNotes) - 2);
	const hi = Math.min(top, Math.max(...openNotes) + 26);
	return [lo, hi];
}

// Black → blue → purple → red → orange → yellow → white, like foobar2000's
// spectrogram.
const LUT = (() => {
	const stops: Array<[number, number, number, number]> = [
		[0, 0, 0, 0],
		[0.18, 10, 10, 90],
		[0.38, 110, 20, 150],
		[0.58, 220, 30, 60],
		[0.76, 255, 140, 0],
		[0.9, 255, 230, 60],
		[1, 255, 255, 255]
	];
	const lut = new Uint8Array(256 * 3);
	for (let i = 0; i < 256; i++) {
		const t = i / 255;
		let s = 0;
		while (s < stops.length - 2 && t > stops[s + 1][0]) s++;
		const [t0, r0, g0, b0] = stops[s];
		const [t1, r1, g1, b1] = stops[s + 1];
		const u = (t - t0) / (t1 - t0);
		lut[i * 3] = r0 + (r1 - r0) * u;
		lut[i * 3 + 1] = g0 + (g1 - g0) * u;
		lut[i * 3 + 2] = b0 + (b1 - b0) * u;
	}
	return lut;
})();

function buildTiles(frames: number, rows: number, data: Uint8Array): HTMLCanvasElement[] {
	const tiles: HTMLCanvasElement[] = [];
	for (let f0 = 0; f0 < frames; f0 += TILE) {
		const w = Math.min(TILE, frames - f0);
		const c = document.createElement('canvas');
		c.width = w;
		c.height = rows;
		const ctx = c.getContext('2d')!;
		const img = ctx.createImageData(w, rows);
		for (let x = 0; x < w; x++) {
			const base = (f0 + x) * rows;
			for (let r = 0; r < rows; r++) {
				const v = data[base + r];
				const o = ((rows - 1 - r) * w + x) * 4;
				img.data[o] = LUT[v * 3];
				img.data[o + 1] = LUT[v * 3 + 1];
				img.data[o + 2] = LUT[v * 3 + 2];
				img.data[o + 3] = 255;
			}
		}
		ctx.putImageData(img, 0, 0);
		tiles.push(c);
	}
	return tiles;
}

// Draw the `style` picture's columns for reference time [t0, t1] and
// pitches [lo, hi] (MIDI, see spectrogramPitchRange) into dest rect x0..x1
// (full canvas height). Handles tile boundaries; outside the audio stays
// blank.
export function drawSpectrogramSpan(
	ctx: CanvasRenderingContext2D,
	spec: Spectrogram,
	style: SpectroStyle,
	t0: number,
	t1: number,
	x0: number,
	x1: number,
	height: number,
	[lo, hi]: [number, number]
) {
	if (t1 <= t0 || x1 <= x0) return;
	const pxPerSec = (x1 - x0) / (t1 - t0);
	const f0 = Math.max(0, t0 / spec.hopSec);
	const f1 = Math.min(spec.frames, t1 / spec.hopSec);
	if (f1 <= f0) return;
	// Tile y of a pitch: row r is centred on minMidi + r / rowsPerSemitone
	// and drawn at y = rows - 1 - r.
	const tileY = (midi: number) => spec.rows - 0.5 - (midi - spec.minMidi) * spec.rowsPerSemitone;
	const sy = tileY(hi);
	const sh = tileY(lo) - sy;
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';
	const tiles = spec.tiles[style];
	for (let i = 0; i < tiles.length; i++) {
		const tileStart = i * TILE;
		const tile = tiles[i];
		const a = Math.max(f0, tileStart);
		const b = Math.min(f1, tileStart + tile.width);
		if (b <= a) continue;
		const dx0 = x0 + (a * spec.hopSec - t0) * pxPerSec;
		const dx1 = x0 + (b * spec.hopSec - t0) * pxPerSec;
		ctx.drawImage(tile, a - tileStart, sy, b - a, sh, dx0, 0, dx1 - dx0, height);
	}
}
