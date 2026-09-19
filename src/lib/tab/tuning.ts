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
