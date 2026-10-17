// Tempo map: where bars are in time when the tempo and / or time signature
// change during the song.
//
// A tab's `tempoMap` lists the changes, each starting at a bar (the first at
// bar 0) and lasting until the next. Without one, the whole tab is in
// `bpm` / `timeSignature` (older tabs). `bpm` always counts quarter notes
// per minute (as MIDI does); the beat is the time signature's unit, so a bar
// lasts numerator × (4 / denominator) quarter notes.
//
// `tab.bpm`, `tab.timeSignature` and `tab.secondsPerBar` mirror the first
// section, for code that only needs the song's starting tempo.

import type { Tab, TempoChange } from './types';

export type { TempoChange };

export type BarInfo = {
	index: number;
	start: number;
	length: number;
	// Beats in the bar and how long one lasts.
	beats: number;
	beatLength: number;
	bpm: number;
	timeSignature: [number, number];
	// Index of the tempo change in effect.
	section: number;
};

const EPS = 1e-6;

export const quarterLength = (bpm: number) => 60 / bpm;
export const beatLengthOf = (bpm: number, ts: [number, number]) => (60 / bpm) * (4 / ts[1]);
export const barLengthOf = (bpm: number, ts: [number, number]) => ts[0] * beatLengthOf(bpm, ts);

// The tab's tempo changes, first at bar 0. A tab without a map gets one
// section matching its stored bar length exactly (older x/8 tabs counted the
// tempo in eighth notes; this keeps their timing).
export function tempoChanges(
	tab: Pick<Tab, 'bpm' | 'timeSignature' | 'secondsPerBar' | 'tempoMap'>
): TempoChange[] {
	if (tab.tempoMap && tab.tempoMap.length > 0) return tab.tempoMap;
	const ts = tab.timeSignature;
	const bpm = tab.secondsPerBar > 0 ? (ts[0] * (4 / ts[1]) * 60) / tab.secondsPerBar : tab.bpm;
	return [{ bar: 0, bpm, timeSignature: [ts[0], ts[1]] }];
}

type Section = TempoChange & { start: number; barLength: number };

function sections(tab: Parameters<typeof tempoChanges>[0]): Section[] {
	const changes = tempoChanges(tab);
	const out: Section[] = [];
	let start = 0;
	for (let i = 0; i < changes.length; i++) {
		const c = changes[i];
		if (i > 0) {
			const p = out[i - 1];
			start = p.start + (c.bar - p.bar) * p.barLength;
		}
		out.push({ ...c, start, barLength: barLengthOf(c.bpm, c.timeSignature) });
	}
	return out;
}

function info(s: Section, section: number, index: number): BarInfo {
	const beatLength = beatLengthOf(s.bpm, s.timeSignature);
	return {
		index,
		start: s.start + (index - s.bar) * s.barLength,
		length: s.barLength,
		beats: s.timeSignature[0],
		beatLength,
		bpm: s.bpm,
		timeSignature: s.timeSignature,
		section
	};
}

export function barInfo(tab: Parameters<typeof tempoChanges>[0], index: number): BarInfo {
	const secs = sections(tab);
	const i = Math.max(0, Math.floor(index));
	let k = 0;
	while (k + 1 < secs.length && secs[k + 1].bar <= i) k++;
	return info(secs[k], k, i);
}

// The bar `time` falls in (bar 0 for negative times).
export function barAt(tab: Parameters<typeof tempoChanges>[0], time: number): BarInfo {
	const secs = sections(tab);
	let k = 0;
	while (k + 1 < secs.length && secs[k + 1].start <= time + EPS) k++;
	const s = secs[k];
	const index = s.bar + Math.max(0, Math.floor((time - s.start) / s.barLength + EPS));
	return info(s, k, index);
}

export const barStart = (tab: Parameters<typeof tempoChanges>[0], index: number) =>
	barInfo(tab, index).start;

// Number of bars needed to cover `duration` seconds (at least 1).
export function barCount(tab: Parameters<typeof tempoChanges>[0], duration: number): number {
	// A hair before the end, so a length exactly on a bar line doesn't count
	// the bar after it.
	if (duration <= 1e-3) return 1;
	return barAt(tab, duration - 1e-3).index + 1;
}

