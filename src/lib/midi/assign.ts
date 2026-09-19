import type { Tuning } from '../tab/tuning';
import { MAX_FRET } from '../tab/tuning';

// Per GOAL.md: MIDI channel 0 = "default" (smart assign),
// channel 1 = low E (string index 5), channel 6 = high E (string index 0).
// Channel numbering here matches @tonejs/midi's zero-based `channel` field
// (which corresponds to MIDI channels 1–16 in the file).
export function forcedStringForChannel(channel: number): number | null {
	if (channel >= 1 && channel <= 6) {
		// channel 1 → low E (index 5); channel 6 → high E (index 0)
		return 6 - channel;
	}
	return null;
}

export type CandidateFret = { stringIndex: number; fret: number };

export function candidateFrets(midi: number, tuning: Tuning): CandidateFret[] {
	const out: CandidateFret[] = [];
	for (let s = 0; s < tuning.openNotes.length; s++) {
		const fret = midi - tuning.openNotes[s];
		if (fret >= 0 && fret <= MAX_FRET) out.push({ stringIndex: s, fret });
	}
	return out;
}

// Baseline "smart" assignment: pick the candidate with the smallest fret,
// tie-break by preferring higher strings (thinner) so low bass parts land on
// lower strings when a fret-0 option exists on multiple strings.
// This is the placeholder for the smarter power-chord-aware pass.
export function smartPick(candidates: CandidateFret[]): CandidateFret | null {
	if (candidates.length === 0) return null;
	return [...candidates].sort((a, b) => a.fret - b.fret || a.stringIndex - b.stringIndex)[0];
}
