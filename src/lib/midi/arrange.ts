import type { Tuning } from '../tab/tuning';
import { MAX_FRET } from '../tab/tuning';
import type { Articulation, TabNote } from '../tab/types';
import { candidateFrets, forcedStringForChannel, type CandidateFret } from './assign';

export type RawNote = {
	time: number;
	duration: number;
	midi: number;
	velocity: number;
	channel: number;
	articulations: Articulation[];
};

export type ArrangeOptions = {
	// If true, honor GOAL.md's channel→string mapping (channel 1 = low E, 6 = high E).
	// Off by default because MPE MIDI (Bitwig's per-note expression export) uses
	// channels 2–16 for expression routing, not for string selection.
	honorChannelStrings: boolean;
	// Manual per-note string pinning. Key is `${time.toFixed(6)}:${midi}:${channel}`
	// so a specific note's assignment survives re-parses. If the pinned string
	// can't reach the note (fret out of range), fall back to smart assignment.
	overrides?: Record<string, number>;
	// Manual technique override per note.
	//   'hammer' — force a hammer-on
	//   'pull'   — force a pull-off
	//   'tap'    — force a tap
	//   'off'    — remove any auto-detected hammer/pull/tap
	// A missing entry means "use whatever the classifier detected".
	annotations?: Record<string, 'hammer' | 'pull' | 'tap' | 'off'>;
};

export const DEFAULT_ARRANGE_OPTIONS: ArrangeOptions = { honorChannelStrings: false };

export function overrideKey(time: number, midi: number, channel: number): string {
	return `${time.toFixed(6)}:${midi}:${channel}`;
}

const CONTEXT_SIZE = 4;

// Scoring weights — tunable. Lower total score wins.
const W_FRET = 0.05; // mild preference for low frets
const W_FRET_STEP = 0.3; // hand-motion cost from previous note
const W_HAND_CENTER = 0.15; // stay near recent hand position
const W_SAME_STRING = 0.5; // slight penalty for staying on same string
const W_ADJACENT_STRING = -0.2; // bonus for adjacent string (sweep-friendly)
const W_STRING_JUMP = 0.4; // per-string cost beyond adjacent

// Assigns a single raw note to a string/fret given the notes already placed.
// Used by both the batch arranger below and the live MIDI session which needs
// to append notes one at a time as they arrive.
export function assignOne(
	n: RawNote,
	placed: TabNote[],
	tuning: Tuning,
	options: ArrangeOptions = DEFAULT_ARRANGE_OPTIONS
): TabNote | null {
	const occupied = new Set<number>();
	for (const p of placed) {
		if (p.time + p.duration > n.time + 1e-6) occupied.add(p.stringIndex);
	}
	const cands = pickCandidates(n, tuning, occupied, options);
	if (cands.length === 0) return null;
	const context = recentContext(placed, n.time);
	const best = pickBest(cands, context);
	return {
		id: newNoteId(),
		time: n.time,
		duration: n.duration,
		stringIndex: best.stringIndex,
		fret: best.fret,
		midi: n.midi,
		velocity: n.velocity,
		channel: n.channel,
		articulations: applyAnnotation(
			n.articulations,
			options.annotations?.[overrideKey(n.time, n.midi, n.channel)]
		)
	};
}

// Generate a note id. Prefer the platform's crypto.randomUUID when available
// (all evergreen browsers and modern Node); fall back to a short random string
// for older environments so tests still pass.
export function newNoteId(): string {
	const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
	if (g.crypto && typeof g.crypto.randomUUID === 'function') return g.crypto.randomUUID();
	return 'n' + Math.random().toString(36).slice(2, 12);
}

function applyAnnotation(
	arts: Articulation[],
	anno: 'hammer' | 'pull' | 'tap' | 'off' | undefined
): Articulation[] {
	if (!anno) return arts;
	const stripped: Articulation[] = arts.filter(
		(a) => a.kind !== 'hammerOn' && a.kind !== 'pullOff' && a.kind !== 'tap'
	);
	if (anno === 'off') return stripped;
	if (anno === 'hammer') stripped.push({ kind: 'hammerOn' });
	else if (anno === 'pull') stripped.push({ kind: 'pullOff' });
	else if (anno === 'tap') stripped.push({ kind: 'tap' });
	return stripped;
}

