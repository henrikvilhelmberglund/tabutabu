// Parses a Bitwig-style .dawproject archive. The container is a ZIP holding
// project.xml with per-note expression envelopes preserved (transpose, pressure,
// timbre). That gives us slides/bends/harmonics/vibrato/hammer/pull/tap without
// losing anything to the plain-MIDI export conversion.
//
// Schema notes (from Bitwig's dawproject 1.0):
//   Transport > Tempo (BPM), TimeSignature (num/denom)
//   Arrangement > Lanes(timeUnit="beats") > Lanes(track=id) > Clips > Clip(time,duration) >
//     Notes > Note(time, duration, channel, key, vel, rel)
//       Points(unit) > Target(expression="transpose"|"pressure"|"timbre") + RealPoint(value, time)
//   All note/point times are BEATS relative to their parent (clip / note).

import JSZip from 'jszip';
import type { Tuning } from '../tab/tuning';
import type { Tab } from '../tab/types';
import {
	arrange,
	DEFAULT_ARRANGE_OPTIONS,
	type ArrangeOptions,
	type RawNote
} from '../midi/arrange';
import { classifyNote, DEFAULT_THRESHOLDS, type ClassifyThresholds } from '../midi/articulate';
import type { ChannelExpressions, ExpressionSample } from '../midi/expressions';

export type DawprojectOptions = ArrangeOptions & {
	thresholds: ClassifyThresholds;
	keepLeadingSilence: boolean;
};

export const DEFAULT_DAWPROJECT_OPTIONS: DawprojectOptions = {
	...DEFAULT_ARRANGE_OPTIONS,
	thresholds: DEFAULT_THRESHOLDS,
	keepLeadingSilence: false
};

