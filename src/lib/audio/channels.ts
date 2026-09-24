// Listening to one side of a stereo recording: both channels as they are,
// or only the left / right channel in mono (on both speakers) — e.g. to hear
// one of two hard-panned guitars on its own.
//
// A media element is routed through Web Audio for this the first time it's
// needed; it stays routed afterwards (browsers don't allow undoing it), and
// its level is then set here instead of through the element's volume.

export type ListenChannel = 'both' | 'left' | 'right';

let ctx: AudioContext | null = null;
const routers = new WeakMap<HTMLMediaElement, ChannelRouter>();

export class ChannelRouter {
	// gains[input * 2 + output]: input channel → output channel.
	private gains: GainNode[];
	private level: GainNode;

	private constructor(el: HTMLMediaElement) {
		const c = (ctx ??= new AudioContext());
		const src = c.createMediaElementSource(el);
		// Make mono sources two identical channels, so "right" isn't silent.
		const stereo = c.createGain();
		stereo.channelCount = 2;
		stereo.channelCountMode = 'explicit';
		stereo.channelInterpretation = 'speakers';
		const split = c.createChannelSplitter(2);
		const merge = c.createChannelMerger(2);
		src.connect(stereo);
		stereo.connect(split);
		this.gains = [0, 1, 2, 3].map((k) => {
			const g = c.createGain();
			split.connect(g, k >> 1);
			g.connect(merge, 0, k & 1);
			return g;
		});
		this.level = c.createGain();
		merge.connect(this.level);
		this.level.connect(c.destination);
		el.volume = 1;
		this.setChannel('both');
	}

	// The element's router, creating it if needed.
	static for(el: HTMLMediaElement): ChannelRouter {
		let r = routers.get(el);
		if (!r) {
			r = new ChannelRouter(el);
			routers.set(el, r);
		}
		return r;
	}

	// The element's router if it has one already.
	static existing(el: HTMLMediaElement): ChannelRouter | undefined {
		return routers.get(el);
	}

	setChannel(ch: ListenChannel) {
		const m = ch === 'both' ? [1, 0, 0, 1] : ch === 'left' ? [1, 1, 0, 0] : [0, 0, 1, 1];
		m.forEach((v, k) => (this.gains[k].gain.value = v));
	}

	// 0..1 (0 = muted).
	setLevel(v: number) {
		this.level.gain.value = Math.max(0, Math.min(1, v));
	}

	// The shared context starts suspended until the page has had a click or
	// key press; call when playback starts.
	static resume() {
		if (ctx?.state === 'suspended') void ctx.resume();
	}
}
