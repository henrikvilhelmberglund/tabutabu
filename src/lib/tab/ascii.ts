// Bars of a tab as plain-text ("ASCII") tab, for pasting anywhere:
//
//   PM------
//   e|-----------------|-------...
//   B|-----------------|
//   G|-------7h9-------|
//   D|-7---7-----7b9r7-|
//   A|-5---5-----------|
//   E|-----------------|
//
// Each bar gets the coarsest grid its notes fit (eighths, sixteenths,
// triplets, …); a column is as wide as its widest note plus a dash. Legato
// and slides go in the dash before the note (5h7, 5/7, 7\5), bends and the
// like after it (7b9, 7b9r7, 7pb9), ghost notes in brackets, natural
// harmonics in <>, dead notes as x, vibrato as ~. Palm mute and let ring
// are lines above. Bars wrap into rows of about `width` characters.

import type { Tab, TabNote } from './types';
import type { Tuning } from './tuning';
import { barInfo } from './tempo';

// Grid steps tried per bar, in quarter notes, coarsest first.
const GRIDS = [1 / 2, 1 / 4, 1 / 3, 1 / 6, 1 / 8, 1 / 12, 1 / 16, 1 / 24, 1 / 32, 1 / 48, 1 / 64];

type BarText = { lines: string[]; marks: Map<string, boolean[]>; width: number };

export function tabToAscii(
	tab: Tab,
	tuning: Tuning,
	firstBar: number,
	lastBar: number,
	width = 80
): string {
	const names = stringNames(tuning);
	const nameW = Math.max(...names.map((n) => n.length));
	const bars: BarText[] = [];
	for (let b = firstBar; b <= lastBar; b++) bars.push(barText(tab, b));

	// Rows of bars, each about `width` wide.
	const rows: BarText[][] = [];
	let row: BarText[] = [];
	let used = nameW + 1;
	for (const bar of bars) {
		if (row.length > 0 && used + bar.width + 1 > width) {
			rows.push(row);
			row = [];
			used = nameW + 1;
		}
		row.push(bar);
		used += bar.width + 1;
	}
	if (row.length) rows.push(row);

	const out: string[] = [];
	const standard = tuning.openNotes.every((m, i) => m === [64, 59, 55, 50, 45, 40][i]);
	if (!standard) out.push(`Tuning: ${[...names].reverse().join(' ')}`, '');
	for (const r of rows) {
		// Palm mute / let ring lines over the notes they cover.
		for (const [kind, label] of [
			['palmMute', 'PM'],
			['letRing', 'LR']
		] as const) {
			if (!r.some((bar) => bar.marks.get(kind)?.some(Boolean))) continue;
			let line = ' '.repeat(nameW + 1);
			for (const bar of r) line += markLine(bar.marks.get(kind) ?? [], label) + ' ';
			out.push(line.trimEnd());
		}
		for (let s = 0; s < 6; s++) {
			out.push(
				names[s].padEnd(nameW) + '|' + r.map((bar) => bar.lines[s] + '|').join('')
			);
		}
		out.push('');
	}
	return out.join('\n').trimEnd() + '\n';
}

// String names high to low; the high string lower-case when it has the
// low string's name (e … E).
function stringNames(tuning: Tuning): string[] {
	const names = [...tuning.noteNames];
	if (names[0].toLowerCase() === names[5].toLowerCase()) names[0] = names[0].toLowerCase();
	return names;
}

function barText(tab: Tab, index: number): BarText {
	const bar = barInfo(tab, index);
	const quarter = 60 / bar.bpm;
	const barQuarters = bar.length / quarter;
	const notes = tab.notes.filter(
		(n) => n.time >= bar.start - 1e-6 && n.time < bar.start + bar.length - 1e-6
	);
	const pos = (n: TabNote) => (n.time - bar.start) / quarter;
	const grid =
		GRIDS.find((g) =>
			notes.every((n) => Math.abs(pos(n) / g - Math.round(pos(n) / g)) < 0.08)
		) ?? GRIDS[GRIDS.length - 1];
	const slots = Math.max(1, Math.round(barQuarters / grid));

	// Each slot's notes per string.
	const cells: Array<Array<TabNote | null>> = Array.from({ length: slots }, () =>
		Array(6).fill(null)
	);
	for (const n of notes) {
		const slot = Math.min(slots - 1, Math.round(pos(n) / grid));
		if (n.stringIndex >= 0 && n.stringIndex < 6) cells[slot][n.stringIndex] = n;
	}

	const lines = Array(6).fill('-') as string[];
	// Which characters palm mute / let ring cover (not the leading dash).
	const marks = new Map<string, boolean[]>([
		['palmMute', [false]],
		['letRing', [false]]
	]);
	for (const column of cells) {
		const labels = column.map((n) => (n ? noteLabel(n) : ''));
		const w = Math.max(1, ...labels.map((l) => l.length)) + 1;
		for (let s = 0; s < 6; s++) {
			const n = column[s];
			let line = lines[s];
			if (n) {
				// Legato / slide / tap marks go in the dash before the note.
				const join = joinChar(n);
				if (join && line.endsWith('-')) line = line.slice(0, -1) + join;
			}
			lines[s] = line + labels[s].padEnd(w, '-');
		}
		for (const [kind, m] of marks) {
			const on = column.some((n) => n?.articulations.some((a) => a.kind === kind));
			for (let i = 0; i < w; i++) m.push(on && i < w - 1);
		}
	}
	return { lines, marks, width: lines[0].length };
}

function joinChar(n: TabNote): string {
	for (const a of n.articulations) {
		if (a.kind === 'hammerOn') return 'h';
		if (a.kind === 'pullOff') return 'p';
		if (a.kind === 'tap') return 't';
		if (a.kind === 'slideUp') return '/';
		if (a.kind === 'slideDown') return '\\';
	}
	return '';
}

function noteLabel(n: TabNote): string {
	const has = (k: string) => n.articulations.some((a) => a.kind === k);
	let s = has('dead') ? 'x' : String(n.fret);
	const harmonic = n.articulations.find((a) => a.kind === 'harmonic');
	if (harmonic?.kind === 'harmonic' && !harmonic.pinch) s = `<${s}>`;
	if (has('ghost')) s = `(${s})`;
	for (const a of n.articulations) {
		if (a.kind === 'harmonic' && a.pinch) s += `[${n.fret + a.semitones}]`;
		else if (a.kind === 'bend') s += `b${n.fret + a.semitones}`;
		else if (a.kind === 'bendRelease') s += `b${n.fret + a.semitones}r${n.fret}`;
		else if (a.kind === 'prebend')
			s += `pb${n.fret + a.semitones}${a.release ? `r${n.fret}` : ''}`;
		else if (a.kind === 'graceSlide') s += `\\${Math.max(0, n.fret - a.fromSemitones)}`;
		else if (a.kind === 'trill') s += `tr${n.fret + a.semitones}`;
		else if (a.kind === 'slideOut') s += a.up ? '/' : '\\';
	}
	if (has('vibrato')) s += '~';
	return s;
}

// "PM----" over each run of marked characters.
function markLine(marked: boolean[], label: string): string {
	let out = '';
	for (let i = 0; i < marked.length; i++) {
		if (!marked[i]) out += ' ';
		else if (i === 0 || !marked[i - 1]) {
			out += label;
			i += label.length - 1;
		} else out += '-';
	}
	return out.slice(0, marked.length);
}