// Grid step (seconds) at `time`: a whole note / gridStep at the local tempo.
export const gridStepAt = (
	tab: Parameters<typeof tempoChanges>[0],
	time: number,
	gridStep: number
) => 240 / barAt(tab, time).bpm / gridStep;

// Nearest grid line to `time`. Grid lines restart at every bar line.
export function snapToGrid(
	tab: Parameters<typeof tempoChanges>[0],
	time: number,
	gridStep: number
): number {
	const b = barAt(tab, Math.max(0, time));
	const step = 240 / b.bpm / gridStep;
	const k = Math.round((Math.max(0, time) - b.start) / step);
	const t = b.start + k * step;
	return t >= b.start + b.length - EPS ? b.start + b.length : t;
}

// The grid line `dir` steps from `time` (snapped first).
export function stepGrid(
	tab: Parameters<typeof tempoChanges>[0],
	time: number,
	gridStep: number,
	dir: number
): number {
	let t = snapToGrid(tab, time, gridStep);
	for (let i = 0; i < Math.abs(dir); i++) {
		if (dir > 0) {
			const b = barAt(tab, t);
			const step = 240 / b.bpm / gridStep;
			const next = t + step;
			t = next >= b.start + b.length - EPS ? b.start + b.length : next;
		} else {
			if (t <= EPS) return 0;
			// The bar the previous line is in (the one before, at a bar line).
			let b = barAt(tab, t);
			if (t - b.start < EPS) b = barInfo(tab, b.index - 1);
			const step = 240 / b.bpm / gridStep;
			const k = Math.ceil((t - b.start) / step - EPS) - 1;
			t = b.start + Math.max(0, k) * step;
		}
	}
	return Math.max(0, t);
}

// Seconds at `quarters` quarter notes from the song's start (e.g. a DAW's
// song position), through the tempo / time-signature changes.
export function quartersToTime(tab: Parameters<typeof tempoChanges>[0], quarters: number): number {
	const changes = tempoChanges(tab);
	let start = 0;
	let q = Math.max(0, quarters);
	for (let i = 0; i < changes.length; i++) {
		const c = changes[i];
		const quarterLen = 60 / c.bpm;
		const next = changes[i + 1];
		if (!next) return start + q * quarterLen;
		const barQuarters = c.timeSignature[0] * (4 / c.timeSignature[1]);
		const sectionQuarters = (next.bar - c.bar) * barQuarters;
		if (q < sectionQuarters) return start + q * quarterLen;
		q -= sectionQuarters;
		start += sectionQuarters * quarterLen;
	}
	return start;
}

// Bar / beat position (1-based) of `time`, e.g. for "5.3".
export function barBeat(
	tab: Parameters<typeof tempoChanges>[0],
	time: number
): { bar: number; beat: number } {
	const b = barAt(tab, time);
	return { bar: b.index + 1, beat: Math.floor((time - b.start) / b.beatLength + EPS) + 1 };
}

// Time `t` under `from` → the same bar and position in it (in quarter notes)
// under `to`. Used to move notes along when the map changes.
export function warpTime(
	from: Parameters<typeof tempoChanges>[0],
	to: Parameters<typeof tempoChanges>[0],
	t: number
): number {
	const b = barAt(from, t);
	const quarters = (t - b.start) / quarterLength(b.bpm);
	const nb = barInfo(to, b.index);
	return nb.start + quarters * quarterLength(nb.bpm);
}

// The map sorted, one change per bar (the later one wins), starting at
// bar 0. Sections equal to the one before are kept: a new one starts out
// that way before it's edited.
export function normalizeMap(map: TempoChange[]): TempoChange[] {
	const sorted = [...map].sort((a, b) => a.bar - b.bar);
	const out: TempoChange[] = [];
	for (const c of sorted) {
		const bar = Math.max(0, Math.round(c.bar));
		const prev = out[out.length - 1];
		if (prev && prev.bar === bar) {
			out[out.length - 1] = { ...c, bar };
			continue;
		}
		out.push({ bar, bpm: c.bpm, timeSignature: [c.timeSignature[0], c.timeSignature[1]] });
	}
	if (out.length && out[0].bar !== 0) out[0] = { ...out[0], bar: 0 };
	return out;
}
