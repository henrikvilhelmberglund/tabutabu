// Sweep-picking shapes and patterns for the author-mode sweep tool.
//
// A sweep shape has exactly one note per string, each higher than the one
// below (so the pick can rake straight across). Two strings can roll an
// extra chord tone with the fretting hand:
//   - the top string: the next chord tone above it, played first and pulled
//     off (15p12) at the turnaround of a loop, and
//   - the bass string: the next chord tone above the bass, hammered on at
//     the very start of a pattern (5h8 7 7 5).
// Classic shapes, low string first:
//
//   A minor, 5 strings      C/E, 4 strings        A minor from low E
//   A12 D14 G14 B13 e12     D14 G12 B13 e12       E5h8 A7 D7 G5
//     top roll e17p12         top roll e15p12       bass roll 5h8
//
// Sweeps are often played from an inversion (C/E above starts on the 3rd),
// so every chord that contains the anchoring note is offered: root position
// first, then the inversions.

import type { Tuning } from './tuning';
import { MAX_FRET } from './tuning';
import { noteName, tuningUsesFlats, type ChordType, type Voicing } from './chords';

export type SweepShape = {
	// Pitch class of the chord's root (differs from the bass for inversions).
	rootPc: number;
	// One note per string, bass first, rising in pitch.
	tones: Voicing;
	// Fret of the roll note on the top string (the next chord tone up).
	extraFret: number;
	// Fret of the roll note on the bass string (the next chord tone above the
	// bass, still below the next string's note), or null if there's none.
	bassExtraFret: number | null;
};

// Fretted notes of the base shape fit in a 4-fret window; roll notes may
// reach further (they're hammer-ons / pull-offs with the little finger).
const MAX_SPAN = 3;
const MAX_EXTRA_REACH = 7;

const cache = new Map<string, SweepShape[]>();

// Every sweep shape of `type` with the bass at (bassString, bassFret) on
// exactly `k` strings.
function shapesWithStrings(
	tuning: Tuning,
	type: ChordType,
	bassString: number,
	bassFret: number,
	k: number
): SweepShape[] {
	const key = `${tuning.openNotes.join(',')}|${type.id}|${bassString}|${bassFret}|${k}`;
	const hit = cache.get(key);
	if (hit) return hit;

	const open = tuning.openNotes;
	const bassMidi = open[bassString] + bassFret;
	const bassPc = bassMidi % 12;
	// Every chord of this type that contains the bass note: root position
	// first, then the inversions in chord-tone order.
	const roots: number[] = [];
	for (const iv of type.intervals) {
		const r = (((bassPc - iv) % 12) + 12) % 12;
		if (!roots.includes(r)) roots.push(r);
	}
	// The next chord tone above `midi`, as a fret on `string`, if it's in
	// reach (and below `below`, when given).
	const rollFret = (pcs: Set<number>, string: number, fret: number, below = Infinity) => {
		const midi = open[string] + fret;
		for (let d = 1; d <= MAX_EXTRA_REACH && fret + d <= MAX_FRET; d++) {
			if (midi + d >= below) return null;
			if (pcs.has((midi + d) % 12)) return fret + d;
		}
		return null;
	};

	const out: SweepShape[] = [];
	for (const rootPc of roots) {
		const pcs = new Set(type.intervals.map((i) => (rootPc + i) % 12));
		const fifth = (rootPc + 7) % 12;
		// Big chords can drop the perfect 5th, like the chord tool.
		const required = [...pcs].filter((pc) => !(type.intervals.length >= 4 && pc === fifth));
		const found: SweepShape[] = [];
		const tones: Voicing = [{ stringIndex: bassString, fret: bassFret }];
		const extend = () => {
			if (tones.length === k) {
				const have = new Set(tones.map((t) => (open[t.stringIndex] + t.fret) % 12));
				if (k >= 3 && required.some((pc) => !have.has(pc))) return;
				// Open strings only in open position (no D0 G0 B0 e10).
				if (tones.some((t) => t.fret === 0) && tones.some((t) => t.fret > 4)) return;
				const top = tones[k - 1];
				const extraFret = rollFret(pcs, top.stringIndex, top.fret);
				if (extraFret === null) return;
				const second = tones[1];
				const bassExtraFret = rollFret(
					pcs,
					bassString,
					bassFret,
					open[second.stringIndex] + second.fret
				);
				found.push({ rootPc, tones: tones.map((t) => ({ ...t })), extraFret, bassExtraFret });
				return;
			}
			const s = bassString - tones.length;
			if (s < 0) return;
			const prev = tones[tones.length - 1];
			const prevMidi = open[prev.stringIndex] + prev.fret;
			const fretted = tones.filter((t) => t.fret > 0).map((t) => t.fret);
			const lo = fretted.length ? Math.max(...fretted) - MAX_SPAN : 1;
			const hi = fretted.length ? Math.min(...fretted) + MAX_SPAN : 12;
			for (let fret = 0; fret <= Math.min(hi, MAX_FRET); fret++) {
				if (fret > 0 && fret < lo) continue;
				const midi = open[s] + fret;
				if (midi <= prevMidi || !pcs.has(midi % 12)) continue;
				tones.push({ stringIndex: s, fret });
				extend();
				tones.pop();
			}
		};
		extend();
		found.sort((a, b) => shapeSpan(a) - shapeSpan(b) || topFret(a) - topFret(b));
		out.push(...found);
	}
	cache.set(key, out);
	return out;
}

