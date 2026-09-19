// A tiny preview synth for the tab. Not a realistic guitar — just enough tone
// that you can hear pitch, timing, and the articulations we detect (bends,
// slides, vibrato). One AudioContext, one master gain, and per-note oscillator
// voices with detune curves scheduled up-front for pitch modulation.
//
// Design:
//   - Play from `fromTime` seconds through the tab's end (or until stop()).
//   - Notes are scheduled ahead using ctx.currentTime as the master clock.
//   - The consumer polls `currentSongTime()` to sync a visual playhead.

import type { Articulation, Tab, TabNote } from '../tab/types';

export type SynthOptions = {
	masterVolume: number; // 0..1
	vibratoDepthCents: number;
	vibratoRateHz: number;
	// If true, notes with a slide/bend get their entire duration used for the
	// pitch ramp. Otherwise, ramps span a fraction of the note.
	fullDurationPitchRamp: boolean;
	metronomeEnabled: boolean;
	metronomeVolume: number; // 0..1
};

export const DEFAULT_SYNTH_OPTIONS: SynthOptions = {
	masterVolume: 0.25,
	vibratoDepthCents: 30,
	vibratoRateHz: 5.5,
	fullDurationPitchRamp: true,
	metronomeEnabled: false,
	metronomeVolume: 0.35
};

type Voice = {
	osc: OscillatorNode;
	gain: GainNode;
	lfo?: OscillatorNode;
	lfoGain?: GainNode;
	endsAtCtxTime: number;
};

export class Synth {
	private ctx: AudioContext | null = null;
	private master: GainNode | null = null;
	private voices: Voice[] = [];
	private playAnchor: { ctxTime: number; songTime: number } | null = null;
	options: SynthOptions;

	constructor(options: Partial<SynthOptions> = {}) {
		this.options = { ...DEFAULT_SYNTH_OPTIONS, ...options };
	}

	private ensureCtx(): { ctx: AudioContext; master: GainNode } {
		if (!this.ctx) {
			const Ctx =
				typeof window !== 'undefined'
					? (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)
					: null;
			if (!Ctx) throw new Error('Web Audio API not supported in this environment.');
			this.ctx = new Ctx();
			this.master = this.ctx.createGain();
			this.master.gain.value = this.options.masterVolume;
			this.master.connect(this.ctx.destination);
		}
		return { ctx: this.ctx, master: this.master! };
	}

	setVolume(v: number): void {
		this.options.masterVolume = v;
		if (this.master) this.master.gain.value = v;
	}

	setMetronome(enabled: boolean, volume: number): void {
		this.options.metronomeEnabled = enabled;
		this.options.metronomeVolume = volume;
	}

	/** Schedule the tab starting at `fromSongTime` (seconds into the song). */
	play(tab: Tab, fromSongTime: number): void {
		const { ctx, master } = this.ensureCtx();
		if (ctx.state === 'suspended') void ctx.resume();
		this.stop();

		// No pre-roll: start playback immediately so `currentSongTime()` and the
		// video overlay stay tightly synced. Web Audio handles "start at now"
		// fine for typical note densities.
		const ctxStart = ctx.currentTime;
		this.playAnchor = { ctxTime: ctxStart, songTime: fromSongTime };

		for (const n of tab.notes) {
			if (n.time + n.duration < fromSongTime) continue;
			const noteCtxStart = ctxStart + Math.max(0, n.time - fromSongTime);
			const noteCtxEnd = ctxStart + (n.time - fromSongTime) + Math.max(n.duration, 0.05);
			this.scheduleVoice(ctx, master, n, noteCtxStart, noteCtxEnd);
		}

		if (this.options.metronomeEnabled) {
			this.scheduleMetronome(ctx, master, tab, fromSongTime, ctxStart);
		}
	}

	private scheduleMetronome(
		ctx: AudioContext,
		master: GainNode,
		tab: Tab,
		fromSongTime: number,
		ctxStart: number
	): void {
		const beatsPerBar = tab.timeSignature[0];
		if (beatsPerBar <= 0) return;
		const secondsPerBeat = tab.secondsPerBar / beatsPerBar;
		if (secondsPerBeat <= 0) return;

		const firstBeatIndex = Math.max(0, Math.ceil(fromSongTime / secondsPerBeat - 1e-6));
		const lastBeatIndex = Math.floor(tab.durationSec / secondsPerBeat);
		for (let i = firstBeatIndex; i <= lastBeatIndex; i++) {
			const songT = i * secondsPerBeat;
			if (songT < fromSongTime) continue;
			const ctxT = ctxStart + (songT - fromSongTime);
			this.scheduleClick(ctx, master, ctxT, i % beatsPerBar === 0);
		}
	}

	private scheduleClick(
		ctx: AudioContext,
		master: GainNode,
		ctxTime: number,
		isDownbeat: boolean
	): void {
		const osc = ctx.createOscillator();
		osc.type = 'square';
		osc.frequency.value = isDownbeat ? 1800 : 1200;
		const gain = ctx.createGain();
		const peak = this.options.metronomeVolume * (isDownbeat ? 1 : 0.7);
		gain.gain.setValueAtTime(0, ctxTime);
		gain.gain.linearRampToValueAtTime(peak, ctxTime + 0.002);
		gain.gain.exponentialRampToValueAtTime(0.001, ctxTime + 0.06);
		osc.connect(gain);
		gain.connect(master);
		osc.start(ctxTime);
		osc.stop(ctxTime + 0.08);
		this.voices.push({ osc, gain, endsAtCtxTime: ctxTime + 0.08 });
	}

