// MIDI file export: the tab's notes plus its tempo map (every tempo and
// time-signature change, at its bar), for bringing the bar structure into a
// DAW. Bar 1 starts at the file's start.

import midiPkg from '@tonejs/midi';
import { parseMidi, writeMidi } from 'midi-file';
import type { Tab } from '../tab/types';
import { barAt, barInfo, tempoChanges } from '../tab/tempo';
const { Midi } = midiPkg;

// The first two pads of a drum machine (Bitwig's Drum Machine starts at C1):
// beat 1 on the first, the other beats on the second — each pad plays its
// own sample unpitched. (A plain sampler would transpose one sample.)
const CLICK_DOWNBEAT = 36;
const CLICK_BEAT = 37;

// One bar of metronome to loop in a DAW: a note per beat, the higher one on
// beat 1, on the drum channel. Notes are placed in beats, so the clip plays
// at whatever tempo the DAW runs.
export function metronomeBarMidi(
	timeSignature: [number, number],
	bpm: number,
	name: string
): Uint8Array {
	const midi = new Midi();
	const ppq = midi.header.ppq;
	midi.header.name = name;
	midi.header.tempos.push({ ticks: 0, bpm });
	midi.header.timeSignatures.push({
		ticks: 0,
		timeSignature: [timeSignature[0], timeSignature[1]]
	});
	midi.header.update();
	const track = midi.addTrack();
	track.name = name;
	track.channel = 9;
	const beat = ppq * (4 / timeSignature[1]);
	for (let i = 0; i < timeSignature[0]; i++) {
		track.addNote({
			midi: i === 0 ? CLICK_DOWNBEAT : CLICK_BEAT,
			ticks: Math.round(i * beat),
			durationTicks: Math.round(ppq / 4),
			velocity: i === 0 ? 100 / 127 : 80 / 127
		});
	}
	// The clip is exactly one bar long.
	track.addCC({ number: 123, value: 0, ticks: Math.round(timeSignature[0] * beat) - 1 });
	return withoutProgramChanges(midi.toArray());
}

// The MIDI library always writes an instrument (program) change; a click
// track shouldn't switch the receiving instrument's sound.
function withoutProgramChanges(bytes: Uint8Array): Uint8Array {
	const parsed = parseMidi(bytes);
	parsed.tracks = parsed.tracks.map((track) => {
		let carry = 0;
		const out: typeof track = [];
		for (const e of track) {
			if (e.type === 'programChange') {
				carry += e.deltaTime;
				continue;
			}
			out.push({ ...e, deltaTime: e.deltaTime + carry });
			carry = 0;
		}
		return out;
	});
	return Uint8Array.from(writeMidi(parsed));
}

export function tabToMidi(tab: Tab, name: string): Uint8Array {
	const midi = new Midi();
	const ppq = midi.header.ppq;
	const changes = tempoChanges(tab);
	const ticksPerBar = (ts: [number, number]) => ts[0] * (4 / ts[1]) * ppq;

	// Tick where each section starts.
	const sectionTicks: number[] = [];
	let ticks = 0;
	for (let i = 0; i < changes.length; i++) {
		if (i > 0)
			ticks += (changes[i].bar - changes[i - 1].bar) * ticksPerBar(changes[i - 1].timeSignature);
		sectionTicks.push(ticks);
	}
	// Song time → ticks: the bar it's in, plus quarter notes into the bar.
	const toTicks = (t: number) => {
		const b = barAt(tab, Math.max(0, t));
		const c = changes[b.section];
		const barTicks = sectionTicks[b.section] + (b.index - c.bar) * ticksPerBar(c.timeSignature);
		return Math.round(barTicks + ((t - b.start) / (60 / b.bpm)) * ppq);
	};

	midi.header.name = name;
	changes.forEach((c, i) => {
		midi.header.tempos.push({ ticks: sectionTicks[i], bpm: c.bpm });
		midi.header.timeSignatures.push({
			ticks: sectionTicks[i],
			timeSignature: [c.timeSignature[0], c.timeSignature[1]],
			measures: c.bar
		});
	});
	midi.header.update();

	const track = midi.addTrack();
	track.name = name;
	for (const n of tab.notes) {
		const start = toTicks(n.time);
		const end = Math.max(start + 1, toTicks(n.time + n.duration));
		track.addNote({
			midi: n.midi,
			ticks: start,
			durationTicks: end - start,
			velocity: Math.max(0.05, Math.min(1, n.velocity))
		});
	}
	// Run the file to the tab's end (some programs ignore tempo changes past
	// the last event): a harmless "all notes off" there.
	const endBar = barAt(tab, Math.max(0, tab.durationSec - 1e-3));
	const end = barInfo(tab, endBar.index + 1).start;
	track.addCC({ number: 123, value: 0, ticks: toTicks(end) });
	return midi.toArray();
}
