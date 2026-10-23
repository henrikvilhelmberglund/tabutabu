export type TabNote = {
	// Stable per-note identity, generated once when the note is created (on
	// parse or via the authoring tools). Needed for edits — keying by
	// time+midi+channel would break the moment you nudge a note in time.
	id: string;
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
	| { kind: 'harmonic'; semitones: number; pinch?: boolean } // pitch offset ≥ ~6; pinch = pinch/artificial (shown as "P.H." instead of <n>)
	| { kind: 'vibrato'; startTime: number; endTime: number } // absolute-time range where pressure is above threshold
	| { kind: 'palmMute' }
	| { kind: 'ghost' }
	| { kind: 'hammerOn' }
	| { kind: 'pullOff' }
	| { kind: 'tap' }
	// Pick slide ("P.S."): the pick scraped down the strings from this note,
	// instead of picking it.
	| { kind: 'pickSlide' }
	// Dead (muted) note: "x", a percussive click with no pitch.
	| { kind: 'dead' }
	// Staccato: cut short (played for its written length only).
	| { kind: 'staccato' }
	// Tremolo picking: re-picked at this note value (8 = eighths, 16, 32)
	// for as long as the note lasts.
	| { kind: 'tremolo'; rate: number }
	// Slide out of the note to nowhere, up or down, at its end.
	| { kind: 'slideOut'; up: boolean }
	// Pre-bend: picked already bent up N semitones; `release` lets it back
	// down to the fret during the note.
	| { kind: 'prebend'; semitones: number; release: boolean }
	// Trill: alternates fast with the fret `semitones` away (hammered and
	// pulled) for as long as the note rings; `rate` is the written speed
	// (16 = sixteenths, 32, 64).
	| { kind: 'trill'; semitones: number; rate: number }
	// Whammy bar: pitch curve over the note, [fraction of the note 0–1,
	// semitones (negative = down)].
	| { kind: 'whammy'; points: Array<[number, number]> }
	// Note is "let ring" — playback keeps the pitch alive past the bar
	// boundary (the default is to mute at bar end), and it's cut only by
	// the next note fretted on the SAME string, mirroring real guitar
	// physics.
	| { kind: 'letRing' };

// A tempo / time-signature change starting at a bar (see tempo.ts).
export type TempoChange = { bar: number; bpm: number; timeSignature: [number, number] };

export type Tab = {
	notes: TabNote[];
	durationSec: number;
	// The first section's tempo (quarter notes per minute), time signature
	// ([beatsPerBar, beatUnit], e.g. [6, 8]) and bar length — the whole song
	// unless `tempoMap` has changes. Use tempo.ts for bar / beat positions.
	bpm: number;
	timeSignature: [number, number];
	secondsPerBar: number;
	// Tempo / time-signature changes, first at bar 0 (absent = no changes).
	tempoMap?: TempoChange[];
	trimmedLeadingSec: number;
};
