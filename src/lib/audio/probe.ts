// Pitch probe: plays the reference audio through narrow band-passes around
// one pitch (optionally with its harmonics 2× … 6×), so a single note can
// be picked out of the mix by ear — or, for a separated instrument, the
// whole stem as it is. Used by press-and-hold on the spectrogram.

import { decodeReference, type SpectroChannel } from './spectrogram';
import { ChannelRouter, type ListenChannel } from './channels';

// Band-pass Q ≈ centre / width: 17 is about a semitone wide. Three in a row
// make the sides steep (the neighbouring semitone is ~20 dB down).
const BAND_Q = 17;
const STAGES = 3;
// A one-semitone slice of a full mix is quiet; bring it up by a fixed
// amount so loud notes stay louder than the background. (The limiter after
// it only catches the odd peak before clipping — it must not level things
// out, or every band sounds the same.)
const MAKEUP_GAIN = 8;
// Harmonics passed along with the pitch itself (up to 6×), each at this
// share of the fundamental band's makeup.
const HARMONICS = 6;
const HARMONIC_GAIN = 0.6;

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

type Live = {
	src: AudioBufferSourceNode;
	nodes: AudioNode[];
	// Each filter with the harmonic it's tuned to.
	filters: Array<{ f: BiquadFilterNode; h: number }>;
	startedAt: number;
	from: number;
};

export class PitchProbe {
	private ctx: AudioContext | null = null;
	private key = '';
	private decoded: Promise<{ audio: AudioBuffer; channels: number }> | null = null;
	private live: Live | null = null;
	// Whole-file playback (a stem, unfiltered): a plain audio element, full
	// quality, no decoding up front.
	private whole: { key: string; url: string; el: HTMLAudioElement } | null = null;
	private wholePlaying = false;
	// Bumped by every start/stop, so a start still waiting for the decode
	// doesn't play after it was cancelled.
	private token = 0;

	// Decode the reference `file` (identified by `key`) unless already done.
	load(key: string, file: ArrayBuffer) {
		if (this.key !== key || !this.decoded) {
			this.stop();
			this.key = key;
			this.decoded = decodeReference(file);
			// A failed decode can be retried on the next load.
			this.decoded.catch(() => {
				if (this.key === key) this.decoded = null;
			});
		}
		return this.decoded;
	}

	// Forget the decoded reference (it was replaced or removed).
	forget() {
		this.stop();
		this.key = '';
		this.decoded = null;
		if (this.whole) {
			URL.revokeObjectURL(this.whole.url);
			this.whole = null;
		}
	}

	// Play `file` (identified by `key`) as it is (or one channel of it),
	// from `refTime`.
	async playWhole(
		key: string,
		file: ArrayBuffer,
		type: string,
		refTime: number,
		volume: number,
		channel: ListenChannel = 'both'
	) {
		const token = ++this.token;
		this.stop(false);
		if (this.whole?.key !== key) {
			if (this.whole) URL.revokeObjectURL(this.whole.url);
			const url = URL.createObjectURL(new Blob([file], { type }));
			this.whole = { key, url, el: new Audio(url) };
		}
		const el = this.whole.el;
		if (channel !== 'both' || ChannelRouter.existing(el)) {
			const router = ChannelRouter.for(el);
			router.setChannel(channel);
			router.setLevel(volume);
			ChannelRouter.resume();
		} else {
			el.volume = Math.max(0, Math.min(1, volume));
		}
		el.currentTime = Math.max(0, refTime);
		await el.play();
		if (token !== this.token) el.pause();
		else this.wholePlaying = true;
	}

