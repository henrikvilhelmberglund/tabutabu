// Spectrogram analysis of the reference audio (runs in a worker, see
// spectrogram-worker.ts). Plain functions, no DOM, so it can be tested
// outside the browser.
//
// Output: three pictures, one byte per (frame, pitch row) each, on a
// musical pitch axis (rows per semitone from minMidi up):
//
// - "plain": how loud each pitch is, on one fixed scale for the whole song
//   (PLAIN_RANGE_DB below its loud level is black). No processing beyond
//   the measurement — what's actually in the audio.
// - "spectrum": how much every pitch stands out. Shows everything that
//   sounds, including each note's harmonics — good for solos, bends,
//   vibrato.
// - "notes": only the notes that best explain the sound, picked one by one
//   — close to a piano roll, good for rhythm parts.
//
// How:
//
// - Every pitch row is measured with a long window that just separates
//   neighbouring semitones at that pitch (low strings need ~0.4 s), and with
//   one an eighth as long; the smaller of the two is kept. Where there is a
//   note both are loud; away from it in time the short window is quiet, away
//   from it in pitch the long one is, so notes stay sharp both ways.
// - Levels are averaged over a few frames, which calms the random flicker
//   of noise (cymbals, distortion hiss) while steady notes stay put.
// - A pitch's "prominence" is how far it stands above its neighbourhood (a
//   few semitones either side), not how loud it is. A note is a peak; drums,
//   cymbals and hiss are a flat carpet, so they drop out.
// - Spectrum: prominence combined with how prominent the pitch's own
//   harmonics (2×, 3×, …) are, so played notes outshine the harmonic ladder.
// - Notes: repeatedly take the pitch whose harmonic series best explains
//   what's left and take its harmonics away, up to a few notes per moment.
//   Blips shorter than a few frames are dropped.
// - Both: notes are brightest where they're struck and fade as they die
//   away, so repeated notes (palm-muted chugs) show as separate pulses; and
//   brightness is scaled to what's nearby in time and pitch, so a quiet
//   passage or a solo above the rhythm guitars still reaches full white.

export type AnalysisOptions = {
	sampleRate: number;
	hop: number;
	minMidi: number;
	maxMidi: number;
	rowsPerSemitone: number;
	// A separated instrument (no drums mixed in): picked notes may continue
	// without proving their harmonics again (see pickNotes).
	separated?: boolean;
};

export type AnalysisResult = {
	frames: number;
	rows: number;
	plain: Uint8Array;
	spectrum: Uint8Array;
	notes: Uint8Array;
};

// Longest window, and how much shorter the time-sharp window is.
const MAX_FFT = 4096;
const MIN_FFT = 128;
const SHORT_RATIO = 8;
// Frames averaged either side (× hop ≈ 12 ms).
const SMOOTH_FRAMES = 1;
// Neighbourhood a pitch is compared with: this many semitones either side,
// leaving out the pitch's own ± EXCLUDE semitones.
const BASE_SEMITONES = 3;
const EXCLUDE_SEMITONES = 0.5;
// Harmonics that count as support for a pitch, and how much each further
// one counts (relative to the one before).
const HARMONICS = 6;
const HARMONIC_DECAY = 0.8;
// Note picking: at most this many notes per moment; a note must stand this
// many dB above its neighbourhood itself, and explain at least STOP × as
// much as the first note picked.
const MAX_NOTES = 6;
const NOTE_MIN_DB = 5;
const NOTE_STOP = 0.2;
// … a note continuing from the previous moment needs only this share.
const NOTE_STOP_CONTINUE = 0.1;
// Taking a note's harmonic away: no more than SMOOTH × its neighbouring
// harmonics' average (what's above that is another note on the same pitch),
// over ± WIDTH rows.
const HARMONIC_SMOOTH = 0.7;
const HARMONIC_WIDTH = 2;
// A note's harmonics (2× … 6×) must on average stand out at least this ×
// as much as the note itself. Guitar notes are rich in harmonics; drum
// tones (toms, cymbals, snare ring) mostly aren't, so they aren't picked.
const HARM_MIN = 1;
// A candidate sitting on a harmonic of a note already picked this moment is
// most likely that harmonic, so it counts this × as much.
const OCTAVE_PENALTY = 0.6;
// A picked note moves down an octave when the pitch there stands out at
// least OCTAVE_LOW_SHARE × as much and its odd harmonics are at least
// OCTAVE_LOW_ODD × its even ones (a real note, not just more harmonics).
const OCTAVE_LOW_SHARE = 0.5;
const OCTAVE_LOW_ODD = 0.3;
// Shown for the rows beside a picked note, and for everything else (faint
// context), as a share of the spectrum value.
const NOTE_SIDE = 0.8;
const NOTE_CONTEXT = 0.25;
// Notes shorter than 2 × this + 1 frames are dropped.
const NOTE_MIN_FRAMES = 2;
// A note fades from full to dark as it drops this many dB below its peak
// within the last ATTACK_SECONDS.
const ATTACK_SECONDS = 0.25;
const ATTACK_FADE_DB = 15;
// Brightness follows the music: NORM_WHITE × the strongest value within
// NORM_SECONDS and REGION_SEMITONES either side is full white (a loud chorus
// doesn't dim a quiet verse, the rhythm guitar doesn't dim a solo) — but
// never scaled up past NORM_FLOOR × the song's typical strong value, so
// near-silence doesn't turn into bright noise. The curve darkens weak values
// so faint noise stays in the background.
const NORM_SECONDS = 1;
const REGION_SEMITONES = 12;
const TOP_QUANTILE = 0.995;
const NORM_FLOOR = 0.5;
const NORM_WHITE = 0.65;
const GAMMA = 1.5;
// Plain picture: dB range shown below the song's loud level (this quantile).
const PLAIN_RANGE_DB = 50;
const PLAIN_TOP_QUANTILE = 0.999;

