// Guitar Pro import (.gp3 / .gp4 / .gp5 / .gpx / .gp), through alphaTab's
// file readers. One 6-string track becomes the tab: strings and frets as
// written, its effects as articulations, and the song's bar structure
// (time signatures, tempo changes, repeats and jumps played out in order) as
// the tempo map, so bar 1 starts at 0 like in Guitar Pro.
//
// alphaTab is large, so it's only loaded when a Guitar Pro file is opened.

import type { model, midi as alphaMidi } from '@coderline/alphatab';
import type { Articulation, Tab, TabNote, TempoChange } from '../tab/types';
import { barLengthOf } from '../tab/tempo';
import { newNoteId } from '../midi/arrange';

type Score = model.Score;
type Note = model.Note;
type Beat = model.Beat;
type MasterBar = model.MasterBar;

// alphaTab's MIDI ticks per quarter note.
const PPQ = 960;

export const GP_FILE_PATTERN = /\.(gp|gp3|gp4|gp5|gpx)$/i;

let lib: Promise<typeof import('@coderline/alphatab')> | null = null;
function alphaTab() {
	return (lib ??= import('@coderline/alphatab'));
}

export type GpTrack = {
	index: number;
	name: string;
	strings: number;
	// Open strings, high to low, with the capo included.
	openNotes: number[];
	tuningName: string;
	capo: number;
	noteCount: number;
	// Why the track can't be shown (Tabutabu shows one 6-string guitar).
	unsupported?: string;
};

// One bar as it's played (repeats and jumps unfolded), in alphaTab ticks.
type PlayedBar = { masterBar: MasterBar; start: number; end: number };

export type GpSong = {
	title: string;
	artist: string;
	tracks: GpTrack[];
	score: Score;
	played: PlayedBar[];
	tempoEvents: Array<[tick: number, bpm: number]>;
};

export async function readGuitarPro(buffer: ArrayBuffer): Promise<GpSong> {
	const at = await alphaTab();
	const settings = new at.Settings();
	let score: Score;
	try {
		score = at.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(buffer), settings);
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		throw new Error(`Couldn't read the Guitar Pro file (${why})`);
	}

	// Play order and tempo: alphaTab's MIDI generator walks the song the way
	// it's played (repeats, alternate endings, D.S. / D.C. / coda) and reports
	// every tempo change on the way.
	const tempoEvents: Array<[number, number]> = [];
	const handler: alphaMidi.IMidiFileHandler = {
		addTimeSignature() {},
		addRest() {},
		addNote() {},
		addControlChange() {},
		addProgramChange() {},
		addTempo(tick, bpm) {
			tempoEvents.push([tick, bpm]);
		},
		addNoteBend() {},
		addBend() {},
		finishTrack() {},
		addTickShift() {}
	};
	const generator = new at.midi.MidiFileGenerator(score, settings, handler);
	generator.generate();
	const played = generator.tickLookup.masterBars.map((m) => ({
		masterBar: m.masterBar,
		start: m.start,
		end: m.end
	}));
	if (played.length === 0) throw new Error('The Guitar Pro file has no bars');
	tempoEvents.sort((a, b) => a[0] - b[0]);

	const tracks: GpTrack[] = score.tracks.map((track) => {
		const staff = track.staves.find((s) => s.isStringed && !s.isPercussion) ?? track.staves[0];
		let noteCount = 0;
		for (const bar of staff.bars)
			for (const voice of bar.voices) for (const beat of voice.beats) noteCount += beat.notes.length;
		const strings = staff.isStringed ? staff.tuning.length : 0;
		const unsupported =
			staff.isPercussion || !staff.isStringed
				? 'drums / no tab'
				: strings !== 6
					? `${strings} strings`
					: undefined;
		return {
			index: track.index,
			name: track.name.trim() || `Track ${track.index + 1}`,
			strings,
			openNotes: staff.tuning.map((m) => m + staff.capo),
			// "Guitar Dropped C Tuning" → "Dropped C".
			tuningName:
				staff.tuningName
					.replace(/^\s*guitar\s+/i, '')
					.replace(/\s+tuning\s*$/i, '')
					.trim() + (staff.capo ? ` (capo ${staff.capo})` : ''),
			capo: staff.capo,
			noteCount,
			unsupported
		};
	});

	return {
		title: score.title,
		artist: score.artist,
		tracks,
		score,
		played,
		tempoEvents
	};
}

