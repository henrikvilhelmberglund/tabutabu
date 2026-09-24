// Harmonic pitch helpers. A `harmonic` articulation stores how many
// semitones above the fretted pitch the harmonic sounds.
//
// Natural harmonics only exist at node frets, and each node has one fixed
// pitch. Anything else (a non-node fret, or a different interval at a node)
// is a pinch/artificial harmonic.

import type { Articulation } from './types';

// Semitones above the fretted pitch for the natural harmonic at each node.
export const NATURAL_HARMONIC_OFFSET: Record<number, number> = {
	3: 28,
	4: 24,
	5: 19,
	7: 12,
	9: 19,
	12: 0,
	16: 12,
	19: 0,
	24: 0
};

// Harmonic-series intervals a pinch harmonic can land on, above the fretted
// pitch: octave, octave + 5th, 2 octaves, 2 oct + major 3rd, 2 oct + 5th,
// 3 octaves.
export const PINCH_HARMONIC_INTERVALS = [12, 19, 24, 28, 31, 36];

// After a note's fret changes: a natural harmonic moves to the new node's
// pitch, or turns into a pinch harmonic when the new fret has no natural
// harmonic (keeping its interval, or an octave if it was 0). Pinch harmonics keep their interval.
export function retuneHarmonic(arts: Articulation[], fret: number): Articulation[] {
	return arts.map((a) => {
		if (a.kind !== 'harmonic' || a.pinch) return a;
		const natural = NATURAL_HARMONIC_OFFSET[fret];
		return natural !== undefined
			? { ...a, semitones: natural }
			: { ...a, pinch: true, semitones: a.semitones || 12 };
	});
}

export function isNaturalHarmonic(fret: number, semitones: number): boolean {
	return NATURAL_HARMONIC_OFFSET[fret] === semitones;
}

// Every interval selectable for a note at `fret`, ascending: the natural one
// (if the fret is a node) plus the pinch intervals.
export function harmonicChoices(fret: number): number[] {
	const set = new Set(PINCH_HARMONIC_INTERVALS);
	const natural = NATURAL_HARMONIC_OFFSET[fret];
	if (natural !== undefined) set.add(natural);
	return [...set].sort((a, b) => a - b);
}