function shapeSpan(v: SweepShape): number {
	const f = v.tones.map((t) => t.fret).filter((x) => x > 0);
	return f.length ? Math.max(...f) - Math.min(...f) : 0;
}
function topFret(v: SweepShape): number {
	return Math.max(...v.tones.map((t) => t.fret));
}

// Sweep shapes with the bass at (bassString, bassFret), on `strings` strings
// or the largest smaller count (down to 2) that has any.
export function sweepShapes(
	tuning: Tuning,
	type: ChordType,
	bassString: number,
	bassFret: number,
	strings: number
): { strings: number; list: SweepShape[] } {
	for (let k = Math.min(strings, bassString + 1); k >= 2; k--) {
		const list = shapesWithStrings(tuning, type, bassString, bassFret, k);
		if (list.length > 0) return { strings: k, list };
	}
	return { strings: 0, list: [] };
}

// The shapes whose `pattern` STARTS on (startString, startFret) — the note
// you click is the first note you'd play. For patterns that start at the
// bass that's simply the bass; for ones that start at the top the shape is
// found below it. Shapes the pattern can't use (no bass roll for a 5h8
// start) are left out. String count falls back like sweepShapes.
export function sweepShapesFrom(
	tuning: Tuning,
	type: ChordType,
	startString: number,
	startFret: number,
	strings: number,
	pattern: SweepPattern
): { strings: number; list: SweepShape[] } {
	const usable = (s: SweepShape) => !pattern.bassHammer || s.bassExtraFret !== null;
	if (patternStart(pattern) === 'bass') {
		for (let k = Math.min(strings, startString + 1); k >= 2; k--) {
			const list = shapesWithStrings(tuning, type, startString, startFret, k).filter(usable);
			if (list.length > 0) return { strings: k, list };
		}
		return { strings: 0, list: [] };
	}
	const stringCount = tuning.openNotes.length;
	for (let k = Math.min(strings, stringCount - startString); k >= 2; k--) {
		const bassString = startString + k - 1;
		const found: Array<{ shape: SweepShape; bassFret: number }> = [];
		for (let bassFret = 0; bassFret <= MAX_FRET; bassFret++) {
			for (const shape of shapesWithStrings(tuning, type, bassString, bassFret, k)) {
				const first = sweepCycle(shape, pattern)[0];
				if (usable(shape) && first.stringIndex === startString && first.fret === startFret) {
					found.push({ shape, bassFret });
				}
			}
		}
		if (found.length === 0) continue;
		// Root position first, then compact shapes close to the clicked fret.
		const inverted = (s: SweepShape) => {
			const b = s.tones[0];
			return (tuning.openNotes[b.stringIndex] + b.fret) % 12 === s.rootPc ? 0 : 1;
		};
		found.sort(
			(a, b) =>
				inverted(a.shape) - inverted(b.shape) ||
				shapeSpan(a.shape) - shapeSpan(b.shape) ||
				Math.abs(a.bassFret - startFret) - Math.abs(b.bassFret - startFret)
		);
		return { strings: k, list: found.map((f) => f.shape) };
	}
	return { strings: 0, list: [] };
}

// "C/E" style name for a shape of `type`.
export function sweepName(shape: SweepShape, type: ChordType, tuning: Tuning): string {
	const bass = shape.tones[0];
	const bassPc = (tuning.openNotes[bass.stringIndex] + bass.fret) % 12;
	const flats = tuningUsesFlats(tuning);
	const name = noteName(shape.rootPc, type, flats) + type.suffix;
	return bassPc === shape.rootPc ? name : `${name}/${noteName(bassPc, type, flats)}`;
}

