export type TabNote = {
	time: number; // seconds
	duration: number; // seconds
	stringIndex: number; // 0 = highest (thin) string, 5 = lowest (thick)
	fret: number;
	midi: number;
	velocity: number;
	channel: number;
	articulations: Articulation[];
};

// All per-note articulations (palm mute is per-note too, but rendered as a
// spanning marker across contiguous PM notes above the staff).
export type Articulation =
	| { kind: 'slideUp'; fromSemitones: number } // pitch went (−N → 0)
	| { kind: 'slideDown'; fromSemitones: number } // pitch went (+N → 0)
	| { kind: 'bend'; semitones: number } // pitch (0 → +N), N ≤ ~5
	| { kind: 'bendRelease'; semitones: number } // pitch (0 → +N → 0), N ≤ ~5
	| { kind: 'graceSlide'; fromSemitones: number } // pitch (−N → 0 → −N), briefly touches notated fret from below
	| { kind: 'harmonic'; semitones: number } // pitch offset ≥ ~6
	| { kind: 'vibrato'; startTime: number; endTime: number } // absolute-time range where pressure is above threshold
	| { kind: 'palmMute' }
	| { kind: 'ghost' }
	| { kind: 'hammerOn' }
	| { kind: 'pullOff' }
	| { kind: 'tap' };

export type Tab = {
	notes: TabNote[];
	durationSec: number;
	bpm: number;
	// [beatsPerBar, beatUnit] — e.g. [4, 4] for 4/4, [6, 8] for 6/8.
	timeSignature: [number, number];
	// Derived: seconds per bar assuming the first tempo/time-sig stay constant.
	// Mid-song changes aren't tracked yet.
	secondsPerBar: number;
	trimmedLeadingSec: number;
};
