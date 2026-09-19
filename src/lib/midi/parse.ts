import midiPkg from '@tonejs/midi';
const { Midi } = midiPkg;
import type { Tuning } from '../tab/tuning';
import type { Tab } from '../tab/types';
import { arrange, DEFAULT_ARRANGE_OPTIONS, type ArrangeOptions, type RawNote } from './arrange';
import { classifyNote, DEFAULT_THRESHOLDS, type ClassifyThresholds } from './articulate';
import {
	DEFAULT_EXTRACT_OPTIONS,
	extractExpressions,
	type ExtractOptions
} from './expressions';

export type ParseOptions = ArrangeOptions & {
	extract: ExtractOptions;
	thresholds: ClassifyThresholds;
	// When true, the leading silence in the file is preserved (song time 0 = DAW
	// bar 1 beat 1). Useful for DAW sync — otherwise auto-trim shifts the whole
	// timeline so the first note lands at 0, which desyncs the playhead.
	keepLeadingSilence: boolean;
};

export const DEFAULT_PARSE_OPTIONS: ParseOptions = {
	...DEFAULT_ARRANGE_OPTIONS,
	extract: DEFAULT_EXTRACT_OPTIONS,
	thresholds: DEFAULT_THRESHOLDS,
	keepLeadingSilence: false
};

export async function parseMidiFile(
	file: File,
	tuning: Tuning,
	options?: Partial<ParseOptions>
): Promise<Tab> {
	const buf = await file.arrayBuffer();
	return parseMidi(buf, tuning, options);
}

export function parseMidi(
	buffer: ArrayBuffer,
	tuning: Tuning,
	options: Partial<ParseOptions> = {}
): Tab {
	const opts: ParseOptions = { ...DEFAULT_PARSE_OPTIONS, ...options };
	const midi = new Midi(buffer);
	const expressions = extractExpressions(buffer, midi.header, opts.extract);

	const raw: RawNote[] = [];
	let maxEnd = 0;
	let firstNote = Infinity;
	for (const track of midi.tracks) {
		for (const n of track.notes) {
			const channelExpr = expressions.get(track.channel);
			const articulations = classifyNote(
				n.time,
				n.time + n.duration,
				n.velocity,
				n.midi,
				channelExpr,
				opts.thresholds
			);
			raw.push({
				time: n.time,
				duration: n.duration,
				midi: n.midi,
				velocity: n.velocity,
				channel: track.channel,
				articulations
			});
			const end = n.time + n.duration;
			if (end > maxEnd) maxEnd = end;
			if (n.time < firstNote) firstNote = n.time;
		}
	}

	const offset = !opts.keepLeadingSilence && raw.length > 0 && firstNote > 0 ? firstNote : 0;
	if (offset > 0) {
		for (const n of raw) {
			n.time -= offset;
			for (const a of n.articulations) {
				if ('startTime' in a) a.startTime -= offset;
				if ('endTime' in a) a.endTime -= offset;
			}
		}
		maxEnd -= offset;
	}

	const notes = arrange(raw, tuning, opts);
	const bpm = midi.header.tempos[0]?.bpm ?? 120;
	const ts = midi.header.timeSignatures[0]?.timeSignature ?? [4, 4];
	const timeSignature: [number, number] = [ts[0], ts[1]];
	const secondsPerBar = (timeSignature[0] * (4 / timeSignature[1]) * 60) / bpm;
	return {
		notes,
		durationSec: maxEnd,
		bpm,
		timeSignature,
		secondsPerBar,
		trimmedLeadingSec: offset
	};
}
