// Classifies articulations for a single note using its MPE expression curves.
// Spec (from GOAL.md discussions):
//
//   Pitch (bipolar semitones, MPE):
//     0 → +N (N in 1..5)  bend
//     −N → 0              slide up (destination = notated fret, from N below)
//     +N → 0              slide down (from N above)
//     sustained ≥ +6      natural harmonic
//
//   Pressure (0..1): > 0 (small deadzone) → vibrato
//   Velocity (0..1): < 0.10 → ghost, 0.10..0.50 → palm mute
//   Timbre CC74 (bipolar around 64, normalized −1..+1):
//     < −0.05           → pull-off
//     +0.05..+0.90      → hammer-on
//     > +0.90           → tap

import type { Articulation } from '../tab/types';
import type { ChannelExpressions, ExpressionSample } from './expressions';
import { maxAbsInWindow, sampleAt } from './expressions';

export type ClassifyThresholds = {
	pitchZeroEpsilon: number; // semitones treated as "at 0"
	bendMax: number; // upper bound (semitones) for a bend
	harmonicMin: number; // lower bound (semitones) for a harmonic
	pressureDeadzone: number; // 0..1
	ghostMaxVel: number; // 0..1
	palmMuteMaxVel: number; // 0..1
	timbreDeadzone: number; // −1..+1 magnitude
	tapMin: number; // 0..1
};

export const DEFAULT_THRESHOLDS: ClassifyThresholds = {
	pitchZeroEpsilon: 0.15,
	bendMax: 5,
	harmonicMin: 6,
	pressureDeadzone: 0.05,
	ghostMaxVel: 0.1,
	palmMuteMaxVel: 0.5,
	timbreDeadzone: 0.05,
	tapMin: 0.9
};

export function classifyNote(
	noteStart: number,
	noteEnd: number,
	velocity: number,
	midi: number,
	channelExpr: ChannelExpressions | undefined,
	th: ClassifyThresholds = DEFAULT_THRESHOLDS
): Articulation[] {
	const result: Articulation[] = [];

	// Velocity-based (mutually exclusive: ghost has priority when very quiet)
	if (velocity < th.ghostMaxVel) {
		result.push({ kind: 'ghost' });
	} else if (velocity < th.palmMuteMaxVel) {
		result.push({ kind: 'palmMute' });
	}

	if (!channelExpr) return result;

	// Small tolerance around the note's window for pressure/timbre; a much wider
	// tail for pitch. Bitwig's pitch envelopes routinely extend past note-off —
	// e.g. a bend-and-release shape can put its return-to-zero point 500 ms after
	// the note ends. Without that extension we'd sample pbEnd mid-bend and call
	// a bend-release a plain sustained bend.
	const wStart = noteStart - 0.02;
	const wEnd = noteEnd + 0.02;
	const pitchLookahead = noteEnd + 0.5;

	// Bitwig writes the initial state of a per-note pitch envelope as the first
	// point, usually a few ms into the note. A raw sampleAt at note-onset misses
	// this because it uses step-hold and there's nothing yet. So we specifically
	// look for a first event inside the onset window and prefer its value.
	const pbStart = firstEventInOnsetWindow(
		channelExpr.pitchBendSemitones,
		noteStart,
		wStart,
		0.05
	);
	const pbEnd = sampleAt(channelExpr.pitchBendSemitones, pitchLookahead);
	const pbMax = signedPeakInWindow(channelExpr.pitchBendSemitones, wStart, pitchLookahead);
	const pbRange = signedRangeInWindow(channelExpr.pitchBendSemitones, wStart, pitchLookahead);

	const zeroStart = Math.abs(pbStart) <= th.pitchZeroEpsilon;
	const zeroEnd = Math.abs(pbEnd) <= th.pitchZeroEpsilon;

	if (!zeroStart && zeroEnd) {
		// Slide: pitch resolves to notated fret from an offset
		const from = pbStart;
		if (from < 0) result.push({ kind: 'slideUp', fromSemitones: -Math.round(from) });
		else result.push({ kind: 'slideDown', fromSemitones: Math.round(from) });
	} else if (zeroStart && pbEnd > th.pitchZeroEpsilon) {
		// Bend or harmonic depending on magnitude
		if (pbEnd >= th.harmonicMin) {
			result.push({ kind: 'harmonic', semitones: Math.round(pbEnd) });
		} else if (pbEnd <= th.bendMax) {
			result.push({ kind: 'bend', semitones: Math.round(pbEnd) });
		}
	} else if (zeroStart && zeroEnd && pbMax >= th.harmonicMin) {
		// Sustained upward offset without hitting the note-off return — call it harmonic.
		result.push({ kind: 'harmonic', semitones: Math.round(pbMax) });
	} else if (zeroStart && zeroEnd && pbMax > th.pitchZeroEpsilon && pbMax <= th.bendMax) {
		// Bend and release: pitch peaks upward mid-note then returns to the played fret.
		result.push({ kind: 'bendRelease', semitones: Math.round(pbMax) });
	} else if (
		pbStart < -th.pitchZeroEpsilon &&
		pbEnd < -th.pitchZeroEpsilon &&
		Math.abs(pbStart - pbEnd) < 0.7 &&
		pbRange.max >= -th.pitchZeroEpsilon
	) {
		// Grace slide: pitch starts N semitones below the notated fret, briefly
		// touches it (or slightly above) mid-note, and returns to the same offset
		// below. Common Bitwig shape for a grace-note dip.
		result.push({ kind: 'graceSlide', fromSemitones: Math.round(-Math.max(pbStart, pbEnd)) });
	}

	// Pressure → vibrato. Two sources depending on export mode:
	//   MPE: channel pressure (channelAftertouch) on the note's dedicated channel
	//   Standard MIDI: poly aftertouch (noteAftertouch) keyed by MIDI note number
	// Capture the actual time range where pressure exceeds the deadzone so the
	// renderer can draw the wavy line only during that span. Window is widened
	// a bit past note-off because Bitwig commonly puts the last envelope point
	// slightly past note end.
	const wPressStart = noteStart - 0.05;
	const wPressEnd = noteEnd + 0.15;
	const polyPress = channelExpr.polyAftertouch.get(midi);
	const chRange = aboveThresholdRange(
		channelExpr.pressure,
		wPressStart,
		wPressEnd,
		th.pressureDeadzone
	);
	const polyRange = polyPress
		? aboveThresholdRange(polyPress, wPressStart, wPressEnd, th.pressureDeadzone)
		: null;
	const vibratoRange = mergeRanges(chRange, polyRange);
	if (vibratoRange) {
		result.push({
			kind: 'vibrato',
			startTime: Math.max(noteStart, vibratoRange.start),
			endTime: Math.min(noteEnd, vibratoRange.end)
		});
	} else {
		// Safety net: if the range extraction misses but there IS pressure above
		// threshold somewhere in the widened window, still emit vibrato spanning
		// the whole note so a signal doesn't get silently dropped.
		const chMax = maxAbsInWindow(channelExpr.pressure, wPressStart, wPressEnd);
		const polyMax = polyPress ? maxAbsInWindow(polyPress, wPressStart, wPressEnd) : 0;
		if (Math.max(chMax, polyMax) > th.pressureDeadzone) {
			result.push({ kind: 'vibrato', startTime: noteStart, endTime: noteEnd });
		}
	}

	// Timbre CC74 → hammer/pull/tap. CC values are 0..127, center 64 → bipolar.
	const cc74 = channelExpr.cc.get(74);
	if (cc74) {
		const raw = sampleAt(cc74, noteStart + Math.max(0, (noteEnd - noteStart) * 0.25));
		const timbre = (raw - 64) / 63; // -1..+1
		if (timbre > th.tapMin) result.push({ kind: 'tap' });
		else if (timbre > th.timbreDeadzone) result.push({ kind: 'hammerOn' });
		else if (timbre < -th.timbreDeadzone) result.push({ kind: 'pullOff' });
	}

	return result;
}

