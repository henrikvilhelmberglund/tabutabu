export type Tuning = {
	name: string;
	// MIDI note numbers of open strings, ordered from HIGH string (index 0) to LOW string (index 5).
	// Standard tuning: high E4 (64), B3 (59), G3 (55), D3 (50), A2 (45), low E2 (40).
	openNotes: [number, number, number, number, number, number];
	// Display note names in the same order. Explicit because flat/sharp choice
	// is a musical convention (Eb Standard uses flats, not D#).
	noteNames: [string, string, string, string, string, string];
};

export const TUNINGS: Record<string, Tuning> = {
	standard: {
		name: 'Standard (E)',
		openNotes: [64, 59, 55, 50, 45, 40],
		noteNames: ['E', 'B', 'G', 'D', 'A', 'E']
	},
	dropD: {
		name: 'Drop D',
		openNotes: [64, 59, 55, 50, 45, 38],
		noteNames: ['E', 'B', 'G', 'D', 'A', 'D']
	},
	dropC: {
		name: 'Drop C',
		openNotes: [62, 57, 53, 48, 43, 36],
		noteNames: ['D', 'A', 'F', 'C', 'G', 'C']
	},
	halfStepDown: {
		name: 'Eb Standard',
		openNotes: [63, 58, 54, 49, 44, 39],
		noteNames: ['Eb', 'Bb', 'Gb', 'Db', 'Ab', 'Eb']
	},
	dadgad: {
		name: 'DADGAD',
		openNotes: [62, 57, 55, 50, 45, 38],
		noteNames: ['D', 'A', 'G', 'D', 'A', 'D']
	}
};

export const STRING_COUNT = 6;
export const MAX_FRET = 24;

// ---- Other tunings (e.g. from a Guitar Pro file) ---------------------------
// A tuning that isn't a preset gets the key "custom:<open notes>:<name>", so
// the key alone rebuilds it (in a share link or after a reload). It's added
// to TUNINGS so every lookup by key works.

const NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

// The preset with these open strings, else a custom key (registered).
export function tuningKeyFor(openNotes: number[], name = ''): string {
	for (const [key, t] of Object.entries(TUNINGS))
		if (t.openNotes.every((m, i) => m === openNotes[i])) return key;
	const key = `custom:${openNotes.join(',')}:${name.replace(/:/g, ' ').trim()}`;
	resolveTuning(key);
	return key;
}

// Looks up (and for a custom key, registers) the tuning for `key`.
export function resolveTuning(key: string): Tuning | null {
	if (key in TUNINGS) return TUNINGS[key];
	const m = key.match(/^custom:((?:\d+,){5}\d+):(.*)$/s);
	if (!m) return null;
	const notes = m[1].split(',').map(Number) as Tuning['openNotes'];
	if (notes.some((n) => n < 0 || n > 127)) return null;
	const noteNames = notes.map((n) => NOTE_NAMES_FLAT[n % 12]) as Tuning['noteNames'];
	const name = m[2].trim() || noteNames.slice().reverse().join(' ');
	TUNINGS[key] = { name, openNotes: notes, noteNames };
	return TUNINGS[key];
}
