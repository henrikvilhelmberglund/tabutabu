// Authoring mode's mutation layer for a Tab. Every change to notes goes
// through a `Command` so we can push it onto an undo stack and revert it on
// Ctrl+Z. Commands wrap their forward and reverse operations so the reverse
// is guaranteed to be an exact inverse (rather than reconstructed).
//
// This module is state-machine free: it just gives you helpers to build
// commands. The +page.svelte state layer owns the doc and the history stack
// and calls into these helpers when the user does something.

import type { Tab, TabNote, Articulation } from './types';
import { newNoteId } from '../midi/arrange';
import { retuneHarmonic } from './harmonics';

export { newNoteId };

// A single undoable edit. `apply` mutates the tab in place and returns; the
// state layer redraws afterwards. `label` shows up in a future undo history
// UI, if we ever want one.
export type Command = {
	label: string;
	apply: (tab: Tab) => void;
	revert: (tab: Tab) => void;
};

// Undo/redo stacks. The state layer owns one of these per open tab.
export type History = {
	past: Command[];
	future: Command[];
	// Configurable cap so a runaway autosave loop can't OOM us.
	maxDepth: number;
};

export function makeHistory(maxDepth = 500): History {
	return { past: [], future: [], maxDepth };
}

// Executes a command and pushes it to history. Clears the redo stack — once
// you make a new edit after undoing, the redo path is no longer reachable.
export function run(tab: Tab, hist: History, cmd: Command): void {
	cmd.apply(tab);
	hist.past.push(cmd);
	if (hist.past.length > hist.maxDepth) hist.past.shift();
	hist.future.length = 0;
}

export function undo(tab: Tab, hist: History): boolean {
	const cmd = hist.past.pop();
	if (!cmd) return false;
	cmd.revert(tab);
	hist.future.push(cmd);
	return true;
}

export function redo(tab: Tab, hist: History): boolean {
	const cmd = hist.future.pop();
	if (!cmd) return false;
	cmd.apply(tab);
	hist.past.push(cmd);
	return true;
}

export function canUndo(hist: History): boolean {
	return hist.past.length > 0;
}
export function canRedo(hist: History): boolean {
	return hist.future.length > 0;
}

// -----------------------------------------------------------------------------
// Command builders
// -----------------------------------------------------------------------------

// Insert a single note. Inserts by note.time so `tab.notes` stays sorted —
// the renderer and playback both assume that order.
export function cmdAddNote(note: TabNote): Command {
	return {
		label: 'Add note',
		apply(tab) {
			insertSorted(tab.notes, note);
		},
		revert(tab) {
			const idx = tab.notes.findIndex((n) => n.id === note.id);
			if (idx >= 0) tab.notes.splice(idx, 1);
		}
	};
}

// Remove a note by id. Snapshots the removed note in the closure so revert
// can put it back exactly.
export function cmdRemoveNote(id: string): Command {
	let removed: TabNote | null = null;
	let removedIdx = -1;
	return {
		label: 'Delete note',
		apply(tab) {
			const idx = tab.notes.findIndex((n) => n.id === id);
			if (idx >= 0) {
				removed = tab.notes[idx];
				removedIdx = idx;
				tab.notes.splice(idx, 1);
			}
		},
		revert(tab) {
			if (removed) tab.notes.splice(removedIdx, 0, removed);
		}
	};
}

// Full-note patch — updates any subset of fields on a note, keeping the
// list sorted by time in case `time` changed.
export type NotePatch = Partial<
	Pick<
		TabNote,
		'time' | 'duration' | 'stringIndex' | 'fret' | 'midi' | 'velocity' | 'channel' | 'articulations'
	>
>;

export function cmdUpdateNote(id: string, patch: NotePatch): Command {
	let before: TabNote | null = null;
	return {
		label: 'Edit note',
		apply(tab) {
			const idx = tab.notes.findIndex((n) => n.id === id);
			if (idx < 0) return;
			before = { ...tab.notes[idx], articulations: [...tab.notes[idx].articulations] };
			const merged: TabNote = { ...tab.notes[idx], ...patch };
			// Vibrato ranges are stored in absolute song time, so they have
			// to travel with the note when it's moved in time.
			if (patch.time !== undefined && !patch.articulations) {
				merged.articulations = shiftTimedArticulations(
					merged.articulations,
					patch.time - before.time
				);
			}
			// A natural harmonic's pitch depends on the fret it's played at.
			if (patch.fret !== undefined) {
				merged.articulations = retuneHarmonic(merged.articulations, patch.fret);
			}
			tab.notes.splice(idx, 1);
			insertSorted(tab.notes, merged);
		},
		revert(tab) {
			if (!before) return;
			const idx = tab.notes.findIndex((n) => n.id === id);
			if (idx < 0) return;
			tab.notes.splice(idx, 1);
			insertSorted(tab.notes, before);
		}
	};
}

// Toggle a single-flag articulation (palmMute / ghost / harmonic / tap /
// hammerOn / pullOff). When add=true and it's missing, add it. When
// add=false and it's present, remove it.
export function cmdSetArticulation(id: string, art: Articulation, present: boolean): Command {
	let before: Articulation[] | null = null;
	return {
		label: (present ? 'Add ' : 'Remove ') + art.kind,
		apply(tab) {
			const n = tab.notes.find((x) => x.id === id);
			if (!n) return;
			before = [...n.articulations];
			// Remove any of the same kind first (so we don't get duplicates).
			n.articulations = n.articulations.filter((a) => a.kind !== art.kind);
			if (present) n.articulations.push(art);
		},
		revert(tab) {
			const n = tab.notes.find((x) => x.id === id);
			if (n && before) n.articulations = before;
		}
	};
}

