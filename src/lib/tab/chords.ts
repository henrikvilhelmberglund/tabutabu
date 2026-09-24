// Chord types and voicing generation for the author-mode chord tool.
//
// Voicings are generated from the tuning rather than looked up in a fixed
// library, so every root / type / tuning combination works. A voicing always
// has the clicked note as its bass (lowest string and lowest pitch) and uses
// a contiguous run of strings upward from it, e.g. x32010 for C with the bass
// on the A string.

import type { Tuning } from './tuning';
import { MAX_FRET } from './tuning';

export type ChordType = {
	id: string;
	// Suffix after the root name: '' for major, 'm7', 'maj9', …
	suffix: string;
	// Semitones above the root (pitch classes; 14 = 9th).
	intervals: number[];
};

// One order for everything: Ctrl+←/→ steps through all of these (stopping
// at both ends), and the top letter row holds the most useful ones in the
// same order, left to right. The rest sit between the keyed types they're
// closest to, so Ctrl+→ from a key's type heads toward the next key.
// Minor comes before major throughout (m, M … m7, 7, maj7), like Q and W.
//   m M sus4 sus2 add9 (6) m7 (m6 m9) 7 (9) maj7 (maj9) aug m7♭5 dim7 dim
export const CHORD_TYPES: ChordType[] = [
	{ id: 'min', suffix: 'm', intervals: [0, 3, 7] },
	{ id: 'maj', suffix: '', intervals: [0, 4, 7] },
	{ id: 'sus4', suffix: 'sus4', intervals: [0, 5, 7] },
	{ id: 'sus2', suffix: 'sus2', intervals: [0, 2, 7] },
	{ id: 'add9', suffix: 'add9', intervals: [0, 4, 7, 14] },
	{ id: '6', suffix: '6', intervals: [0, 4, 7, 9] },
	{ id: 'm7', suffix: 'm7', intervals: [0, 3, 7, 10] },
	{ id: 'm6', suffix: 'm6', intervals: [0, 3, 7, 9] },
	{ id: 'm9', suffix: 'm9', intervals: [0, 3, 7, 10, 14] },
	{ id: '7', suffix: '7', intervals: [0, 4, 7, 10] },
	{ id: '9', suffix: '9', intervals: [0, 4, 7, 10, 14] },
	{ id: 'maj7', suffix: 'maj7', intervals: [0, 4, 7, 11] },
	{ id: 'maj9', suffix: 'maj9', intervals: [0, 4, 7, 11, 14] },
	{ id: 'aug', suffix: 'aug', intervals: [0, 4, 8] },
	{ id: 'm7b5', suffix: 'm7♭5', intervals: [0, 3, 6, 10] },
	{ id: 'dim7', suffix: 'dim7', intervals: [0, 3, 6, 9] },
	{ id: 'dim', suffix: 'dim', intervals: [0, 3, 6] }
];

// The top letter row (physical Q…P plus the two keys after P): the most
// useful types, in CHORD_TYPES order.
export const CHORD_ROW = [
	'min',
	'maj',
	'sus4',
	'sus2',
	'add9',
	'm7',
	'7',
	'maj7',
	'aug',
	'm7b5',
	'dim7',
	'dim'
];

// Note spellings for chord names. In a flat tuning (Eb Standard) everything
// is spelled with flats, matching the string names. Otherwise the usual
// lead-sheet spelling: D♭ E♭ A♭ B♭ but F# for major-type chords, and C#m,
// F#m, G#m but E♭m, B♭m for minor ones.
const FLATS = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const MAJOR_SPELLING = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F#', 'G', 'A♭', 'A', 'B♭', 'B'];
const MINOR_SPELLING = ['C', 'C#', 'D', 'E♭', 'E', 'F', 'F#', 'G', 'G#', 'A', 'B♭', 'B'];

// Whether a tuning's string names use flats (Eb Bb Gb …).
export function tuningUsesFlats(tuning: Tuning): boolean {
	return tuning.noteNames.some((n) => /[b♭]/.test(n.slice(1)));
}