type FftPlan = {
	n: number;
	window: Float32Array;
	rev: Uint32Array;
	cos: Float32Array;
	sin: Float32Array;
	// Sum of the window, to put all sizes on the same level.
	gain: number;
};

function plan(n: number): FftPlan {
	const window = new Float32Array(n);
	let gain = 0;
	for (let i = 0; i < n; i++) {
		window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n);
		gain += window[i];
	}
	const bits = Math.log2(n);
	const rev = new Uint32Array(n);
	for (let i = 0; i < n; i++) {
		let r = 0;
		for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
		rev[i] = r;
	}
	const cos = new Float32Array(n / 2);
	const sin = new Float32Array(n / 2);
	for (let i = 0; i < n / 2; i++) {
		cos[i] = Math.cos((2 * Math.PI * i) / n);
		sin[i] = -Math.sin((2 * Math.PI * i) / n);
	}
	return { n, window, rev, cos, sin, gain };
}

// Magnitude spectra (bins 0..maxBin, divided by the window gain) of two
// frames at once: frame A goes in the real part, frame B in the imaginary
// part, and the two spectra are separated afterwards. Halves the work.
function magnitudePair(
	p: FftPlan,
	samples: Float32Array,
	centerA: number,
	centerB: number,
	re: Float32Array,
	im: Float32Array,
	outA: Float32Array,
	outB: Float32Array,
	maxBin: number
) {
	const { n, window, rev, cos, sin, gain } = p;
	const a0 = centerA - n / 2;
	const b0 = centerB - n / 2;
	const len = samples.length;
	for (let i = 0; i < n; i++) {
		const sa = a0 + i;
		const sb = b0 + i;
		const j = rev[i];
		re[j] = sa >= 0 && sa < len ? samples[sa] * window[i] : 0;
		im[j] = sb >= 0 && sb < len ? samples[sb] * window[i] : 0;
	}
	for (let size = 2; size <= n; size <<= 1) {
		const half = size >> 1;
		const step = n / size;
		for (let i = 0; i < n; i += size) {
			for (let j = 0; j < half; j++) {
				const wr = cos[j * step];
				const wi = sin[j * step];
				const a = i + j;
				const b = a + half;
				const tr = re[b] * wr - im[b] * wi;
				const ti = re[b] * wi + im[b] * wr;
				re[b] = re[a] - tr;
				im[b] = im[a] - ti;
				re[a] += tr;
				im[a] += ti;
			}
		}
	}
	// A[k] = (Z[k] + conj Z[n-k]) / 2, B[k] = (Z[k] - conj Z[n-k]) / 2i
	const norm = 0.5 / gain;
	for (let k = 0; k <= maxBin; k++) {
		const m = (n - k) & (n - 1);
		const zr = re[k];
		const zi = im[k];
		const cr = re[m];
		const ci = -im[m];
		outA[k] = Math.hypot(zr + cr, zi + ci) * norm;
		outB[k] = Math.hypot(zi - ci, cr - zr) * norm;
	}
}

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

