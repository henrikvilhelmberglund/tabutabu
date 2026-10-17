// Finding the reference offset (reference time where tab time 0 — the first
// bar line — falls) from the audio: songs nearly always start on a downbeat,
// so it's the moment of the first clear hit.
//
// Onsets are found with spectral flux (how much louder each frequency got
// since the previous frame), which picks out drum hits and pick attacks
// rather than slow swells. The first frame well above the song's typical
// onset level starts the search; the strongest onset right after it is the
// hit, refined between frames and corrected for the analysis window (an
// attack registers as it enters the window, ~FFT − HOP samples early).

const FFT = 1024;
const HOP = 128;
// "Clear hit": this share of the song's loud onset level (95th percentile).
const START_SHARE = 0.3;
// The hit's peak is looked for this long after the first crossing (s).
const PEAK_WINDOW = 0.06;

export function findSongStart(samples: Float32Array, sampleRate: number): number | null {
	const flux = spectralFlux(samples);
	if (flux.length < 16) return null;
	const frameSec = HOP / sampleRate;
	const sorted = Float32Array.from(flux).sort();
	const loud = sorted[Math.floor(sorted.length * 0.95)];
	if (!(loud > 0)) return null;
	const first = flux.findIndex((v) => v > loud * START_SHARE);
	if (first < 0) return null;
	// Strongest frame shortly after, then the peak between frames (parabola).
	let peak = first;
	const last = Math.min(flux.length - 2, first + Math.round(PEAK_WINDOW / frameSec));
	for (let i = first; i <= last; i++) if (flux[i] > flux[peak]) peak = i;
	let frac = 0;
	if (peak > 0 && peak < flux.length - 1) {
		const a = flux[peak - 1];
		const b = flux[peak];
		const c = flux[peak + 1];
		const den = a - 2 * b + c;
		if (den < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
	}
	return Math.max(0, ((peak + frac) * HOP + FFT - HOP) / sampleRate);
}

function spectralFlux(samples: Float32Array): Float32Array {
	const frames = Math.max(0, Math.floor((samples.length - FFT) / HOP) + 1);
	const flux = new Float32Array(frames);
	const half = FFT / 2;
	const win = new Float32Array(FFT);
	for (let i = 0; i < FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT);
	const re = new Float32Array(FFT);
	const im = new Float32Array(FFT);
	let prev = new Float32Array(half);
	let cur = new Float32Array(half);
	const fft = makeFft(FFT);
	for (let f = 0; f < frames; f++) {
		const o = f * HOP;
		for (let i = 0; i < FFT; i++) {
			re[i] = samples[o + i] * win[i];
			im[i] = 0;
		}
		fft(re, im);
		let s = 0;
		for (let k = 1; k < half; k++) {
			// Log magnitude: quiet and loud parts both show their attacks.
			const m = Math.log1p(100 * Math.hypot(re[k], im[k]));
			cur[k] = m;
			if (m > prev[k]) s += m - prev[k];
		}
		flux[f] = s;
		[prev, cur] = [cur, prev];
	}
	return flux;
}

// In-place radix-2 FFT of size n.
function makeFft(n: number) {
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
	return (re: Float32Array, im: Float32Array) => {
		for (let i = 0; i < n; i++) {
			const j = rev[i];
			if (j > i) {
				[re[i], re[j]] = [re[j], re[i]];
				[im[i], im[j]] = [im[j], im[i]];
			}
		}
		for (let size = 2; size <= n; size <<= 1) {
			const h = size >> 1;
			const step = n / size;
			for (let i = 0; i < n; i += size) {
				for (let j = 0; j < h; j++) {
					const wr = cos[j * step];
					const wi = sin[j * step];
					const a = i + j;
					const b = a + h;
					const tr = re[b] * wr - im[b] * wi;
					const ti = re[b] * wi + im[b] * wr;
					re[b] = re[a] - tr;
					im[b] = im[a] - ti;
					re[a] += tr;
					im[a] += ti;
				}
			}
		}
	};
}