// Name of pitch class `pc` as the root (or slash bass) of a `type` chord.
export function noteName(pc: number, type: ChordType, flats: boolean): string {
	const i = ((pc % 12) + 12) % 12;
	if (flats) return FLATS[i];
	const minor = type.intervals.includes(3) && !type.intervals.includes(4);
	return (minor ? MINOR_SPELLING : MAJOR_SPELLING)[i];
}

export function chordName(rootMidi: number, type: ChordType, flats = false): string {
	return noteName(rootMidi, type, flats) + type.suffix;
}

export type Voicing = Array<{ stringIndex: number; fret: number }>;

// Fretted notes must fit in a 4-fret window (max − min ≤ 3).
const MAX_STRETCH = 3;
// Fingers available for fretted notes; a barre (2+ notes on the lowest
// fretted fret) counts as one finger.
const MAX_FINGERS = 4;
// With an open bass there's no anchor fret, so keep voicings in open /
// lower positions rather than wandering up the whole neck.
const OPEN_BASS_MAX_FRET = 12;

const cache = new Map<string, Voicing[]>();

// Fingers needed for the fretted notes. Several notes on the lowest fretted
// fret can share one finger as a barre — but only when no open string lies
// between them, since the barre would fret it (so 1 0 3 2 1 1 for F needs
// five fingers and is rejected).
function fingerCount(v: Voicing): number {
	const fretted = v.filter((n) => n.fret > 0);
	if (fretted.length === 0) return 0;
	const min = Math.min(...fretted.map((n) => n.fret));
	const atMin = fretted.filter((n) => n.fret === min);
	if (atMin.length < 2) return fretted.length;
	const hi = Math.max(...atMin.map((n) => n.stringIndex));
	const lo = Math.min(...atMin.map((n) => n.stringIndex));
	const openInside = v.some((n) => n.fret === 0 && n.stringIndex < hi && n.stringIndex > lo);
	return openInside ? fretted.length : fretted.length - (atMin.length - 1);
}

// The voicings of `type` with the bass at (bassString, bassFret) that use
// `strings` strings (bass included). When there are none with that many —
// the bass is too close to the top string, or the chord doesn't fit — the
// largest smaller count that has some is used; `strings` in the result says
// which. Ordered: shapes with no open strings (barre / movable) first, then
// open-position shapes, then shapes mixing open strings into a high position;
// each group up the neck.
export function chordVoicings(
	tuning: Tuning,
	type: ChordType,
	bassString: number,
	bassFret: number,
	strings: number
): { strings: number; list: Voicing[] } {
	const all = allVoicings(tuning, type, bassString, bassFret);
	// Chords need 3+ strings even when the shared setting is 2 (sweeps).
	for (let k = Math.min(Math.max(3, strings), bassString + 1); k >= 3; k--) {
		const list = all.filter((v) => v.length === k);
		if (list.length > 0) return { strings: k, list };
	}
	return { strings: 0, list: [] };
}