// How a pitch row reads one spectrum: the value interpolated at its centre,
// or the loudest bin inside it if that's more.
type RowRead = { fft: number; lo: number; hi: number; pos: number };

function rowRead(
	sizes: number[],
	f: number,
	n: number,
	sampleRate: number,
	lo: number,
	hi: number
): RowRead {
	const binHz = sampleRate / n;
	return {
		fft: sizes.indexOf(n),
		lo: Math.ceil(lo / binHz),
		hi: Math.floor(hi / binHz),
		pos: f / binHz
	};
}

function readRow(m: Float32Array, r: RowRead): number {
	const k = Math.floor(r.pos);
	const u = r.pos - k;
	let v = m[k] * (1 - u) + m[k + 1] * u;
	for (let b = r.lo; b <= r.hi; b++) if (m[b] > v) v = m[b];
	return v;
}

export function analyse(
	samples: Float32Array,
	opts: AnalysisOptions,
	onProgress?: (p: number) => void
): AnalysisResult {
	const { sampleRate, hop, minMidi, maxMidi, rowsPerSemitone } = opts;
	const rows = (maxMidi - minMidi) * rowsPerSemitone;
	const sizes: number[] = [];
	for (let n = MAX_FFT; n >= MIN_FFT; n >>= 1) sizes.push(n);
	const plans = sizes.map(plan);

	// Harmonic h of row r sits this many rows above it.
	const harmOffset: number[] = [];
	const harmWeight: number[] = [];
	for (let h = 1; h <= HARMONICS; h++) {
		harmOffset.push(Math.round(12 * Math.log2(h) * rowsPerSemitone));
		harmWeight.push(Math.pow(HARMONIC_DECAY, h - 1));
	}
	// Rows are measured up to the highest harmonic of the top row (or the
	// Nyquist limit).
	const nyquistMidi = 69 + 12 * Math.log2(sampleRate / 2 / 440) - 0.5;
	const measured = Math.min(
		rows + harmOffset[HARMONICS - 1] + 1,
		Math.floor((nyquistMidi - minMidi) * rowsPerSemitone)
	);

	// Per pitch row: the long (pitch-sharp) and short (time-sharp) reads.
	const longRead: RowRead[] = [];
	const shortRead: RowRead[] = [];
	const maxBins = sizes.map(() => 0);
	for (let r = 0; r < measured; r++) {
		const midi = minMidi + r / rowsPerSemitone;
		const f = hz(midi);
		const lo = hz(midi - 0.5 / rowsPerSemitone);
		const hi = hz(midi + 0.5 / rowsPerSemitone);
		// Hann main lobe is ±2 bins: separate neighbours a semitone apart.
		const semitoneHz = f * (Math.pow(2, 1 / 12) - 1);
		let nLong = MIN_FFT;
		while (nLong < MAX_FFT && (2 * sampleRate) / nLong > semitoneHz) nLong <<= 1;
		const nShort = Math.max(MIN_FFT, nLong / SHORT_RATIO);
		longRead.push(rowRead(sizes, f, nLong, sampleRate, lo, hi));
		shortRead.push(rowRead(sizes, f, nShort, sampleRate, lo, hi));
		for (const rr of [longRead[r], shortRead[r]]) {
			maxBins[rr.fft] = Math.max(maxBins[rr.fft], rr.hi, Math.ceil(rr.pos) + 1);
		}
	}
	const used = sizes.map((_, i) => maxBins[i] > 0);

	const frames = Math.floor(samples.length / hop) + 1;
	const spec = new Float32Array(frames * rows);
	const notes = new Float32Array(frames * rows);
	// Smoothed level of each shown row, in 0.5 dB steps below 0 dB (for the
	// attack shading).
	const lev = new Uint8Array(frames * rows);
	const re = sizes.map((n) => new Float32Array(n));
	const im = sizes.map((n) => new Float32Array(n));
	const magA = sizes.map((n) => new Float32Array(n / 2 + 2));
	const magB = sizes.map((n) => new Float32Array(n / 2 + 2));
	// Power per measured row for the last few frames (enough to smooth).
	const RING = 2 * SMOOTH_FRAMES + 2;
	const ring = Array.from({ length: RING }, () => new Float32Array(measured));
	const level = new Float32Array(measured); // smoothed, dB
	const prom = new Float32Array(measured); // dB above the neighbourhood
	const cum = new Float64Array(measured + 1);
	const K = BASE_SEMITONES * rowsPerSemitone;
	const E = Math.round(EXCLUDE_SEMITONES * rowsPerSemitone);

	// How well row r's harmonic series explains `v` (each harmonic may land
	// a row off: rounding, slightly sharp strings).
	const support = (v: Float32Array, r: number, from: number) => {
		let sum = 0;
		let wsum = 0;
		for (let h = from; h < HARMONICS; h++) {
			const c = r + harmOffset[h];
			if (c >= measured) break;
			let x = v[c];
			if (h > 0) {
				if (v[c - 1] > x) x = v[c - 1];
				if (c + 1 < measured && v[c + 1] > x) x = v[c + 1];
			}
			sum += harmWeight[h] * x;
			wsum += harmWeight[h];
		}
		return { sum, wsum };
	};

	const work = new Float32Array(measured);
	const harmVal = new Float32Array(HARMONICS);
	const picked: number[] = [];
	// Rows picked in the previous frame. On a separated instrument, a note
	// that's already sounding keeps going as long as it stands out, without
	// proving its harmonics again — on a long note they fade faster than the
	// note itself. (On a full mix that check is what keeps drums out, so it
	// stays on every frame there.)
	let prevPicked = new Uint8Array(rows);
	let curPicked = new Uint8Array(rows);
	const pickNotes = (base: number) => {
		work.set(prom);
		let first = 0;
		picked.length = 0;
		[prevPicked, curPicked] = [curPicked, prevPicked];
		curPicked.fill(0);
		for (let n = 0; n < MAX_NOTES; n++) {
			let best = -1;
			let bestS = 0;
			for (let r = 0; r < rows; r++) {
				if (work[r] < NOTE_MIN_DB) continue;
				let s = support(work, r, 0).sum;
				if (!prevPicked[r]) {
					const hs = support(work, r, 1);
					if (hs.wsum > 0 && hs.sum / hs.wsum < HARM_MIN * work[r]) continue;
				}
				for (const q of picked) {
					const d = r - q;
					for (let h = 1; h < HARMONICS; h++) {
						if (Math.abs(d - harmOffset[h]) <= 1) {
							s *= OCTAVE_PENALTY;
							break;
						}
					}
				}
				if (s > bestS) {
					bestS = s;
					best = r;
				}
			}
			if (best < 0) break;
			const continuing = prevPicked[best] === 1;
			if (bestS < (continuing ? NOTE_STOP_CONTINUE : NOTE_STOP) * first) break;
			const oct = 12 * rowsPerSemitone;
			// Harmonic h (0 = the note itself) of row r in `work`.
			const hv = (r: number, h: number) => {
				const c = r + harmOffset[h];
				if (c >= measured) return 0;
				return Math.max(work[c], work[c - 1], c + 1 < measured ? work[c + 1] : 0);
			};
			// Octave above the real note? If the octave below is clearly there
			// too and has its own odd harmonics (3×, 5×), this is most likely
			// that note's 2× harmonic (distortion often makes it the loudest).
			const l = best - oct;
			if (
				!continuing &&
				l >= 0 &&
				!picked.includes(l) &&
				work[l] >= OCTAVE_LOW_SHARE * work[best]
			) {
				const odd = (hv(l, 2) + hv(l, 4)) / 2;
				const even = (hv(l, 1) + hv(l, 3)) / 2;
				if (odd >= OCTAVE_LOW_ODD * even) {
					best = l;
					bestS = support(work, best, 0).sum;
				}
			}
			if (n === 0) first = bestS;
			picked.push(best);
			if (opts.separated) {
				for (let d = -1; d <= 1; d++) if (best + d >= 0 && best + d < rows) curPicked[best + d] = 1;
			}
			notes[base + best] = Math.max(notes[base + best], bestS);
			if (best > 0) notes[base + best - 1] = Math.max(notes[base + best - 1], bestS * NOTE_SIDE);
			if (best + 1 < rows)
				notes[base + best + 1] = Math.max(notes[base + best + 1], bestS * NOTE_SIDE);
			// Take its harmonics away.
			for (let h = 0; h < HARMONICS; h++) {
				const c = best + harmOffset[h];
				harmVal[h] = c < measured ? work[c] : 0;
			}
			for (let h = 0; h < HARMONICS; h++) {
				const c = best + harmOffset[h];
				if (c >= measured) break;
				let est = harmVal[h];
				if (h > 0) {
					const nb = h + 1 < HARMONICS ? (harmVal[h - 1] + harmVal[h + 1]) / 2 : harmVal[h - 1];
					est = Math.min(est, nb * HARMONIC_SMOOTH);
				}
				for (let d = -HARMONIC_WIDTH; d <= HARMONIC_WIDTH; d++) {
					const rr = c + d;
					if (rr >= 0 && rr < measured) work[rr] = Math.max(0, work[rr] - est);
				}
			}
		}
	};

	// Finish frame g once frames up to g + SMOOTH_FRAMES are measured.
	const finish = (g: number) => {
		const f0 = Math.max(0, g - SMOOTH_FRAMES);
		const f1 = Math.min(frames - 1, g + SMOOTH_FRAMES);
		for (let r = 0; r < measured; r++) {
			let p = 0;
			for (let q = f0; q <= f1; q++) p += ring[q % RING][r];
			level[r] = 10 * Math.log10(p / (f1 - f0 + 1) + 1e-18);
		}
		cum[0] = 0;
		for (let r = 0; r < measured; r++) cum[r + 1] = cum[r] + level[r];
		for (let r = 0; r < measured; r++) {
			const lo = Math.max(0, r - K);
			const hi = Math.min(measured - 1, r + K);
			const xlo = Math.max(lo, r - E);
			const xhi = Math.min(hi, r + E);
			const n = hi - lo + 1 - (xhi - xlo + 1);
			const around = n > 0 ? (cum[hi + 1] - cum[lo] - (cum[xhi + 1] - cum[xlo])) / n : level[r];
			prom[r] = Math.max(0, level[r] - around);
		}
		const base = g * rows;
		for (let r = 0; r < rows; r++) {
			lev[base + r] = Math.max(0, Math.min(255, Math.round(-level[r] * 2)));
			if (prom[r] === 0) continue;
			const { sum, wsum } = support(prom, r, 0);
			// Geometric mean of the row's own prominence and its harmonics'.
			spec[base + r] = Math.sqrt(prom[r] * (sum / wsum));
		}
		pickNotes(base);
	};

	for (let fr = 0; fr < frames; fr += 2) {
		const hasB = fr + 1 < frames;
		for (let f = 0; f < sizes.length; f++) {
			if (!used[f]) continue;
			magnitudePair(
				plans[f],
				samples,
				fr * hop,
				(fr + 1) * hop,
				re[f],
				im[f],
				magA[f],
				magB[f],
				maxBins[f]
			);
		}
		for (let side = 0; side < (hasB ? 2 : 1); side++) {
			const mags = side === 0 ? magA : magB;
			const pw = ring[(fr + side) % RING];
			for (let r = 0; r < measured; r++) {
				const l = longRead[r];
				const s = shortRead[r];
				const v = Math.min(readRow(mags[l.fft], l), readRow(mags[s.fft], s));
				pw[r] = v * v;
			}
			const g = fr + side - SMOOTH_FRAMES;
			if (g >= 0) finish(g);
		}
		if (fr % 1000 === 0) onProgress?.(fr / frames);
	}
	for (let g = Math.max(0, frames - SMOOTH_FRAMES); g < frames; g++) finish(g);

	const col = new Float32Array(frames);
	const col2 = new Float32Array(frames);
	for (let r = 0; r < rows; r++) {
		// Notes must last a little: shortest-nearby then longest-nearby (an
		// "opening") drops blips. A note moving by a row (bends, vibrato)
		// still counts as lasting.
		for (let g = 0; g < frames; g++) {
			const i = g * rows + r;
			let v = notes[i];
			if (r > 0 && notes[i - 1] > v) v = notes[i - 1];
			if (r + 1 < rows && notes[i + 1] > v) v = notes[i + 1];
			col[g] = -v;
		}
		const eroded = slidingMax(col, NOTE_MIN_FRAMES, NOTE_MIN_FRAMES);
		for (let g = 0; g < frames; g++) eroded[g] = -eroded[g];
		const opened = slidingMax(eroded, NOTE_MIN_FRAMES, NOTE_MIN_FRAMES);

		// Attacks: full where struck, fading as the row's level drops below
		// its recent peak.
		for (let g = 0; g < frames; g++) col2[g] = -lev[g * rows + r] / 2;
		const peak = slidingMax(col2, Math.max(1, Math.round((ATTACK_SECONDS * sampleRate) / hop)), 0);
		for (let g = 0; g < frames; g++) {
			const i = g * rows + r;
			let shade = 1 + (col2[g] - peak[g]) / ATTACK_FADE_DB;
			if (shade < 0) shade = 0;
			spec[i] *= shade;
			notes[i] = Math.max(Math.min(notes[i], opened[g]) * shade, spec[i] * NOTE_CONTEXT);
		}
	}
	onProgress?.(1);

	return {
		frames,
		rows,
		plain: plainBytes(lev),
		spectrum: toBytes(spec, frames, rows, rowsPerSemitone, sampleRate, hop, GAMMA),
		notes: toBytes(notes, frames, rows, rowsPerSemitone, sampleRate, hop, GAMMA)
	};
}