// Batch several commands into one undoable step (e.g. placing a chord).
export function batchCommand(label: string, cmds: Command[]): Command {
	return {
		label,
		apply(tab) {
			for (const c of cmds) c.apply(tab);
		},
		revert(tab) {
			for (let i = cmds.length - 1; i >= 0; i--) cmds[i].revert(tab);
		}
	};
}

// Hammer-on vs pull-off is derived from the previous note on the same
// string (lower fret before → hammer, higher → pull). Appended to edit
// batches so that editing, moving or deleting a neighbour keeps every
// existing h/p pointing the right way. Notes with no usable predecessor
// (none, or same fret) are left alone.
export function cmdReconcileHammerPull(): Command {
	const changed: Array<{ id: string; before: Articulation[] }> = [];
	return {
		label: 'Reconcile hammer/pull',
		apply(tab) {
			changed.length = 0;
			const lastOnString = new Map<number, TabNote>();
			for (const n of tab.notes) {
				const prev = lastOnString.get(n.stringIndex);
				lastOnString.set(n.stringIndex, n);
				const isH = n.articulations.some((a) => a.kind === 'hammerOn');
				const isP = n.articulations.some((a) => a.kind === 'pullOff');
				if ((!isH && !isP) || !prev || prev.fret === n.fret) continue;
				const want = prev.fret < n.fret ? 'hammerOn' : 'pullOff';
				if ((want === 'hammerOn' && isH && !isP) || (want === 'pullOff' && isP && !isH)) continue;
				changed.push({ id: n.id, before: n.articulations });
				n.articulations = [
					...n.articulations.filter((a) => a.kind !== 'hammerOn' && a.kind !== 'pullOff'),
					{ kind: want }
				];
			}
		},
		revert(tab) {
			for (const c of changed) {
				const n = tab.notes.find((x) => x.id === c.id);
				if (n) n.articulations = c.before;
			}
		}
	};
}

// -----------------------------------------------------------------------------
// Doc helpers
// -----------------------------------------------------------------------------

// A blank authoring tab. `bpm` and `timeSignature` come from the New-tab
// dialog; duration seeds a couple of bars so there's room to click on.
export function makeEmptyTab(opts: {
	bpm: number;
	timeSignature: [number, number];
	bars: number;
}): Tab {
	const [beatsPerBar] = opts.timeSignature;
	const secondsPerBeat = 60 / opts.bpm;
	const secondsPerBar = beatsPerBar * secondsPerBeat;
	return {
		notes: [],
		bpm: opts.bpm,
		timeSignature: opts.timeSignature,
		secondsPerBar,
		durationSec: secondsPerBar * opts.bars,
		trimmedLeadingSec: 0
	};
}

// Change the tempo keeping every note on its beat: note times, lengths and
// timed articulations scale with the bar length, as does the tab's length.
export function cmdSetTempo(bpm: number): Command {
	let before: {
		bpm: number;
		secondsPerBar: number;
		durationSec: number;
		notes: Map<string, Pick<TabNote, 'time' | 'duration' | 'articulations'>>;
	} | null = null;
	return {
		label: 'Set tempo',
		apply(tab) {
			before = {
				bpm: tab.bpm,
				secondsPerBar: tab.secondsPerBar,
				durationSec: tab.durationSec,
				notes: new Map(
					tab.notes.map((n) => [
						n.id,
						{ time: n.time, duration: n.duration, articulations: n.articulations }
					])
				)
			};
			const k = tab.bpm / bpm;
			for (const n of tab.notes) {
				n.time *= k;
				n.duration *= k;
				n.articulations = n.articulations.map((a) =>
					a.kind === 'vibrato' ? { ...a, startTime: a.startTime * k, endTime: a.endTime * k } : a
				);
			}
			tab.bpm = bpm;
			tab.secondsPerBar = tab.timeSignature[0] * (60 / bpm);
			tab.durationSec *= k;
		},
		revert(tab) {
			if (!before) return;
			// Restore the exact values (no rounding drift from scaling back).
			for (const n of tab.notes) {
				const b = before.notes.get(n.id);
				if (!b) continue;
				n.time = b.time;
				n.duration = b.duration;
				n.articulations = b.articulations;
			}
			tab.bpm = before.bpm;
			tab.secondsPerBar = before.secondsPerBar;
			tab.durationSec = before.durationSec;
		}
	};
}

// Extend a tab's duration to at least the given time (e.g. so the user can
// click past the current end). Snaps to whole bars.
export function extendDurationTo(tab: Tab, atLeastSec: number): Command | null {
	if (tab.durationSec >= atLeastSec) return null;
	const bars = Math.ceil(atLeastSec / tab.secondsPerBar);
	const newDur = bars * tab.secondsPerBar;
	const prev = tab.durationSec;
	return {
		label: 'Extend duration',
		apply(t) {
			t.durationSec = newDur;
		},
		revert(t) {
			t.durationSec = prev;
		}
	};
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

export function shiftTimedArticulations(arts: Articulation[], dt: number): Articulation[] {
	if (dt === 0) return arts;
	return arts.map((a) =>
		a.kind === 'vibrato' ? { ...a, startTime: a.startTime + dt, endTime: a.endTime + dt } : a
	);
}

function insertSorted(notes: TabNote[], note: TabNote): void {
	// Notes are usually appended near the end, so start scanning from there.
	let i = notes.length;
	while (i > 0 && notes[i - 1].time > note.time) i--;
	notes.splice(i, 0, note);
}