// The track to show first: the first 6-string track with notes.
export function defaultGpTrack(song: GpSong): number | null {
	const ok = song.tracks.filter((t) => !t.unsupported);
	return (ok.find((t) => t.noteCount > 0) ?? ok[0])?.index ?? null;
}

// Converts one track. `openNotes` (high string first) sets the pitches; it's
// normally the track's own tuning.
export function gpTrackToTab(song: GpSong, trackIndex: number, openNotes: number[]): Tab {
	const track = song.score.tracks[trackIndex];
	const info = song.tracks[trackIndex];
	if (!track || !info) throw new Error('No such track in the Guitar Pro file');
	if (info.unsupported) throw new Error(`"${info.name}" can't be shown (${info.unsupported})`);
	const staff = track.staves.find((s) => s.isStringed && !s.isPercussion) ?? track.staves[0];
	const stringCount = staff.tuning.length;

	// ---- Bars and tempo -------------------------------------------------
	// Tabutabu keeps one tempo per bar: each bar gets the tempo that makes
	// it last exactly as long as it does in Guitar Pro (so a tempo change
	// mid-bar or a gradual one still lands every bar line on time).
	const { played, tempoEvents } = song;
	const fallbackBpm = song.score.tempo || 120;
	const secondsBetween = (t0: number, t1: number) => {
		let sec = 0;
		let bpm = fallbackBpm;
		let at = t0;
		for (const [tick, value] of tempoEvents) {
			if (tick <= t0) {
				bpm = value;
				continue;
			}
			if (tick >= t1) break;
			sec += ((tick - at) / PPQ) * (60 / bpm);
			at = tick;
			bpm = value;
		}
		return sec + ((t1 - at) / PPQ) * (60 / bpm);
	};
	const bars = played.map((p) => {
		const ticks = Math.max(1, p.end - p.start);
		const quarters = ticks / PPQ;
		const mb = p.masterBar;
		const nominal: [number, number] = [mb.timeSignatureNumerator, mb.timeSignatureDenominator];
		const nominalTicks = nominal[0] * PPQ * (4 / nominal[1]);
		const timeSignature =
			Math.abs(nominalTicks - ticks) < 1 ? nominal : timeSignatureOfLength(quarters);
		const bpm = round3((quarters * 60) / Math.max(1e-6, secondsBetween(p.start, p.end)));
		return { ...p, timeSignature, bpm, startSec: 0, secPerTick: 60 / bpm / PPQ };
	});
	let sec = 0;
	for (const b of bars) {
		b.startSec = sec;
		sec += (b.end - b.start) * b.secPerTick;
	}
	const durationSec = sec;
	const tempoMap: TempoChange[] = [];
	bars.forEach((b, i) => {
		const prev = tempoMap[tempoMap.length - 1];
		if (
			prev &&
			prev.bpm === b.bpm &&
			prev.timeSignature[0] === b.timeSignature[0] &&
			prev.timeSignature[1] === b.timeSignature[1]
		)
			return;
		tempoMap.push({ bar: i, bpm: b.bpm, timeSignature: b.timeSignature });
	});

	// Song tick (play order) → seconds.
	const tickToSec = (tick: number) => {
		let lo = 0;
		let hi = bars.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (bars[mid].start <= tick) lo = mid;
			else hi = mid - 1;
		}
		const b = bars[lo];
		return Math.max(0, b.startSec + (tick - b.start) * b.secPerTick);
	};

	// ---- Notes ----------------------------------------------------------
	const notes: TabNote[] = [];
	// The tab note last made from each Guitar Pro note (ties continue it).
	const made = new Map<Note, TabNote>();

	for (const p of bars) {
		const bar = staff.bars[p.masterBar.index];
		if (!bar) continue;
		const feel = swingOf(p.masterBar.tripletFeel);
		const toSongTick = (t: number) => p.start + swingTick(t, feel);
		for (const voice of bar.voices) {
			for (const beat of voice.beats) {
				if (beat.isRest || beat.notes.length === 0) continue;
				const startTick = toSongTick(beat.playbackStart);
				const endTick = Math.max(
					startTick + 1,
					toSongTick(beat.playbackStart + beat.playbackDuration)
				);
				const strum = strumOffsets(beat, endTick - startTick);
				for (const n of beat.notes) {
					const noteStart = startTick + (strum.get(n) ?? 0);
					const time = tickToSec(noteStart);
					const end = tickToSec(endTick);

					// A tied note just carries the one before it on.
					if (n.isTieDestination && n.tieOrigin) {
						const origin = made.get(n.tieOrigin);
						if (origin) {
							continueTie(origin, n, beat, end);
							made.set(n, origin);
							continue;
						}
					}

					const stringIndex = stringCount - n.string;
					if (stringIndex < 0 || stringIndex > 5) continue;
					const fret = n.fret;
					const articulations = articulationsOf(n, beat, time, end);
					const duration = Math.max(
						0.01,
						articulations.some((a) => a.kind === 'staccato') ? (end - time) / 2 : end - time
					);
					const tabNote: TabNote = {
						id: newNoteId(),
						time,
						duration,
						stringIndex,
						fret,
						midi: openNotes[stringIndex] + fret,
						velocity: velocityOf(n, beat),
						channel: 0,
						articulations
					};
					notes.push(tabNote);
					made.set(n, tabNote);
				}
			}
		}
	}
	notes.sort((a, b) => a.time - b.time || a.stringIndex - b.stringIndex);

	const first = tempoMap[0];
	return {
		notes,
		durationSec,
		bpm: first.bpm,
		timeSignature: first.timeSignature,
		secondsPerBar: barLengthOf(first.bpm, first.timeSignature),
		tempoMap: tempoMap.length > 1 ? tempoMap : undefined,
		trimmedLeadingSec: 0
	};
}

