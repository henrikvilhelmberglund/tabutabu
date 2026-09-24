// Power-chord shapes for the author-mode power-chord tools. The root sits on
// the clicked (lower) string; each member goes on the next thinner string in
// order, as an interval above the root. Intervals (not fixed frets) keep a
// shape sounding the same on any string pair and in any tuning — the 5th is
// "2 4" across standard E/A, "2 2" on drop-D's bottom strings, "2 5" across
// G/B.
//
// Each list is ordered by pitch of the upper string(s), low to high, which in
// standard tuning reads as the upper frets counting up.

import type { Tuning } from './tuning';
import { MAX_FRET } from './tuning';

export type PowerShape = { id: string; name: string; intervals: number[] };

// Tool 3: two strings. Standard tuning, root at fret 2: 2 0 … 2 5.
export const TWO_STRING_SHAPES: PowerShape[] = [
	{ id: 'i3', name: 'minor 3rd', intervals: [3] },
	{ id: 'i4', name: 'major 3rd', intervals: [4] },
	{ id: 'i5', name: '4th', intervals: [5] },
	{ id: 'i6', name: '♭5', intervals: [6] },
	{ id: 'i7', name: '5th', intervals: [7] },
	{ id: 'i8', name: 'minor 6th', intervals: [8] }
];

// Tool 2: three strings. Standard tuning, root open: 0 0 0 … 0 2 5.
export const THREE_STRING_SHAPES: PowerShape[] = [
	{ id: 'i5-10', name: '4th + ♭7', intervals: [5, 10] },
	{ id: 'i5-12', name: '5th in the bass', intervals: [5, 12] },
	{ id: 'i7-10', name: '5th + ♭7', intervals: [7, 10] },
	{ id: 'i7-12', name: '5th + octave', intervals: [7, 12] },
	{ id: 'i7-13', name: '5th + ♭9', intervals: [7, 13] },
	{ id: 'i7-14', name: '5th + 9th', intervals: [7, 14] },
	{ id: 'i7-15', name: '5th + minor 10th', intervals: [7, 15] }
];

export const DEFAULT_SHAPE: Record<2 | 3, string> = { 2: 'i7-12', 3: 'i7' };

export function shapesForTool(tool: number): PowerShape[] {
	return tool === 2 ? THREE_STRING_SHAPES : tool === 3 ? TWO_STRING_SHAPES : [];
}

// Where each member lands for a root at (rootString, rootFret). Members that
// run off the fretboard or past the top string are left out; the others keep
// their own string (a missing 5th never shifts the octave onto its string).
export function shapeSpots(
	shape: PowerShape,
	tuning: Tuning,
	rootString: number,
	rootFret: number
): Array<{ stringIndex: number; fret: number }> {
	const spots = [{ stringIndex: rootString, fret: rootFret }];
	const rootMidi = tuning.openNotes[rootString] + rootFret;
	shape.intervals.forEach((interval, i) => {
		const s = rootString - (i + 1);
		if (s < 0) return;
		const fret = rootMidi + interval - tuning.openNotes[s];
		if (fret < 0 || fret > MAX_FRET) return;
		spots.push({ stringIndex: s, fret });
	});
	return spots;
}

// Which shape an existing stack is, if any. `members` are the notes on the
// strings above the root.
export function matchShape(
	shapes: PowerShape[],
	tuning: Tuning,
	root: { stringIndex: number; fret: number },
	members: Array<{ stringIndex: number; fret: number }>
): PowerShape | null {
	for (const shape of shapes) {
		const spots = shapeSpots(shape, tuning, root.stringIndex, root.fret).slice(1);
		if (spots.length !== shape.intervals.length || spots.length !== members.length) continue;
		const ok = spots.every((sp) =>
			members.some((m) => m.stringIndex === sp.stringIndex && m.fret === sp.fret)
		);
		if (ok) return shape;
	}
	return null;
}

// Frets of `shape` low to high ("2 4", "0 2 2"), on the lowest strings,
// with the root at the lowest fret where every shape of the tool fits — so
// all labels of one tool share a root and read as a sequence.
export function shapeLabel(shape: PowerShape, shapes: PowerShape[], tuning: Tuning): string {
	const low = tuning.openNotes.length - 1;
	let root = 0;
	for (const s of shapes) {
		s.intervals.forEach((interval, i) => {
			const fretAtRoot0 = tuning.openNotes[low] + interval - tuning.openNotes[low - (i + 1)];
			root = Math.max(root, -fretAtRoot0);
		});
	}
	return shapeSpots(shape, tuning, low, root)
		.map((s) => s.fret)
		.join(' ');
}