// ---- Patterns ----------------------------------------------------------------

// kind: 'ud' up-down loop, 'du' down-up loop, 'up' / 'down' one way.
// top: how the top string turns the sweep around —
//   'pull'   15p12: pick the roll note, pull off to the shape note;
//   'full'   12 15p12: pick the shape note and the roll note as part of the
//            sweep, then pull off and change direction;
//   'single' 12: just the shape note.
// bassHammer: the pattern starts with a hammer-on on the bass (5h8).
export type SweepTop = 'pull' | 'full' | 'single';
export type SweepPattern = {
	id: string;
	kind: 'ud' | 'du' | 'up' | 'down';
	top: SweepTop;
	bassHammer: boolean;
	name: string;
};

const pattern = (
	id: string,
	kind: SweepPattern['kind'],
	top: SweepTop,
	bassHammer: boolean,
	name: string
): SweepPattern => ({ id, kind, top, bassHammer, name });

// Shift+↑/↓ steps through these. Up-down / down-up loops end on the note
// before their first so repeats join seamlessly. Hammer-ons only appear at
// the start of a pattern; the top of a loop turns around with a pull-off.
export const SWEEP_PATTERNS: SweepPattern[] = [
	pattern('ud-pull', 'ud', 'pull', false, 'up-down, top 15p12'),
	pattern('ud-full', 'ud', 'full', false, 'up-down, top 12 15p12'),
	pattern('ud', 'ud', 'single', false, 'up-down'),
	pattern('ud-hammer', 'ud', 'single', true, 'up-down, starts 5h8'),
	pattern('du-pull', 'du', 'pull', false, 'down-up from the top, 15p12'),
	pattern('du-full', 'du', 'full', false, 'down-up from the top, 12 15p12'),
	pattern('du', 'du', 'single', false, 'down-up from the top'),
	pattern('up-hammer', 'up', 'single', true, 'up, starts 5h8'),
	pattern('up', 'up', 'single', false, 'up'),
	pattern('down-pull', 'down', 'pull', false, 'down from the top, 15p12'),
	pattern('down', 'down', 'single', false, 'down from the top')
];

// Where a pattern's first note is: the bass string or the top string.
export function patternStart(pattern: SweepPattern): 'bass' | 'top' {
	return pattern.kind === 'ud' || pattern.kind === 'up' ? 'bass' : 'top';
}

export type SweepNote = { stringIndex: number; fret: number; art?: 'hammerOn' | 'pullOff' };

// One pass of `pattern` over `shape`, e.g. for C/E (D14 G12 B13 e12):
//   up-down, 15p12:     D14 G12 B13 e15 p12 B13 G12 | D14 …
//   up-down, 12 15p12:  D14 G12 B13 e12 e15 p12 B13 G12 | D14 …
//   down-up, 15p12:     e15 p12 B13 G12 D14 G12 B13 | e15 …
//   up, starts 5h8:     (Am from low E) E5 h8 A7 D7 G5
export function sweepCycle(shape: SweepShape, pattern: SweepPattern): SweepNote[] {
	const tones: SweepNote[] = shape.tones.map((t) => ({ ...t }));
	const bass = tones[0];
	const top = tones[tones.length - 1];
	const mid = tones.slice(1, -1); // strings between the bass and the top
	const start: SweepNote[] =
		pattern.bassHammer && shape.bassExtraFret !== null
			? [bass, { stringIndex: bass.stringIndex, fret: shape.bassExtraFret, art: 'hammerOn' }]
			: [bass];
	const roll: SweepNote = { stringIndex: top.stringIndex, fret: shape.extraFret };
	const peak: SweepNote[] =
		pattern.top === 'pull'
			? [roll, { ...top, art: 'pullOff' }]
			: pattern.top === 'full'
				? [top, roll, { ...top, art: 'pullOff' }]
				: [top];
	const midDown = [...mid].reverse();
	switch (pattern.kind) {
		case 'ud':
			return [...start, ...mid, ...peak, ...midDown];
		case 'du':
			return [...peak, ...midDown, bass, ...mid];
		case 'up':
			return [...start, ...mid, top];
		case 'down':
			return [...peak, ...midDown, bass];
	}
}

export function sweepSequence(
	shape: SweepShape,
	pattern: SweepPattern,
	loops: number
): SweepNote[] {
	const cycle = sweepCycle(shape, pattern);
	const out: SweepNote[] = [];
	for (let i = 0; i < Math.max(1, loops); i++) out.push(...cycle.map((n) => ({ ...n })));
	return out;
}