// ---- Effects --------------------------------------------------------------

function articulationsOf(n: Note, beat: Beat, time: number, end: number): Articulation[] {
	const arts: Articulation[] = [];
	if (n.isDead) arts.push({ kind: 'dead' });
	if (n.isGhost) arts.push({ kind: 'ghost' });
	if (n.isPalmMute || beat.isPalmMute) arts.push({ kind: 'palmMute' });
	if (n.isLetRing || beat.isLetRing) arts.push({ kind: 'letRing' });
	if (n.isStaccato) arts.push({ kind: 'staccato' });
	if (beat.tap || n.isLeftHandTapped) arts.push({ kind: 'tap' });
	else if (n.hammerPullOrigin && n.hammerPullOrigin.fret !== n.fret)
		arts.push({ kind: n.fret > n.hammerPullOrigin.fret ? 'hammerOn' : 'pullOff' });

	// Slides into this note: from the note before (shift / legato slide),
	// or from nowhere (slide in from below / above).
	const origin = n.slideOrigin;
	const fromOrigin =
		origin &&
		(origin.slideOutType === SlideOut.Shift || origin.slideOutType === SlideOut.Legato) &&
		origin.fret !== n.fret
			? n.fret - origin.fret
			: 0;
	if (fromOrigin > 0) arts.push({ kind: 'slideUp', fromSemitones: fromOrigin });
	else if (fromOrigin < 0) arts.push({ kind: 'slideDown', fromSemitones: -fromOrigin });
	else if (n.slideInType === SlideIn.FromBelow && n.fret > 0)
		arts.push({ kind: 'slideUp', fromSemitones: Math.min(3, n.fret) });
	else if (n.slideInType === SlideIn.FromAbove)
		arts.push({ kind: 'slideDown', fromSemitones: 3 });

	// Slides out of this note.
	if (n.slideOutType === SlideOut.OutUp) arts.push({ kind: 'slideOut', up: true });
	else if (n.slideOutType === SlideOut.OutDown) arts.push({ kind: 'slideOut', up: false });
	else if (n.slideOutType === SlideOut.PickSlideDown || n.slideOutType === SlideOut.PickSlideUp)
		arts.push({ kind: 'pickSlide' });

	const bend = bendOf(n);
	if (bend) arts.push(bend);

	if (n.isHarmonic) {
		const semitones = Math.max(0, Math.round(n.realValue - n.realValueWithoutHarmonic));
		if (n.harmonicType === Harmonic.Natural) arts.push({ kind: 'harmonic', semitones });
		else arts.push({ kind: 'harmonic', semitones: semitones || 12, pinch: true });
	}

	if (n.vibrato !== 0 || beat.vibrato !== 0)
		arts.push({ kind: 'vibrato', startTime: time, endTime: end });

	const tremolo = beat.tremoloSpeed;
	if (tremolo !== null && tremolo > 0) arts.push({ kind: 'tremolo', rate: tremolo });

	if (n.isTrill && n.trillFret >= 0 && n.trillFret !== n.fret)
		arts.push({ kind: 'trill', semitones: n.trillFret - n.fret, rate: n.trillSpeed || 32 });

	const whammy = whammyOf(beat);
	if (whammy) arts.push(whammy);
	return arts;
}

