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
import { barAt, barInfo } from '../tab/tempo';

export type SynthOptions = {
	masterVolume: number; // 0..1
	vibratoDepthCents: number;
	vibratoRateHz: number;
	metronomeEnabled: boolean;
	metronomeVolume: number; // 0..1
};

export const DEFAULT_SYNTH_OPTIONS: SynthOptions = {
	masterVolume: 0.25,
	vibratoDepthCents: 30,
	vibratoRateHz: 5.5,
	metronomeEnabled: false,
	metronomeVolume: 0.35
};

type Voice = {
	osc: OscillatorNode;
	gain: GainNode;
	// Pick slide's noise source.
	noise?: AudioBufferSourceNode;
	lfo?: OscillatorNode;
	lfoGain?: GainNode;
	endsAtCtxTime: number;
};

export class Synth {
	private ctx: AudioContext | null = null;
	private master: GainNode | null = null;
	private voices: Voice[] = [];
	// Voices spawned by `previewNote()` are tracked separately so we can kill
	// them independently of the main scheduled playback (e.g. when the user
	// releases the pointer that started a drag preview).
	private previewVoices: Voice[] = [];
	private playAnchor: { ctxTime: number; songTime: number } | null = null;
	options: SynthOptions;

	constructor(options: Partial<SynthOptions> = {}) {
		this.options = { ...DEFAULT_SYNTH_OPTIONS, ...options };
	}