// Plain picture from the levels (`lev`: 0.5 dB steps below 0 dB): one
// fixed dB scale for the whole song.
function plainBytes(lev: Uint8Array): Uint8Array {
	const stride = Math.max(1, Math.floor(lev.length / 200000));
	const sample: number[] = [];
	for (let i = 0; i < lev.length; i += stride) sample.push(-lev[i] / 2);
	const top = sample.length ? quantile(Float32Array.from(sample), PLAIN_TOP_QUANTILE) : 0;
	const floor = top - PLAIN_RANGE_DB;
	const data = new Uint8Array(lev.length);
	for (let i = 0; i < lev.length; i++) {
		const t = (-lev[i] / 2 - floor) / PLAIN_RANGE_DB;
		data[i] = t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255);
	}
	return data;
}

// Brightness bytes, scaled to what's nearby in time and pitch (see NORM_*).
function toBytes(
	v: Float32Array,
	frames: number,
	rows: number,
	rowsPerSemitone: number,
	sampleRate: number,
	hop: number,
	gamma: number
): Uint8Array {
	// The song's typical strong value, from a subsample (the full array can
	// be millions long).
	const stride = Math.max(1, Math.floor(v.length / 200000));
	const sample: number[] = [];
	for (let i = 0; i < v.length; i += stride) if (v[i] > 0) sample.push(v[i]);
	const top = sample.length ? quantile(Float32Array.from(sample), TOP_QUANTILE) : 1;
	const floor = NORM_FLOOR * top;

	// Strongest value per semitone block, then nearby in time.
	const blocks = Math.ceil(rows / rowsPerSemitone);
	const blockTop = new Float32Array(frames * blocks);
	for (let g = 0; g < frames; g++) {
		for (let r = 0; r < rows; r++) {
			const i = g * blocks + Math.floor(r / rowsPerSemitone);
			if (v[g * rows + r] > blockTop[i]) blockTop[i] = v[g * rows + r];
		}
	}
	const W = Math.max(1, Math.round((NORM_SECONDS * sampleRate) / hop));
	const col = new Float32Array(frames);
	for (let bl = 0; bl < blocks; bl++) {
		for (let g = 0; g < frames; g++) col[g] = blockTop[g * blocks + bl];
		const m = slidingMax(col, W, W);
		for (let g = 0; g < frames; g++) blockTop[g * blocks + bl] = m[g];
	}

	const norm = new Float32Array(blocks);
	const data = new Uint8Array(frames * rows);
	for (let g = 0; g < frames; g++) {
		// … and nearby in pitch.
		for (let bl = 0; bl < blocks; bl++) {
			let m = floor;
			const lo = Math.max(0, bl - REGION_SEMITONES);
			const hi = Math.min(blocks - 1, bl + REGION_SEMITONES);
			for (let q = lo; q <= hi; q++) if (blockTop[g * blocks + q] > m) m = blockTop[g * blocks + q];
			norm[bl] = m * NORM_WHITE;
		}
		const base = g * rows;
		for (let r = 0; r < rows; r++) {
			const t = Math.pow(v[base + r] / norm[Math.floor(r / rowsPerSemitone)], gamma);
			data[base + r] = t >= 1 ? 255 : Math.round(t * 255);
		}
	}
	return data;
}

// Largest of v[i - back .. i + fwd] for every i (monotonic queue, O(n)).
function slidingMax(v: Float32Array, back: number, fwd: number): Float32Array {
	const n = v.length;
	const res = new Float32Array(n);
	const q = new Int32Array(n);
	let head = 0;
	let tail = 0;
	let next = 0; // next index to add
	for (let i = 0; i < n; i++) {
		const end = Math.min(n - 1, i + fwd);
		while (next <= end) {
			while (tail > head && v[q[tail - 1]] <= v[next]) tail--;
			q[tail++] = next++;
		}
		while (q[head] < i - back) head++;
		res[i] = v[q[head]];
	}
	return res;
}

// q-quantile of `v` (sorts it in place).
function quantile(v: Float32Array, q: number): number {
	v.sort();
	return v[Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))))];
}