export function arrange(
	rawNotes: RawNote[],
	tuning: Tuning,
	options: ArrangeOptions = DEFAULT_ARRANGE_OPTIONS
): TabNote[] {
	// Order: by time, then forced-first (only when honoring channels), then high-MIDI first.
	// Placing higher voices first in a chord naturally pushes them onto thinner strings
	// and leaves the bass to walk down.
	const sorted = [...rawNotes].sort((a, b) => {
		if (a.time !== b.time) return a.time - b.time;
		if (options.honorChannelStrings) {
			const af = forcedStringForChannel(a.channel) !== null;
			const bf = forcedStringForChannel(b.channel) !== null;
			if (af !== bf) return af ? -1 : 1;
		}
		return b.midi - a.midi;
	});

	const placed: TabNote[] = [];
	for (const n of sorted) {
		const t = assignOne(n, placed, tuning, options);
		if (t) placed.push(t);
	}
	placed.sort((a, b) => a.time - b.time);
	return placed;
}

function pickCandidates(
	n: RawNote,
	tuning: Tuning,
	occupied: Set<number>,
	options: ArrangeOptions
): CandidateFret[] {
	// Manual overrides win over everything. If the pinned string can reach the
	// note, use it; otherwise fall back to smart assignment.
	if (options.overrides) {
		const pinned = options.overrides[overrideKey(n.time, n.midi, n.channel)];
		if (typeof pinned === 'number') {
			const fret = n.midi - tuning.openNotes[pinned];
			if (fret >= 0 && fret <= MAX_FRET && !occupied.has(pinned)) {
				return [{ stringIndex: pinned, fret }];
			}
		}
	}
	if (options.honorChannelStrings) {
		const forced = forcedStringForChannel(n.channel);
		if (forced !== null) {
			const fret = n.midi - tuning.openNotes[forced];
			if (fret >= 0 && fret <= MAX_FRET && !occupied.has(forced)) {
				return [{ stringIndex: forced, fret }];
			}
		}
	}
	return candidateFrets(n.midi, tuning).filter((c) => !occupied.has(c.stringIndex));
}

// Recent notes that are meaningfully close in time — used for economy scoring.
function recentContext(placed: TabNote[], now: number): TabNote[] {
	// Take the last CONTEXT_SIZE notes that were placed within a short lookback window.
	// Keeps chord-mate context (same-time notes just placed) as well as the trailing
	// melody line. Notes are appended in placement order (which mixes times when there
	// are chords), so we take a plain tail slice.
	const tail = placed.slice(-CONTEXT_SIZE);
	// Optional: drop entries far in the past to avoid biasing across silences.
	const LOOKBACK = 2.0; // seconds
	return tail.filter((p) => now - p.time < LOOKBACK);
}

function pickBest(cands: CandidateFret[], context: TabNote[]): CandidateFret {
	let best = cands[0];
	let bestScore = Infinity;
	for (const c of cands) {
		const s = scoreCandidate(c, context);
		if (s < bestScore) {
			bestScore = s;
			best = c;
		}
	}
	return best;
}

function scoreCandidate(c: CandidateFret, context: TabNote[]): number {
	let score = c.fret * W_FRET;
	if (context.length === 0) return score;

	const prev = context[context.length - 1];
	score += Math.abs(c.fret - prev.fret) * W_FRET_STEP;

	const dString = Math.abs(c.stringIndex - prev.stringIndex);
	if (dString === 0) score += W_SAME_STRING;
	else if (dString === 1) score += W_ADJACENT_STRING;
	else score += dString * W_STRING_JUMP;

	const avgFret = context.reduce((a, p) => a + p.fret, 0) / context.length;
	score += Math.abs(c.fret - avgFret) * W_HAND_CENTER;

	return score;
}