// Time range where the envelope's value is above `threshold`. Uses step-hold
// semantics: the envelope's value at any point is the last event's value at or
// before that point. So if the last event in the window is above threshold,
// the range extends all the way to window end (not just to the last event).
function aboveThresholdRange(
	events: ExpressionSample[],
	start: number,
	end: number,
	threshold: number
): { start: number; end: number } | null {
	let first = -1;
	let last = -1;
	for (const e of events) {
		if (e.time < start) continue;
		if (e.time > end) break;
		if (Math.abs(e.value) > threshold) {
			if (first < 0) first = e.time;
			last = e.time;
		}
	}
	if (first < 0) return null;
	// If pressure is still above threshold at window end (step-hold), extend
	// the range to the window's end — otherwise Bitwig-style envelopes with
	// just a single "value rose here" point collapse to a tiny visible width.
	const endValue = sampleAt(events, end);
	const effectiveEnd = Math.abs(endValue) > threshold ? end : last;
	return { start: first, end: Math.max(effectiveEnd, first + 0.05) };
}

function mergeRanges(
	a: { start: number; end: number } | null,
	b: { start: number; end: number } | null
): { start: number; end: number } | null {
	if (!a) return b;
	if (!b) return a;
	return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
}

// First event value in [wStart, noteStart + tolerance]. Falls back to plain
// step-hold sampling if no event lands in that window.
function firstEventInOnsetWindow(
	events: ExpressionSample[],
	noteStart: number,
	wStart: number,
	tolerance: number
): number {
	for (const e of events) {
		if (e.time > noteStart + tolerance) break;
		if (e.time >= wStart) return e.value;
	}
	return sampleAt(events, noteStart + 1e-3);
}

// Peak signed value in window (retains sign — so a max-positive of +7 beats a
// larger-magnitude negative in the same span). Used for harmonic detection where
// direction matters.
function signedPeakInWindow(events: ExpressionSample[], start: number, end: number): number {
	let peak = 0;
	for (const e of events) {
		if (e.time < start) continue;
		if (e.time > end) break;
		if (Math.abs(e.value) > Math.abs(peak)) peak = e.value;
	}
	return peak;
}

// Signed min/max across the events in a window. Distinct from signedPeakInWindow
// because for a shape like (-2 → 0 → -2) we want max=0 and min=-2, not just the
// largest magnitude.
function signedRangeInWindow(
	events: ExpressionSample[],
	start: number,
	end: number
): { min: number; max: number } {
	let min = 0;
	let max = 0;
	let seen = false;
	for (const e of events) {
		if (e.time < start) continue;
		if (e.time > end) break;
		if (!seen) {
			min = e.value;
			max = e.value;
			seen = true;
		} else {
			if (e.value > max) max = e.value;
			if (e.value < min) min = e.value;
		}
	}
	return { min, max };
}