function allVoicings(
	tuning: Tuning,
	type: ChordType,
	bassString: number,
	bassFret: number
): Voicing[] {
	const key = `${tuning.openNotes.join(',')}|${type.id}|${bassString}|${bassFret}`;
	const hit = cache.get(key);
	if (hit) return hit;

	const bassMidi = tuning.openNotes[bassString] + bassFret;
	const rootPc = bassMidi % 12;
	const pcs = new Set(type.intervals.map((i) => (rootPc + i) % 12));
	// The perfect 5th is the one tone that can be left out of 4+ note chords.
	const fifthPc = (rootPc + 7) % 12;
	const required = new Set(
		[...pcs].filter((pc) => !(type.intervals.length >= 4 && pc === fifthPc))
	);

	const found: Voicing[] = [];
	const current: Voicing = [{ stringIndex: bassString, fret: bassFret }];

	const complete = (v: Voicing) => {
		if (v.length < 3) return false;
		const have = new Set(v.map((n) => (tuning.openNotes[n.stringIndex] + n.fret) % 12));
		for (const pc of required) if (!have.has(pc)) return false;
		return fingerCount(v) <= MAX_FINGERS;
	};

	const extend = (s: number) => {
		if (s >= 0) {
			const fretted = current.filter((n) => n.fret > 0).map((n) => n.fret);
			const lo = fretted.length ? Math.max(...fretted) - MAX_STRETCH : 1;
			const hi = fretted.length
				? Math.min(...fretted) + MAX_STRETCH
				: bassFret === 0
					? OPEN_BASS_MAX_FRET
					: MAX_FRET;
			for (let fret = 0; fret <= Math.min(hi, MAX_FRET); fret++) {
				if (fret > 0 && fret < lo) continue;
				const midi = tuning.openNotes[s] + fret;
				if (midi <= bassMidi || !pcs.has(midi % 12)) continue;
				current.push({ stringIndex: s, fret });
				extend(s - 1);
				current.pop();
			}
		}
		// Stop here: this string and everything above it are muted.
		if (complete(current)) found.push(current.map((n) => ({ ...n })));
	};
	extend(bassString - 1);

	// Group 0: no open strings — barre / movable shapes (x35553, 133211).
	// Group 1: open-position shapes (x32010). Group 2: open strings mixed
	// into a high position (x32050). Within a group: up the neck, then fewer
	// fingers (x32010 before x32013). An open bass puts everything in 1/2.
	const topFret = (v: Voicing) => Math.max(...v.map((n) => n.fret));
	const group = (v: Voicing) => (!v.some((n) => n.fret === 0) ? 0 : topFret(v) <= 4 ? 1 : 2);
	const sum = (v: Voicing) => v.reduce((a, n) => a + n.fret, 0);
	found.sort(
		(a, b) =>
			group(a) - group(b) ||
			topFret(a) - topFret(b) ||
			fingerCount(a) - fingerCount(b) ||
			sum(a) - sum(b)
	);
	cache.set(key, found);
	return found;
}

// Which chord type a stack is (bass = lowest string), if any. Matches when
// the stack's pitch classes are exactly the type's, or the type's minus an
// optional 5th.
export function matchChordType(
	tuning: Tuning,
	notes: Array<{ stringIndex: number; fret: number }>
): ChordType | null {
	if (notes.length < 3) return null;
	const bass = notes.reduce((a, b) => (b.stringIndex > a.stringIndex ? b : a));
	const rootPc = (tuning.openNotes[bass.stringIndex] + bass.fret) % 12;
	const have = new Set(notes.map((n) => (tuning.openNotes[n.stringIndex] + n.fret) % 12));
	for (const type of CHORD_TYPES) {
		const pcs = new Set(type.intervals.map((i) => (rootPc + i) % 12));
		const fifthPc = (rootPc + 7) % 12;
		if ([...have].some((pc) => !pcs.has(pc))) continue;
		const missing = [...pcs].filter((pc) => !have.has(pc));
		if (missing.length === 0) return type;
		if (missing.length === 1 && missing[0] === fifthPc && type.intervals.length >= 4) return type;
	}
	return null;
}

// Index of the voicing in `list` closest to `target` (fret distance per
// string; strings only one of them uses cost extra). -1 for an empty list.
export function closestVoicing(list: Voicing[], target: Voicing): number {
	let best = -1;
	let bestCost = Infinity;
	list.forEach((v, i) => {
		let cost = 0;
		const strings = new Set([...v, ...target].map((n) => n.stringIndex));
		for (const s of strings) {
			const a = v.find((n) => n.stringIndex === s);
			const b = target.find((n) => n.stringIndex === s);
			cost += a && b ? Math.abs(a.fret - b.fret) : 6;
		}
		if (cost < bestCost) {
			bestCost = cost;
			best = i;
		}
	});
	return best;
}

// "x 3 2 0 1 0" style, low string first, for labels.
export function voicingFrets(v: Voicing, stringCount: number): string {
	const out: string[] = [];
	for (let s = stringCount - 1; s >= 0; s--) {
		const n = v.find((x) => x.stringIndex === s);
		out.push(n ? String(n.fret) : 'x');
	}
	return out.join(' ');
}

// Name of a single pitch with its octave (A♭3, F#4 …).
export function pitchName(midi: number, flats: boolean): string {
	const i = ((midi % 12) + 12) % 12;
	return (flats ? FLATS : MAJOR_SPELLING)[i] + (Math.floor(midi / 12) - 1);
}