// Guitar Pro bends are curves (positions 0–60, values in quarter tones);
// Tabutabu has bend (up), bend & release (up and back) and pre-bend (start
// bent, optionally released). Amounts round to whole semitones (a ¼-tone
// bend becomes a half step).
function bendOf(n: Note): Articulation | null {
	const points = n.bendPoints;
	if (!n.hasBend || !points || points.length === 0) return null;
	const semis = (v: number) => v / 2;
	const startValue = semis(points[0].value);
	const endValue = semis(points[points.length - 1].value);
	const peak = Math.max(...points.map((p) => semis(p.value)));
	const amount = (v: number) => Math.max(1, Math.round(v));
	if (peak <= 0) return null;
	if (startValue > 0) {
		if (endValue > startValue) return { kind: 'bend', semitones: amount(peak) };
		return { kind: 'prebend', semitones: amount(startValue), release: endValue < startValue };
	}
	if (endValue < peak) return { kind: 'bendRelease', semitones: amount(peak) };
	return { kind: 'bend', semitones: amount(peak) };
}

// Whammy bar curve on the beat: positions as a fraction of the note,
// semitones up (+) or down (−), in quarter-tone steps.
function whammyOf(beat: Beat): Articulation | null {
	const points = beat.whammyBarPoints;
	if (!beat.hasWhammyBar || !points || points.length === 0) return null;
	if (points.every((p) => p.value === 0)) return null;
	return {
		kind: 'whammy',
		points: points.map((p) => [
			Math.max(0, Math.min(1, p.offset / 60)),
			Math.max(-24, Math.min(24, p.value / 2))
		])
	};
}

// A tied note: the earlier note rings on to `end`, picking up effects the
// tie adds (vibrato, a release of a held bend).
function continueTie(origin: TabNote, n: Note, beat: Beat, end: number) {
	origin.duration = Math.max(origin.duration, end - origin.time);
	if (n.vibrato !== 0 || beat.vibrato !== 0) {
		const v = origin.articulations.find((a) => a.kind === 'vibrato');
		if (v?.kind === 'vibrato') v.endTime = Math.max(v.endTime, end);
		else
			origin.articulations.push({
				kind: 'vibrato',
				startTime: origin.time + (end - origin.time) / 2,
				endTime: end
			});
	} else {
		const v = origin.articulations.find((a) => a.kind === 'vibrato');
		if (v?.kind === 'vibrato') v.endTime = Math.max(v.endTime, end);
	}
	// Bend held over the tie and released on it.
	const tieBend = bendOf(n);
	const i = origin.articulations.findIndex((a) => a.kind === 'bend');
	if (i >= 0 && tieBend && (tieBend.kind === 'prebend' ? tieBend.release : false)) {
		const b = origin.articulations[i];
		if (b.kind === 'bend')
			origin.articulations[i] = { kind: 'bendRelease', semitones: b.semitones };
	}
}