export async function parseDawproject(
	buffer: ArrayBuffer,
	tuning: Tuning,
	options: Partial<DawprojectOptions> = {}
): Promise<Tab> {
	const opts: DawprojectOptions = { ...DEFAULT_DAWPROJECT_OPTIONS, ...options };
	const zip = await JSZip.loadAsync(buffer);
	const projectFile = zip.file('project.xml');
	if (!projectFile) throw new Error('project.xml not found inside .dawproject');
	const xmlText = await projectFile.async('text');
	const doc = new DOMParser().parseFromString(xmlText, 'application/xml');

	const parseErr = doc.querySelector('parsererror');
	if (parseErr) throw new Error('Could not parse project.xml: ' + parseErr.textContent);

	// Transport
	const tempoEl = doc.querySelector('Transport > Tempo');
	const bpm = tempoEl ? parseFloat(tempoEl.getAttribute('value') ?? '120') : 120;
	const tsEl = doc.querySelector('Transport > TimeSignature');
	const timeSignature: [number, number] = [
		tsEl ? parseInt(tsEl.getAttribute('numerator') ?? '4') : 4,
		tsEl ? parseInt(tsEl.getAttribute('denominator') ?? '4') : 4
	];

	const beatsToSec = (beats: number) => (beats * 60) / bpm;

	// Collect notes across all note-content tracks and their clips.
	const raw: RawNote[] = [];
	let maxEnd = 0;
	let firstNoteBeat = Infinity;
	type Miss = { absStartSec: number; midi: number; durSec: number; expr: ChannelExpressions };
	const misses: Miss[] = [];

	const clips = doc.querySelectorAll('Arrangement Clip');
	for (const clip of Array.from(clips)) {
		const clipTimeBeats = parseFloat(clip.getAttribute('time') ?? '0');
		const notes = clip.querySelectorAll(':scope > Notes > Note');
		for (const note of Array.from(notes)) {
			const nTimeBeats = parseFloat(note.getAttribute('time') ?? '0');
			const nDurBeats = parseFloat(note.getAttribute('duration') ?? '0');
			const midi = parseInt(note.getAttribute('key') ?? '0');
			const vel = parseFloat(note.getAttribute('vel') ?? '0.8');
			const channel = parseInt(note.getAttribute('channel') ?? '0');

			const absStartBeat = clipTimeBeats + nTimeBeats;
			const absStartSec = beatsToSec(absStartBeat);
			const durSec = beatsToSec(nDurBeats);
			const absEndSec = absStartSec + durSec;

			if (absStartBeat < firstNoteBeat) firstNoteBeat = absStartBeat;
			if (absEndSec > maxEnd) maxEnd = absEndSec;

			// Build synthetic per-note ChannelExpressions so the existing classifier
			// works unchanged. Times inside expression envelopes are relative to
			// the note; convert to absolute seconds.
			const expr: ChannelExpressions = {
				pitchBendSemitones: [],
				pressure: [],
				polyAftertouch: new Map(),
				cc: new Map()
			};
			// Bitwig uses two shapes: direct `<Note><Points>` when there's a single
			// expression, and `<Note><Lanes><Points>...<Points>` when a note carries
			// multiple expressions (e.g. pitch + pressure together). Collect both.
			const pointsBlocks: Element[] = [
				...Array.from(note.querySelectorAll(':scope > Points')),
				...Array.from(note.querySelectorAll(':scope > Lanes > Points'))
			];
			for (const points of pointsBlocks) {
				const target = points.querySelector(':scope > Target');
				const expression = target?.getAttribute('expression');
				if (!expression) continue;
				const samples: ExpressionSample[] = [];
				for (const rp of Array.from(points.querySelectorAll(':scope > RealPoint'))) {
					const relBeats = parseFloat(rp.getAttribute('time') ?? '0');
					const value = parseFloat(rp.getAttribute('value') ?? '0');
					samples.push({ time: absStartSec + beatsToSec(relBeats), value });
				}
				samples.sort((a, b) => a.time - b.time);
				switch (expression) {
					case 'transpose':
						expr.pitchBendSemitones = samples;
						break;
					case 'pressure':
						expr.pressure = samples;
						break;
					case 'timbre': {
						// Fake as CC74 raw 0..127 so the classifier's existing bipolar
						// decode (raw - 64) / 63 recovers the original -1..+1 value.
						const cc74 = samples.map((s) => ({
							time: s.time,
							value: (s.value + 1) * 63.5
						}));
						expr.cc.set(74, cc74);
						break;
					}
				}
			}

			const articulations = classifyNote(absStartSec, absEndSec, vel, midi, expr, opts.thresholds);
			// Diagnostic: defer logging until after we know the trim offset so
			// bar/beat positions match what's shown in the UI. Only flag notes
			// whose expression data actually carries a meaningful signal — an
			// all-zero envelope isn't a missed detection, it's a no-op.
			const meaningful =
				expr.pitchBendSemitones.some((s) => Math.abs(s.value) > 0.001) ||
				expr.pressure.some((s) => Math.abs(s.value) > 0.001) ||
				(expr.cc.get(74) ?? []).some((s) => Math.abs(s.value - 64) > 1);
			if (meaningful && articulations.length === 0) {
				misses.push({ absStartSec, midi, durSec, expr });
			}
			raw.push({
				time: absStartSec,
				duration: durSec,
				midi,
				velocity: vel,
				channel,
				articulations
			});
		}
	}

	const offset =
		!opts.keepLeadingSilence && raw.length > 0 && firstNoteBeat < Infinity
			? beatsToSec(firstNoteBeat)
			: 0;
	if (offset > 0) {
		for (const n of raw) {
			n.time -= offset;
			// Articulations that carry their own timestamps (like vibrato's pressure
			// window) need shifting too or they'll point to pre-trim absolute times.
			for (const a of n.articulations) {
				if ('startTime' in a) a.startTime -= offset;
				if ('endTime' in a) a.endTime -= offset;
			}
		}
		maxEnd -= offset;
	}

	const notes = arrange(raw, tuning, opts);
	const secondsPerBar = (timeSignature[0] * (4 / timeSignature[1]) * 60) / bpm;

	// Emit deferred diagnostics with song-relative times + bar/beat position.
	if (misses.length > 0) {
		const beatsPerBar = timeSignature[0];
		const secondsPerBeat = secondsPerBar / beatsPerBar;
		const shape = (label: string, samples: ExpressionSample[], noteStart: number) =>
			samples.length === 0
				? ''
				: `${label}: ${samples
						.map((s) => `${((s.time - noteStart) * 1000).toFixed(0)}ms=${s.value.toFixed(2)}`)
						.join(' → ')}`;
		for (const m of misses) {
			const songSec = m.absStartSec - offset;
			const bar = Math.floor(songSec / secondsPerBar) + 1;
			const beat = Math.floor((songSec % secondsPerBar) / secondsPerBeat) + 1;
			console.warn(
				`[tabutabu] Unclassified note bar ${bar} beat ${beat} (${songSec.toFixed(2)}s) midi=${m.midi} dur=${m.durSec.toFixed(3)}s`,
				{
					pitch: shape('pitch', m.expr.pitchBendSemitones, m.absStartSec),
					pressure: shape('pressure', m.expr.pressure, m.absStartSec),
					timbre: shape('timbre-cc74', m.expr.cc.get(74) ?? [], m.absStartSec)
				}
			);
		}
	}

	return {
		notes,
		durationSec: maxEnd,
		bpm,
		timeSignature,
		secondsPerBar,
		trimmedLeadingSec: offset
	};
}
