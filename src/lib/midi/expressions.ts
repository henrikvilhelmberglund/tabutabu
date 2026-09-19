// Extracts per-channel expression curves (pitch bend, channel pressure, CCs)
// from a raw MIDI buffer. @tonejs/midi surfaces pitch bend and control-change
// events but drops channel pressure, so we re-parse with midi-file to pick it
// up. All timestamps are in seconds using @tonejs/midi's header for tempo map.

import { parseMidi, type MidiEvent } from 'midi-file';
import type midiPkg from '@tonejs/midi';

type Header = InstanceType<typeof midiPkg.Midi>['header'];

export type ExpressionSample = { time: number; value: number };

export type ChannelExpressions = {
	// Semitones. Combines pitch-bend range (defaulted per-channel) with raw ±8192 values.
	pitchBendSemitones: ExpressionSample[];
	// Channel pressure normalized 0..1.
	pressure: ExpressionSample[];
	// Polyphonic aftertouch keyed by MIDI note number, values 0..1. This is how
	// Bitwig exports per-note Pressure when the target is standard MIDI (non-MPE).
	polyAftertouch: Map<number, ExpressionSample[]>;
	// Control-change values keyed by CC number, raw 0..127.
	cc: Map<number, ExpressionSample[]>;
};

export type ExpressionMap = Map<number, ChannelExpressions>;

export type ExtractOptions = {
	// Semitone range that corresponds to a full ±8192 pitch-bend deflection.
	// Bitwig MPE default is 48. Standard MIDI is 2.
	pitchBendRangeSemitones: number;
};

export const DEFAULT_EXTRACT_OPTIONS: ExtractOptions = {
	pitchBendRangeSemitones: 48
};

export type MidiInspection = {
	// Per channel: counts of event kinds seen. Useful for figuring out where
	// expression data actually lives in the file.
	channels: Map<
		number,
		{
			notes: number;
			pitchBends: number;
			pressure: number;
			polyAftertouch: number;
			ccs: Map<number, number>;
		}
	>;
};

export function inspectMidi(buffer: ArrayBuffer): MidiInspection {
	const raw = parseMidi(new Uint8Array(buffer));
	const channels = new Map<number, MidiInspection['channels'] extends Map<number, infer V> ? V : never>();
	const getCh = (c: number) => {
		let x = channels.get(c);
		if (!x) {
			x = { notes: 0, pitchBends: 0, pressure: 0, polyAftertouch: 0, ccs: new Map() };
			channels.set(c, x);
		}
		return x;
	};
	for (const trackEvents of raw.tracks) {
		for (const ev of trackEvents as MidiEvent[]) {
			if (!('channel' in ev)) continue;
			const c = getCh(ev.channel);
			switch (ev.type) {
				case 'noteOn':
					if (ev.velocity > 0) c.notes++;
					break;
				case 'pitchBend':
					c.pitchBends++;
					break;
				case 'channelAftertouch':
					c.pressure++;
					break;
				case 'noteAftertouch':
					c.polyAftertouch++;
					break;
				case 'controller':
					c.ccs.set(ev.controllerType, (c.ccs.get(ev.controllerType) ?? 0) + 1);
					break;
			}
		}
	}
	return { channels };
}

export function extractExpressions(
	buffer: ArrayBuffer,
	header: Header,
	options: ExtractOptions = DEFAULT_EXTRACT_OPTIONS
): ExpressionMap {
	const raw = parseMidi(new Uint8Array(buffer));
	const bendScale = options.pitchBendRangeSemitones / 8192;
	const map: ExpressionMap = new Map();

	const getCh = (channel: number): ChannelExpressions => {
		let c = map.get(channel);
		if (!c) {
			c = {
				pitchBendSemitones: [],
				pressure: [],
				polyAftertouch: new Map(),
				cc: new Map()
			};
			map.set(channel, c);
		}
		return c;
	};

	for (const trackEvents of raw.tracks) {
		let ticks = 0;
		for (const ev of trackEvents as MidiEvent[]) {
			ticks += ev.deltaTime;
			if (!('channel' in ev)) continue;
			const time = header.ticksToSeconds(ticks);
			const channel = ev.channel;
			switch (ev.type) {
				case 'pitchBend': {
					getCh(channel).pitchBendSemitones.push({ time, value: ev.value * bendScale });
					break;
				}
				case 'channelAftertouch': {
					getCh(channel).pressure.push({ time, value: ev.amount / 127 });
					break;
				}
				case 'noteAftertouch': {
					const pa = getCh(channel).polyAftertouch;
					const arr = pa.get(ev.noteNumber) ?? [];
					arr.push({ time, value: ev.amount / 127 });
					pa.set(ev.noteNumber, arr);
					break;
				}
				case 'controller': {
					const cc = getCh(channel).cc;
					const arr = cc.get(ev.controllerType) ?? [];
					arr.push({ time, value: ev.value });
					cc.set(ev.controllerType, arr);
					break;
				}
			}
		}
	}

	for (const c of map.values()) {
		c.pitchBendSemitones.sort((a, b) => a.time - b.time);
		c.pressure.sort((a, b) => a.time - b.time);
		for (const arr of c.polyAftertouch.values()) arr.sort((a, b) => a.time - b.time);
		for (const arr of c.cc.values()) arr.sort((a, b) => a.time - b.time);
	}
	return map;
}

// Sample a step-hold expression curve at a given time. Returns 0 if there are
// no events at/before `at`.
export function sampleAt(events: ExpressionSample[], at: number): number {
	if (events.length === 0) return 0;
	// Binary search for the last event with time <= at.
	let lo = 0;
	let hi = events.length - 1;
	if (events[0].time > at) return 0;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (events[mid].time <= at) lo = mid;
		else hi = mid - 1;
	}
	return events[lo].value;
}

export function maxAbsInWindow(
	events: ExpressionSample[],
	start: number,
	end: number
): number {
	let m = 0;
	for (const e of events) {
		if (e.time < start) continue;
		if (e.time > end) break;
		const a = Math.abs(e.value);
		if (a > m) m = a;
	}
	return m;
}