// Strums and arpeggios: the notes of the beat one after another (a down
// stroke from the low string up), within the first part of the beat.
function strumOffsets(beat: Beat, beatTicks: number): Map<Note, number> {
	const out = new Map<Note, number>();
	const type = beat.brushType;
	if (type === Brush.None || beat.notes.length < 2) return out;
	const arpeggio = type === Brush.ArpeggioUp || type === Brush.ArpeggioDown;
	const total =
		beat.brushDuration > 0
			? Math.min(beat.brushDuration, beatTicks * 0.75)
			: arpeggio
				? beatTicks / 2
				: Math.min(PPQ / 8, beatTicks / 4);
	// Note.string counts from the low string (1).
	const down = type === Brush.BrushDown || type === Brush.ArpeggioDown;
	const ordered = [...beat.notes].sort((a, b) => (down ? a.string - b.string : b.string - a.string));
	ordered.forEach((n, i) => out.set(n, (total * i) / (ordered.length - 1)));
	return out;
}

// MIDI-like loudness from the dynamic (ppp … fff) and accents.
function velocityOf(n: Note, beat: Beat): number {
	const dyn = n.dynamics ?? beat.dynamics;
	const step = dyn >= 0 && dyn <= 7 ? dyn : 4; // ppp … fff, else mf
	let v = (15 + 16 * step) / 127;
	if (n.accentuated === Accent.Normal) v *= 1.15;
	else if (n.accentuated === Accent.Heavy) v *= 1.3;
	return Math.max(0.05, Math.min(1, v));
}

// ---- Swing (triplet feel) ------------------------------------------------

// Each `span` ticks is split at `split` instead of the middle.
type Swing = { span: number; split: number } | null;

function swingOf(feel: number): Swing {
	switch (feel) {
		case 1: // triplet 16th
			return { span: PPQ / 2, split: (PPQ / 2) * (2 / 3) };
		case 2: // triplet 8th
			return { span: PPQ, split: PPQ * (2 / 3) };
		case 3: // dotted 16th
			return { span: PPQ / 2, split: (PPQ / 2) * (3 / 4) };
		case 4: // dotted 8th
			return { span: PPQ, split: PPQ * (3 / 4) };
		case 5: // scottish 16th
			return { span: PPQ / 2, split: (PPQ / 2) * (1 / 4) };
		case 6: // scottish 8th
			return { span: PPQ, split: PPQ * (1 / 4) };
		default:
			return null;
	}
}

function swingTick(t: number, swing: Swing): number {
	if (!swing || t < 0) return t;
	const { span, split } = swing;
	const pos = t % span;
	const base = t - pos;
	const half = span / 2;
	return pos <= half
		? base + pos * (split / half)
		: base + split + (pos - half) * ((span - split) / half);
}

// ---- Helpers --------------------------------------------------------------

// A bar of `quarters` length that isn't its written time signature (a pickup
// bar): the time signature that fits it.
function timeSignatureOfLength(quarters: number): [number, number] {
	for (const unit of [4, 8, 16, 32]) {
		const beats = quarters * (unit / 4);
		if (Math.abs(beats - Math.round(beats)) < 1e-6 && Math.round(beats) >= 1)
			return [Math.round(beats), unit];
	}
	return [Math.max(1, Math.round(quarters)), 4];
}

function round3(x: number): number {
	return Math.round(x * 1000) / 1000;
}

// alphaTab enum values used above, as plain numbers (alphaTab itself is only
// loaded while reading the file).
const SlideOut = { Shift: 1, Legato: 2, OutUp: 3, OutDown: 4, PickSlideDown: 5, PickSlideUp: 6 };
const SlideIn = { FromBelow: 1, FromAbove: 2 };
const Harmonic = { Natural: 1 };
const Brush = { None: 0, BrushUp: 1, BrushDown: 2, ArpeggioUp: 3, ArpeggioDown: 4 };
const Accent = { Normal: 1, Heavy: 2 };