	// Play the reference from `refTime` (seconds) filtered to `midi`'s band
	// (plus its harmonics' bands with `harmonics`): the whole mix, or only
	// its sides (left minus right).
	async start(
		key: string,
		file: ArrayBuffer,
		refTime: number,
		midi: number,
		channel: SpectroChannel,
		volume: number,
		harmonics: boolean
	) {
		const token = ++this.token;
		this.stop(false);
		const { audio } = await this.load(key, file);
		if (token !== this.token) return;
		const ctx = (this.ctx ??= new AudioContext());
		if (ctx.state === 'suspended') await ctx.resume();
		if (token !== this.token) return;

		const src = ctx.createBufferSource();
		src.buffer = audio;
		const split = ctx.createChannelSplitter(2);
		const left = ctx.createGain();
		const right = ctx.createGain();
		const [gl, gr] =
			channel === 'left'
				? [1, 0]
				: channel === 'right'
					? [0, 1]
					: channel === 'sides'
						? [0.5, -0.5]
						: [0.5, 0.5];
		left.gain.value = gl;
		right.gain.value = gr;
		const sum = ctx.createGain();
		sum.channelCount = 1;
		sum.channelCountMode = 'explicit';
		src.connect(split);
		split.connect(left, 0);
		split.connect(right, 1);
		left.connect(sum);
		right.connect(sum);
		const filters: Array<{ f: BiquadFilterNode; h: number }> = [];
		const bands: AudioNode[] = [];
		const nyquist = audio.sampleRate / 2;
		let count = 1;
		while (harmonics && count < HARMONICS && hz(midi) * (count + 1) <= nyquist * 0.9) count++;
		// More bands add up louder; keep both probe modes at a similar level.
		const bandPower = 1 + (count - 1) * HARMONIC_GAIN * HARMONIC_GAIN;
		const gain = ctx.createGain();
		gain.gain.value = (MAKEUP_GAIN * volume) / Math.sqrt(bandPower);
		for (let h = 1; h <= count; h++) {
			// One band-pass chain per harmonic, summed into `gain`.
			let node: AudioNode = sum;
			for (let i = 0; i < STAGES; i++) {
				const f = ctx.createBiquadFilter();
				f.type = 'bandpass';
				f.Q.value = BAND_Q;
				f.frequency.value = hz(midi) * h;
				node.connect(f);
				node = f;
				filters.push({ f, h });
			}
			const level = ctx.createGain();
			level.gain.value = h === 1 ? 1 : HARMONIC_GAIN;
			node.connect(level);
			level.connect(gain);
			bands.push(level);
		}
		const limiter = ctx.createDynamicsCompressor();
		limiter.threshold.value = -3;
		limiter.knee.value = 0;
		limiter.ratio.value = 20;
		limiter.attack.value = 0.001;
		limiter.release.value = 0.05;
		gain.connect(limiter);
		limiter.connect(ctx.destination);

		const from = Math.max(0, Math.min(audio.duration, refTime));
		src.start(0, from);
		this.live = {
			src,
			nodes: [split, left, right, sum, ...filters.map((x) => x.f), ...bands, gain, limiter],
			filters,
			startedAt: ctx.currentTime,
			from
		};
	}

	// Move the band (glides briefly, no click).
	setPitch(midi: number) {
		if (!this.live || !this.ctx) return;
		for (const { f, h } of this.live.filters) {
			f.frequency.setTargetAtTime(
				Math.min(hz(midi) * h, this.ctx.sampleRate / 2),
				this.ctx.currentTime,
				0.01
			);
		}
	}

	stop(cancelPending = true) {
		if (cancelPending) this.token++;
		if (this.wholePlaying && this.whole) this.whole.el.pause();
		this.wholePlaying = false;
		if (!this.live) return;
		const { src, nodes } = this.live;
		this.live = null;
		try {
			src.stop();
		} catch {
			// never started
		}
		src.disconnect();
		for (const n of nodes) n.disconnect();
	}

	// Where in the reference the probe is playing (seconds), or null.
	position(): number | null {
		if (this.wholePlaying && this.whole) return this.whole.el.currentTime;
		if (!this.live || !this.ctx) return null;
		return this.live.from + (this.ctx.currentTime - this.live.startedAt);
	}
}