	private ensureCtx(): { ctx: AudioContext; master: GainNode } {
		if (!this.ctx) {
			const Ctx =
				typeof window !== 'undefined'
					? (window.AudioContext ??
						(window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)
					: null;
			if (!Ctx) throw new Error('Web Audio API not supported in this environment.');
			this.ctx = new Ctx();
			this.master = this.ctx.createGain();
			this.master.gain.value = this.options.masterVolume;
			// Low-pass filter on the master bus: softens the sharp edges
			// of the square-wave voices and gives the overall tone a
			// mellower guitar feel without killing brightness.
			const lpf = this.ctx.createBiquadFilter();
			lpf.type = 'lowpass';
			lpf.frequency.value = 5200;
			lpf.Q.value = 0.7;
			this.master.connect(lpf);
			lpf.connect(this.ctx.destination);
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

	/**
	 * Schedule the tab starting at `fromSongTime` (seconds into the song).
	 * Optionally cap the schedule at `toSongTime` — used by author-mode
	 * bar/beat playback so we don't queue up notes that would fire outside
	 * the focus window and then get cut mid-attack by the rAF stop check.
	 */
	// How long playback runs (song seconds) — can be past the tab's own end
	// (e.g. a longer reference); the metronome keeps clicking until then.
	private playbackEnd = 0;
	setPlaybackEnd(seconds: number): void {
		this.playbackEnd = seconds;
	}

	play(tab: Tab, fromSongTime: number, toSongTime?: number): void {
		const { ctx, master } = this.ensureCtx();
		if (ctx.state === 'suspended') void ctx.resume();
		this.stop();

		// Ramp the master gain from 0 to full over ~30 ms so the first
		// oscillator doesn't hit a hard discontinuity against a full-
		// volume bus (that was the "click" on playback start). Do NOT
		// apply a note-scheduling lookahead — `currentSongTime()` uses the
		// difference between `playAnchor.ctxTime` and `ctx.currentTime`,
		// so shifting `playAnchor` into the future makes the visible
		// playhead briefly display a time BEFORE `fromSongTime`, which
		// looked like the previous bar flashing on screen.
		const ctxStart = ctx.currentTime;
		master.gain.cancelScheduledValues(ctxStart);
		master.gain.setValueAtTime(0, ctxStart);
		master.gain.linearRampToValueAtTime(this.options.masterVolume, ctxStart + 0.03);
		this.playAnchor = { ctxTime: ctxStart, songTime: fromSongTime };

		// Precompute two "next note" maps so the scheduling loop can cut
		// each note at the appropriate follow-up:
		//   - nextGlobalAfter[id] = time of the next PICKED note that
		//     starts STRICTLY LATER on ANY string. Simultaneous notes
		//     (chords, strums) share a start time and don't cut each other.
		//     Hammer-ons, pull-offs and taps are fretting-hand only, so
		//     they don't stop other strings (a held chord keeps ringing
		//     under a hammer-on melody).
		//   - nextOnStringAfter[id] = time of the next note on the SAME
		//     string — re-fretting a string always cuts what it was playing.
		const EPS = 0.005; // 5 ms — anything closer is treated as simultaneous
		const isLegato = (n: TabNote) =>
			n.articulations?.some(
				(a) => a.kind === 'hammerOn' || a.kind === 'pullOff' || a.kind === 'tap'
			) ?? false;
		const nextGlobalAfter = new Map<string, number>();
		// Next note WITHOUT let ring (any string): it stops a let-ring note.
		const nextPlainAfter = new Map<string, number>();
		const isLetRingNote = (n: TabNote) =>
			n.articulations?.some((a) => a.kind === 'letRing') ?? false;
		const nextOnStringAfter = new Map<string, number>();
		const seenNextByString = new Map<number, number>();
		// Walk backwards; for each note find the earliest STRICTLY-later note.
		for (let i = tab.notes.length - 1; i >= 0; i--) {
			const n = tab.notes[i];
			// Same-string: next same-string note whose time is later.
			const sameNext = seenNextByString.get(n.stringIndex);
			if (sameNext !== undefined) nextOnStringAfter.set(n.id, sameNext);
			seenNextByString.set(n.stringIndex, n.time);
			// Global: scan forwards from i+1 for the first picked note whose
			// time exceeds n.time by more than EPS. Usually the very next
			// entry.
			for (let j = i + 1; j < tab.notes.length; j++) {
				const m = tab.notes[j];
				if (m.time > n.time + EPS && !isLegato(m)) {
					nextGlobalAfter.set(n.id, m.time);
					break;
				}
			}
			if (isLetRingNote(n)) {
				for (let j = i + 1; j < tab.notes.length; j++) {
					const m = tab.notes[j];
					if (m.time > n.time + EPS && !isLetRingNote(m)) {
						nextPlainAfter.set(n.id, m.time);
						break;
					}
				}
			}
		}

		// How many notes start together with each note (a chord), for
		// level scaling so a 6-string chord isn't six times as loud.
		const chordSize = new Map<string, number>();
		for (let i = 0; i < tab.notes.length;) {
			let j = i + 1;
			while (j < tab.notes.length && tab.notes[j].time - tab.notes[i].time <= EPS) j++;
			for (let k = i; k < j; k++) chordSize.set(tab.notes[k].id, j - i);
			i = j;
		}

		for (const n of tab.notes) {
			// Notes that started BEFORE the playback window are skipped —
			// otherwise their attack fires immediately at t=0 and you hear
			// the pluck of a previous-bar note leak into the new one. Except
			// let-ring notes still ringing then: those join in, already
			// sounding (see below).
			const isLetRing = n.articulations?.some((a) => a.kind === 'letRing');
			const before = n.time < fromSongTime - 1e-6;
			if (before && !isLetRing) continue;
			// Skip notes that would start AT or AFTER the playback stop
			// (author-mode bar/beat scoping). Without this, a note at the
			// very start of the next bar fires and gets cancelled 10-20 ms
			// later by the rAF stop check, producing a brief audible pluck.
			if (toSongTime !== undefined && n.time >= toSongTime - 1e-6) continue;
			const noteCtxStart = ctxStart + Math.max(0, n.time - fromSongTime);
			// Cap logic — ignores the note's declared duration on purpose;
			// the user's mental model is "ring until something else
			// happens":
			//   Normal notes:
			//     ring until the next picked note (any string), the next
			//     note on the same string, or the bar end — whichever
			//     comes first.
			//   Let-ring notes:
			//     ring until the next same-string note, the next note
			//     without let ring (any string), or a natural string-decay
			//     cap (~5 s) — whichever comes first.
			let rawEndSong: number;
			const bar = barAt(tab, n.time + 1e-6);
			const barEnd = bar.start + bar.length;
			if (n.articulations?.some((a) => a.kind === 'pickSlide')) {
				// A pick slide scrapes on to the end of its bar.
				rawEndSong = barEnd;
			} else if (isLetRing) {
				// Rings until the string is played again, or a note without
				// let ring is played on any string (that's how a let ring is
				// stopped), or the natural ~5 s decay.
				rawEndSong = Math.min(
					nextOnStringAfter.get(n.id) ?? Infinity,
					nextPlainAfter.get(n.id) ?? Infinity,
					n.time + 5
				);
			} else {
				const nextGlobal = nextGlobalAfter.get(n.id) ?? Infinity;
				const nextSame = nextOnStringAfter.get(n.id) ?? Infinity;
				rawEndSong = Math.min(nextGlobal, nextSame, barEnd);
			}
			// Staccato keeps to its written length; a dead note is a click.
			if (n.articulations?.some((a) => a.kind === 'staccato'))
				rawEndSong = Math.min(rawEndSong, n.time + n.duration);
			if (n.articulations?.some((a) => a.kind === 'dead'))
				rawEndSong = Math.min(rawEndSong, n.time + 0.06);
			const noteCtxEnd = ctxStart + (rawEndSong - fromSongTime);
			if (before) {
				// A let ring from before the window, still ringing: it fades in
				// at the start (no fresh pluck) and rings on by the same rules.
				// Slides into it already happened, so they're left out.
				if (rawEndSong <= fromSongTime + 0.05) continue;
				if (n.articulations.some((a) => a.kind === 'pickSlide')) continue;
				const ringing: TabNote = {
					...n,
					articulations: n.articulations.filter(
						(a) => a.kind !== 'slideUp' && a.kind !== 'slideDown' && a.kind !== 'graceSlide'
					)
				};
				this.scheduleVoice(
					ctx,
					master,
					ringing,
					ctxStart,
					noteCtxEnd,
					chordLevel(chordSize.get(n.id) ?? 1),
					true,
					60 / bar.bpm
				);
				continue;
			}
			const tremolo = n.articulations?.find((a) => a.kind === 'tremolo');
			if (tremolo?.kind === 'tremolo' && tremolo.rate > 0) {
				// Tremolo picking: re-picked every 1/rate note for as long
				// as it rings.
				const step = ((60 / bar.bpm) * 4) / tremolo.rate;
				const end = Math.max(noteCtxStart + 0.05, noteCtxEnd);
				const repick: TabNote = {
					...n,
					articulations: n.articulations.filter(
						(a) =>
							a.kind !== 'tremolo' &&
							a.kind !== 'slideUp' &&
							a.kind !== 'slideDown' &&
							a.kind !== 'graceSlide'
					)
				};
				for (let t = noteCtxStart, i = 0; t < end - step * 0.5; t += step, i++) {
					this.scheduleVoice(
						ctx,
						master,
						i === 0 ? n : repick,
						t,
						Math.min(end, t + step),
						chordLevel(chordSize.get(n.id) ?? 1),
						false,
						60 / bar.bpm
					);
				}
				continue;
			}
			this.scheduleVoice(
				ctx,
				master,
				n,
				noteCtxStart,
				Math.max(noteCtxStart + 0.05, noteCtxEnd),
				chordLevel(chordSize.get(n.id) ?? 1),
				false,
				60 / bar.bpm
			);
		}

		if (this.options.metronomeEnabled) {
			this.scheduleMetronome(ctx, master, tab, fromSongTime, ctxStart, toSongTime);
		}
	}

	private scheduleMetronome(
		ctx: AudioContext,
		master: GainNode,
		tab: Tab,
		fromSongTime: number,
		ctxStart: number,
		toSongTime?: number
	): void {
		const endSong = toSongTime ?? Math.max(tab.durationSec, this.playbackEnd);
		// Every beat of every bar (bars may differ in tempo / time signature).
		for (let b = barAt(tab, fromSongTime).index; ; b++) {
			const bar = barInfo(tab, b);
			if (bar.start > endSong + 1e-6 || bar.beatLength <= 0) break;
			for (let i = 0; i < bar.beats; i++) {
				const songT = bar.start + i * bar.beatLength;
				if (songT < fromSongTime - 1e-6) continue;
				if (songT > endSong + 1e-6) break;
				// Don't click the downbeat of the NEXT bar at the end of a
				// bar/beat preview.
				if (toSongTime !== undefined && songT >= toSongTime - 1e-6) break;
				const ctxT = ctxStart + (songT - fromSongTime);
				this.scheduleClick(ctx, master, ctxT, i === 0);
			}
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

	/**
	 * Play a one-shot preview of one or more notes right now — used by the
	 * authoring tools so the user hears the pitch as soon as they place a
	 * note. Does NOT alter `playAnchor`; the main playhead / video sync
	 * stays put. Any earlier preview is killed first so we don't stack
	 * voices while the user drags through a fret range. Pass an array to
	 * audition a chord (all `time` 0) or an arpeggio (`time` = offset in
	 * seconds from now).
	 */
	previewNote(note: TabNote | TabNote[]): void {
		this.stopPreview();
		const notes = Array.isArray(note) ? note : [note];
		if (notes.length === 0) return;
		const { ctx, master } = this.ensureCtx();
		if (ctx.state === 'suspended') void ctx.resume();
		const start = ctx.currentTime + 0.005;
		// Each note's `time` is its offset from the start of the preview (0
		// for a chord; increasing for an arpeggio). Level scaling counts only
		// the notes that actually sound together.
		const together = new Map<number, number>();
		const slot = (n: TabNote) => Math.round(Math.max(0, n.time) * 1000);
		for (const n of notes) together.set(slot(n), (together.get(slot(n)) ?? 0) + 1);
		for (const n of notes) {
			// Callers pick the length (0.6 s for a chord, one grid step for an
			// arpeggio note); the floor only keeps the envelope click-free.
			const dur = Math.max(0.04, n.duration);
			const at = start + Math.max(0, n.time);
			const voice = this.scheduleVoice(
				ctx,
				master,
				n,
				at,
				at + dur,
				chordLevel(together.get(slot(n)) ?? 1)
			);
			this.previewVoices.push(voice);
		}
	}

	/** Cancel any in-flight preview voices without touching the main playback. */
	stopPreview(): void {
		if (!this.ctx) return;
		const now = this.ctx.currentTime;
		for (const v of this.previewVoices) {
			try {
				v.gain.gain.cancelScheduledValues(now);
				v.gain.gain.setValueAtTime(v.gain.gain.value, now);
				v.gain.gain.linearRampToValueAtTime(0, now + 0.02);
				v.osc.stop(now + 0.03);
				v.lfo?.stop(now + 0.03);
				v.noise?.stop(now + 0.03);
			} catch {
				// osc may already be stopped; ignore
			}
			// Also drop from the main voices list so `stop()` doesn't try to
			// touch it again.
			const i = this.voices.indexOf(v);
			if (i >= 0) this.voices.splice(i, 1);
		}
		this.previewVoices = [];
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
				v.noise?.stop(now + 0.03);
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
		endCtxTime: number,
		// Level multiplier (chordLevel) so chords stay about as loud as
		// single notes.
		level = 1,
		// Already sounding (a let ring carried into the playback window):
		// fade in instead of a plucked attack.
		fadeIn = false,
		// Length of a quarter note here (for trill speed).
		quarterSec = 0.5
	): Voice {
		const arts = note.articulations ?? [];
		const has = (kind: Articulation['kind']) => arts.some((a) => a.kind === kind);
		if (has('pickSlide')) {
			return this.schedulePickSlide(ctx, master, note, startCtxTime, endCtxTime, level);
		}
		if (has('dead')) {
			return this.scheduleDeadNote(ctx, master, note, startCtxTime, level);
		}

		// Harmonic sounds one octave (or 12+N semitones) above the fretted note.
		const harmonic = arts.find((a) => a.kind === 'harmonic');
		const baseMidi = note.midi + (harmonic ? harmonic.semitones : 0);
		const baseFreq = midiToFreq(baseMidi);

		const palmMute = arts.some((a) => a.kind === 'palmMute');
		const osc = ctx.createOscillator();
		// Square (a pulse wave with 50% duty cycle) is the default. Unlike
		// sawtooth, its harmonic series contains ONLY the odd harmonics —
		// no second harmonic (an octave above the fundamental), no fourth
		// (two octaves up), etc. So stacking octave intervals like a power
		// chord's root + octave doesn't produce the muddy beating you get
		// with sawtooth. Harmonic articulations still use a pure sine.
		osc.type = harmonic ? 'sine' : 'square';
		osc.frequency.value = baseFreq;

		// Pitch modulation via detune (cents).
		this.schedulePitchCurve(osc, arts, startCtxTime, endCtxTime, quarterSec);

		const gain = ctx.createGain();
		this.scheduleAmplitudeEnvelope(gain, note, arts, startCtxTime, endCtxTime, level, fadeIn);

		if (palmMute) {
			// Palm mute = damped strings: a low-pass that opens briefly on
			// the pick attack and closes down near the fundamental, so the
			// note keeps its pitch but loses the bright upper harmonics.
			const lpf = ctx.createBiquadFilter();
			lpf.type = 'lowpass';
			lpf.Q.value = 0.9;
			const open = Math.min(baseFreq * 8, 4000);
			const closed = Math.min(baseFreq * 2.2, 900);
			lpf.frequency.setValueAtTime(open, startCtxTime);
			lpf.frequency.exponentialRampToValueAtTime(closed, Math.min(endCtxTime, startCtxTime + 0.08));
			osc.connect(lpf);
			lpf.connect(gain);
		} else {
			osc.connect(gain);
		}
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

		const voice: Voice = { osc, gain, lfo, lfoGain, endsAtCtxTime: endCtxTime };
		this.voices.push(voice);
		return voice;
	}

	// Pick slide: the pick scraped down the wound strings — a noisy, buzzing
	// "zzzeeoww" falling about two octaves from around the note, instead of a
	// picked note, over the whole time it's given (to the end of its bar in
	// playback).
	private schedulePickSlide(
		ctx: AudioContext,
		master: GainNode,
		note: TabNote,
		start: number,
		end: number,
		level: number
	): Voice {
		const stop = start + Math.max(0.12, end - start);
		const f0 = midiToFreq(note.midi);
		// Noise through a resonant band-pass sweeping down.
		const noise = ctx.createBufferSource();
		noise.buffer = this.noiseBuffer(ctx);
		noise.loop = true;
		const band = ctx.createBiquadFilter();
		band.type = 'bandpass';
		band.Q.value = 6;
		band.frequency.setValueAtTime(Math.min(f0 * 6, 5000), start);
		band.frequency.exponentialRampToValueAtTime(Math.max(f0 * 1.5, 120), stop);
		// A buzzy tone falling alongside gives it the pitched sweep.
		const osc = ctx.createOscillator();
		osc.type = 'sawtooth';
		osc.frequency.setValueAtTime(f0 * 2, start);
		osc.frequency.exponentialRampToValueAtTime(f0 * 0.5, stop);
		const buzz = ctx.createGain();
		buzz.gain.value = 0.3;
		const gain = ctx.createGain();
		const peak = 0.6 * note.velocity * level;
		gain.gain.setValueAtTime(0, start);
		gain.gain.linearRampToValueAtTime(peak, start + 0.01);
		gain.gain.exponentialRampToValueAtTime(peak * 0.08, stop - 0.02);
		gain.gain.linearRampToValueAtTime(0, stop);
		noise.connect(band);
		osc.connect(buzz);
		buzz.connect(band);
		band.connect(gain);
		gain.connect(master);
		noise.start(start);
		noise.stop(stop + 0.05);
		osc.start(start);
		osc.stop(stop + 0.05);
		const voice: Voice = { osc, gain, noise, endsAtCtxTime: stop };
		this.voices.push(voice);
		return voice;
	}

	// Dead note: the string muted under the fingers — a short, dull click
	// around the string's pitch, no tone.
	private scheduleDeadNote(
		ctx: AudioContext,
		master: GainNode,
		note: TabNote,
		start: number,
		level: number
	): Voice {
		const stop = start + 0.05;
		const noise = ctx.createBufferSource();
		noise.buffer = this.noiseBuffer(ctx);
		const band = ctx.createBiquadFilter();
		band.type = 'bandpass';
		band.Q.value = 2.5;
		band.frequency.value = Math.min(midiToFreq(note.midi) * 3, 3000);
		const gain = ctx.createGain();
		const peak = 0.9 * note.velocity * level;
		gain.gain.setValueAtTime(0, start);
		gain.gain.linearRampToValueAtTime(peak, start + 0.002);
		gain.gain.exponentialRampToValueAtTime(peak * 0.05, stop - 0.005);
		gain.gain.linearRampToValueAtTime(0, stop);
		noise.connect(band);
		band.connect(gain);
		gain.connect(master);
		// A muted thump under the click.
		const osc = ctx.createOscillator();
		osc.type = 'triangle';
		osc.frequency.value = midiToFreq(note.midi);
		const thump = ctx.createGain();
		thump.gain.setValueAtTime(0, start);
		thump.gain.linearRampToValueAtTime(0.25 * note.velocity * level, start + 0.002);
		thump.gain.exponentialRampToValueAtTime(0.001, stop);
		osc.connect(thump);
		thump.connect(master);
		noise.start(start);
		noise.stop(stop + 0.02);
		osc.start(start);
		osc.stop(stop + 0.02);
		const voice: Voice = { osc, gain, noise, endsAtCtxTime: stop };
		this.voices.push(voice);
		return voice;
	}

	// One second of white noise, made once per audio context.
	private noiseCache: { ctx: BaseAudioContext; buffer: AudioBuffer } | null = null;
	private noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
		if (this.noiseCache?.ctx === ctx) return this.noiseCache.buffer;
		const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
		const d = buffer.getChannelData(0);
		for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
		this.noiseCache = { ctx, buffer };
		return buffer;
	}

	private schedulePitchCurve(
		osc: OscillatorNode,
		arts: Articulation[],
		start: number,
		end: number,
		quarterSec = 0.5
	): void {
		const bend = arts.find((a) => a.kind === 'bend');
		const bendRelease = arts.find((a) => a.kind === 'bendRelease');
		const slideUp = arts.find((a) => a.kind === 'slideUp');
		const slideDown = arts.find((a) => a.kind === 'slideDown');
		const graceSlide = arts.find((a) => a.kind === 'graceSlide');
		const dur = end - start;
		// Fixed, guitar-like pitch moves: a bend reaches pitch in ~90 ms and
		// a slide lands in ~70 ms regardless of how long the note rings.
		// Very short notes squeeze the ramp so it still completes.
		const BEND_TIME = Math.min(0.09, dur * 0.45);
		const SLIDE_TIME = Math.min(0.07, dur * 0.45);
		if (bend) {
			osc.detune.setValueAtTime(0, start);
			osc.detune.linearRampToValueAtTime(bend.semitones * 100, start + BEND_TIME);
		} else if (bendRelease) {
			// Bend up quickly, hold, release back to pitch by halfway through
			// the note (or right after the bend on short notes).
			const peak = bendRelease.semitones * 100;
			const releaseStart = Math.max(start + BEND_TIME, start + dur * 0.5 - BEND_TIME);
			osc.detune.setValueAtTime(0, start);
			osc.detune.linearRampToValueAtTime(peak, start + BEND_TIME);
			osc.detune.setValueAtTime(peak, releaseStart);
			osc.detune.linearRampToValueAtTime(0, Math.min(end, releaseStart + BEND_TIME));
		} else if (graceSlide) {
			// Slide up into the notated fret, hold, slide back off at the end.
			const low = -graceSlide.fromSemitones * 100;
			osc.detune.setValueAtTime(low, start);
			osc.detune.linearRampToValueAtTime(0, start + SLIDE_TIME);
			osc.detune.setValueAtTime(0, Math.max(start + SLIDE_TIME, end - SLIDE_TIME));
			osc.detune.linearRampToValueAtTime(low, end);
		} else if (slideUp) {
			osc.detune.setValueAtTime(-slideUp.fromSemitones * 100, start);
			osc.detune.linearRampToValueAtTime(0, start + SLIDE_TIME);
		} else if (slideDown) {
			osc.detune.setValueAtTime(slideDown.fromSemitones * 100, start);
			osc.detune.linearRampToValueAtTime(0, start + SLIDE_TIME);
		}
		const prebend = arts.find((a) => a.kind === 'prebend');
		if (prebend?.kind === 'prebend') {
			// Picked already bent; a release lets it down by mid-note.
			const peak = prebend.semitones * 100;
			osc.detune.setValueAtTime(peak, start);
			if (prebend.release) {
				const releaseStart = start + dur * 0.35;
				osc.detune.setValueAtTime(peak, releaseStart);
				osc.detune.linearRampToValueAtTime(0, Math.min(end, releaseStart + BEND_TIME));
			}
		}
		const whammy = arts.find((a) => a.kind === 'whammy');
		if (whammy?.kind === 'whammy' && whammy.points.length > 0) {
			// The bar's curve over the note (on top of a bend or slide).
			const base = bend ? bend.semitones * 100 : 0;
			const [first, ...rest] = whammy.points;
			osc.detune.setValueAtTime(base + first[1] * 100, start + first[0] * dur);
			for (const [at, semitones] of rest)
				osc.detune.linearRampToValueAtTime(base + semitones * 100, start + at * dur);
		}
		const trill = arts.find((a) => a.kind === 'trill');
		if (trill?.kind === 'trill' && trill.semitones !== 0) {
			// Hammered to the other fret and pulled back, over and over: at
			// the written speed, but never slower than 14 notes a second.
			const step = Math.min((quarterSec * 4) / (trill.rate || 32), 1 / 14);
			const other = trill.semitones * 100;
			const glide = Math.min(0.004, step / 4);
			let onOther = false;
			for (let t = start + step; t < end - glide; t += step) {
				onOther = !onOther;
				osc.detune.setValueAtTime(onOther ? 0 : other, t);
				osc.detune.linearRampToValueAtTime(onOther ? other : 0, t + glide);
			}
		}
		const slideOut = arts.find((a) => a.kind === 'slideOut');
		if (slideOut?.kind === 'slideOut') {
			// Slides off up / down an octave-ish over the last part.
			const from = Math.max(start, end - Math.min(0.18, dur * 0.5));
			const held = bend ? bend.semitones * 100 : 0;
			osc.detune.setValueAtTime(held, from);
			osc.detune.linearRampToValueAtTime(held + (slideOut.up ? 700 : -900), end);
		}
	}

	private scheduleAmplitudeEnvelope(
		gain: GainNode,
		note: TabNote,
		arts: Articulation[],
		start: number,
		end: number,
		level = 1,
		fadeIn = false
	): void {
		const ghost = arts.some((a) => a.kind === 'ghost');
		const palmMute = arts.some((a) => a.kind === 'palmMute');

		const dur = Math.max(0.05, end - start);
		// Snappy onset — 2 ms is short enough to feel plucked but avoids the DC
		// pop you'd get from a hard step.
		const attack = Math.min(fadeIn ? FADE_IN : 0.002, dur * 0.4);

		if (palmMute) {
			// Palm mute: a rounded, plateau-shaped envelope. Softer 5 ms
			// attack rises to a peak; a small chunk drops the level down
			// to a sustained plateau (~75 % of peak) that holds until a
			// short release at note-off. This keeps palm-muted notes
			// audibly loud (they were sounding much quieter than the
			// sustained notes) while still reading as damped and percussive.
			const pmAttack = Math.min(fadeIn ? FADE_IN : 0.005, dur * 0.3);
			const pmDecayDur = 0.06;
			const peak = 0.42 * note.velocity * level;
			const sustain = peak * 0.75;
			const release = Math.min(0.03, dur * 0.5);
			const decayEnd = Math.min(start + pmAttack + pmDecayDur, end);
			const sustainEnd = Math.max(decayEnd, end - release);
			gain.gain.setValueAtTime(0, start);
			gain.gain.linearRampToValueAtTime(peak, start + pmAttack);
			gain.gain.linearRampToValueAtTime(sustain, decayEnd);
			gain.gain.setValueAtTime(sustain, sustainEnd);
			gain.gain.linearRampToValueAtTime(0, end);
			return;
		}

		// Non-PM: sustained envelope. Release is long enough to prevent a
		// tail-end click without adding a pad-like fade.
		const release = Math.min(0.02, dur * 0.4);
		const sustainLevel = 0.35 * note.velocity * level * (ghost ? 0.25 : 1);
		gain.gain.setValueAtTime(0, start);
		gain.gain.linearRampToValueAtTime(sustainLevel, start + attack);
		gain.gain.setValueAtTime(sustainLevel, Math.max(start + attack, end - release));
		gain.gain.linearRampToValueAtTime(0, end);
	}
}

// Per-note level for `n` notes struck together: n^-0.35, so a chord comes
// out a bit fuller than a single note (a 6-string chord ≈ 1.3× as loud
// overall) without the pile-up of unscaled voices (≈ 2.4×). Per note:
// 2 notes ≈ 78 %, 3 ≈ 68 %, 6 ≈ 53 %. (0.5 would make chords exactly as
// loud as one note; that read as too quiet.)
const CHORD_LEVEL_EXPONENT = 0.35;
function chordLevel(n: number): number {
	return Math.pow(Math.max(1, n), -CHORD_LEVEL_EXPONENT);
}

// Fade-in for a let ring that's already sounding when playback starts.
const FADE_IN = 0.04;

function midiToFreq(midi: number): number {
	return 440 * Math.pow(2, (midi - 69) / 12);
}