	stop(): void {
		if (!this.ctx) return;
		const now = this.ctx.currentTime;
		for (const v of this.voices) {
			try {
				v.gain.gain.cancelScheduledValues(now);
				v.gain.gain.setValueAtTime(v.gain.gain.value, now);
				v.gain.gain.linearRampToValueAtTime(0, now + 0.02);
				v.osc.stop(now + 0.03);
				v.lfo?.stop(now + 0.03);
			} catch {
				// osc may already be stopped; ignore
			}
		}
		this.voices = [];
		this.playAnchor = null;
	}

	/** The song time corresponding to the current audio-clock instant. */
	currentSongTime(): number | null {
		if (!this.ctx || !this.playAnchor) return null;
		return this.playAnchor.songTime + (this.ctx.currentTime - this.playAnchor.ctxTime);
	}

	dispose(): void {
		this.stop();
		this.ctx?.close();
		this.ctx = null;
		this.master = null;
	}

	private scheduleVoice(
		ctx: AudioContext,
		master: GainNode,
		note: TabNote,
		startCtxTime: number,
		endCtxTime: number
	): void {
		const arts = note.articulations ?? [];
		const has = (kind: Articulation['kind']) => arts.some((a) => a.kind === kind);

		// Harmonic sounds one octave (or 12+N semitones) above the fretted note.
		const harmonic = arts.find((a) => a.kind === 'harmonic');
		const baseMidi = note.midi + (harmonic ? harmonic.semitones : 0);
		const baseFreq = midiToFreq(baseMidi);

		const osc = ctx.createOscillator();
		osc.type = harmonic ? 'sine' : 'triangle';
		osc.frequency.value = baseFreq;

		// Pitch modulation via detune (cents).
		this.schedulePitchCurve(osc, arts, startCtxTime, endCtxTime);

		const gain = ctx.createGain();
		this.scheduleAmplitudeEnvelope(gain, note, arts, startCtxTime, endCtxTime);

		osc.connect(gain);
		gain.connect(master);

		let lfo: OscillatorNode | undefined;
		let lfoGain: GainNode | undefined;
		if (has('vibrato')) {
			lfo = ctx.createOscillator();
			lfo.frequency.value = this.options.vibratoRateHz;
			lfoGain = ctx.createGain();
			lfoGain.gain.value = this.options.vibratoDepthCents;
			lfo.connect(lfoGain);
			lfoGain.connect(osc.detune);
			lfo.start(startCtxTime);
			lfo.stop(endCtxTime + 0.05);
		}

		osc.start(startCtxTime);
		osc.stop(endCtxTime + 0.05);

		this.voices.push({ osc, gain, lfo, lfoGain, endsAtCtxTime: endCtxTime });
	}

	private schedulePitchCurve(
		osc: OscillatorNode,
		arts: Articulation[],
		start: number,
		end: number
	): void {
		const bend = arts.find((a) => a.kind === 'bend');
		const bendRelease = arts.find((a) => a.kind === 'bendRelease');
		const slideUp = arts.find((a) => a.kind === 'slideUp');
		const slideDown = arts.find((a) => a.kind === 'slideDown');
		const graceSlide = arts.find((a) => a.kind === 'graceSlide');
		const dur = end - start;
		const rampDur = this.options.fullDurationPitchRamp ? dur : Math.min(dur, 0.25);
		if (bend) {
			osc.detune.setValueAtTime(0, start);
			osc.detune.linearRampToValueAtTime(bend.semitones * 100, start + rampDur);
		} else if (bendRelease) {
			// Up to peak by 1/3 of the note, hold briefly, back to 0 by end.
			const peak = bendRelease.semitones * 100;
			osc.detune.setValueAtTime(0, start);
			osc.detune.linearRampToValueAtTime(peak, start + dur * 0.33);
			osc.detune.setValueAtTime(peak, start + dur * 0.55);
			osc.detune.linearRampToValueAtTime(0, end);
		} else if (graceSlide) {
			// Start below, dip up to the notated fret briefly, return below.
			const low = -graceSlide.fromSemitones * 100;
			osc.detune.setValueAtTime(low, start);
			osc.detune.linearRampToValueAtTime(0, start + dur * 0.33);
			osc.detune.setValueAtTime(0, start + dur * 0.55);
			osc.detune.linearRampToValueAtTime(low, end);
		} else if (slideUp) {
			osc.detune.setValueAtTime(-slideUp.fromSemitones * 100, start);
			osc.detune.linearRampToValueAtTime(0, start + rampDur);
		} else if (slideDown) {
			osc.detune.setValueAtTime(slideDown.fromSemitones * 100, start);
			osc.detune.linearRampToValueAtTime(0, start + rampDur);
		}
	}

	private scheduleAmplitudeEnvelope(
		gain: GainNode,
		note: TabNote,
		arts: Articulation[],
		start: number,
		end: number
	): void {
		const ghost = arts.some((a) => a.kind === 'ghost');
		const palmMute = arts.some((a) => a.kind === 'palmMute');

		const dur = Math.max(0.05, end - start);
		// Snappy onset — 2 ms is short enough to feel plucked but avoids the DC
		// pop you'd get from a hard step. Release is long enough to prevent a
		// tail-end click without adding a pad-like fade.
		const attack = Math.min(0.002, dur * 0.4);
		const release = Math.min(0.02, dur * 0.4);
		const sustainLevel = 0.35 * note.velocity * (ghost ? 0.25 : palmMute ? 0.55 : 1);

		gain.gain.setValueAtTime(0, start);
		gain.gain.linearRampToValueAtTime(sustainLevel, start + attack);
		gain.gain.setValueAtTime(sustainLevel, Math.max(start + attack, end - release));
		gain.gain.linearRampToValueAtTime(0, end);
	}
}

function midiToFreq(midi: number): number {
	return 440 * Math.pow(2, (midi - 69) / 12);
}
