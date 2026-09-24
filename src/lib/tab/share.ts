// Shareable-link encoding for tabs. A tab is packed into a compact binary
// form, deflate-compressed and base64url-encoded so it fits in a URL
// fragment (#tab=…) — a full song is typically 1–3k characters, a riff a
// few hundred. Nothing goes to a server.
//
// The format isn't frozen yet: it can change freely while the app is in
// flux (links are for quick sharing, not storage). The version byte just
// turns an outdated link into a clear error instead of a garbled tab.
//
// Binary layout. Integers are unsigned LEB128 varints unless
// noted; "zz" = zigzag-encoded signed varint.
//   u8   version
//   var  bpm × 100
//   var  seconds per bar × 1e6
//   u8   time signature numerator, u8 denominator
//   str  tuning key (var length + UTF-8)
//   var  bars
//   zz   video offset, ms
//   zz   trimmed leading silence, ms
//   var  note count
//   per note, sorted by time (times in ticks, PPQ quarter-note ticks):
//     var  ticks since the previous note
//     u8   string (bits 0–2) | has-articulations (bit 3)
//     u8   fret
//     u8   velocity × 127
//     var  duration in ticks
//     [u8 articulation count, then each articulation: u8 code + params]
// MIDI pitch isn't stored: it's the tuning's open string + fret.

import type { Articulation, Tab, TabNote } from './types';

export type SharedTab = { tab: Tab; tuningKey: string; videoOffsetSec: number };

const VERSION = 1;
const PPQ = 480;

// Articulation codes.
const CODE = {
	palmMute: 1,
	ghost: 2,
	hammerOn: 3,
	pullOff: 4,
	tap: 5,
	letRing: 6,
	slideUp: 7,
	slideDown: 8,
	graceSlide: 9,
	bend: 10,
	bendRelease: 11,
	harmonic: 12,
	pinchHarmonic: 13,
	vibrato: 14
} as const;

// ---- bytes -----------------------------------------------------------------

class Writer {
	bytes: number[] = [];
	u8(v: number) {
		this.bytes.push(v & 0xff);
	}
	varint(v: number) {
		v = Math.max(0, Math.round(v));
		while (v > 127) {
			this.bytes.push((v % 128) | 128);
			v = Math.floor(v / 128);
		}
		this.bytes.push(v);
	}
	zz(v: number) {
		v = Math.round(v);
		this.varint(v >= 0 ? v * 2 : -v * 2 - 1);
	}
	str(s: string) {
		const b = new TextEncoder().encode(s);
		this.varint(b.length);
		for (const x of b) this.bytes.push(x);
	}
}

class Reader {
	pos = 0;
	constructor(private b: Uint8Array) {}
	u8(): number {
		if (this.pos >= this.b.length) throw new Error('Link data is cut short');
		return this.b[this.pos++];
	}
	varint(): number {
		let v = 0;
		let mul = 1;
		for (;;) {
			const x = this.u8();
			v += (x & 127) * mul;
			if (x < 128) return v;
			mul *= 128;
		}
	}
	zz(): number {
		const v = this.varint();
		return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
	}
	str(): string {
		const n = this.varint();
		const s = new TextDecoder().decode(this.b.subarray(this.pos, this.pos + n));
		this.pos += n;
		return s;
	}
}

// ---- tab <-> bytes -----------------------------------------------------------

function writeArticulation(
	w: Writer,
	a: Articulation,
	noteTicks: number,
	toTicks: (t: number) => number
) {
	switch (a.kind) {
		case 'slideUp':
		case 'slideDown':
		case 'graceSlide':
			w.u8(CODE[a.kind]);
			w.u8(a.fromSemitones);
			break;
		case 'bend':
		case 'bendRelease':
			w.u8(CODE[a.kind]);
			w.u8(a.semitones);
			break;
		case 'harmonic':
			w.u8(a.pinch ? CODE.pinchHarmonic : CODE.harmonic);
			w.u8(a.semitones);
			break;
		case 'vibrato': {
			w.u8(CODE.vibrato);
			const start = toTicks(a.startTime);
			w.zz(start - noteTicks);
			w.varint(toTicks(a.endTime) - start);
			break;
		}
		default:
			w.u8(CODE[a.kind]);
	}
}

function readArticulation(
	r: Reader,
	noteTicks: number,
	toSec: (t: number) => number
): Articulation {
	const code = r.u8();
	switch (code) {
		case CODE.palmMute:
			return { kind: 'palmMute' };
		case CODE.ghost:
			return { kind: 'ghost' };
		case CODE.hammerOn:
			return { kind: 'hammerOn' };
		case CODE.pullOff:
			return { kind: 'pullOff' };
		case CODE.tap:
			return { kind: 'tap' };
		case CODE.letRing:
			return { kind: 'letRing' };
		case CODE.slideUp:
			return { kind: 'slideUp', fromSemitones: r.u8() };
		case CODE.slideDown:
			return { kind: 'slideDown', fromSemitones: r.u8() };
		case CODE.graceSlide:
			return { kind: 'graceSlide', fromSemitones: r.u8() };
		case CODE.bend:
			return { kind: 'bend', semitones: r.u8() };
		case CODE.bendRelease:
			return { kind: 'bendRelease', semitones: r.u8() };
		case CODE.harmonic:
			return { kind: 'harmonic', semitones: r.u8() };
		case CODE.pinchHarmonic:
			return { kind: 'harmonic', semitones: r.u8(), pinch: true };
		case CODE.vibrato: {
			const start = noteTicks + r.zz();
			const end = start + r.varint();
			return { kind: 'vibrato', startTime: toSec(start), endTime: toSec(end) };
		}
		default:
			throw new Error(`Unknown articulation in link (${code})`);
	}
}

function tabToBytes(s: SharedTab): Uint8Array {
	const { tab } = s;
	const w = new Writer();
	const ticksPerSec = (tab.bpm / 60) * PPQ;
	const toTicks = (t: number) => Math.round(t * ticksPerSec);
	w.u8(VERSION);
	w.varint(tab.bpm * 100);
	w.varint(tab.secondsPerBar * 1e6);
	w.u8(tab.timeSignature[0]);
	w.u8(tab.timeSignature[1]);
	w.str(s.tuningKey);
	w.varint(tab.secondsPerBar > 0 ? tab.durationSec / tab.secondsPerBar : 0);
	w.zz(s.videoOffsetSec * 1000);
	w.zz(tab.trimmedLeadingSec * 1000);
	const notes = [...tab.notes].sort((a, b) => a.time - b.time);
	w.varint(notes.length);
	let prev = 0;
	for (const n of notes) {
		const ticks = Math.max(prev, toTicks(n.time));
		w.varint(ticks - prev);
		prev = ticks;
		const arts = n.articulations ?? [];
		w.u8((n.stringIndex & 7) | (arts.length ? 8 : 0));
		w.u8(n.fret);
		w.u8(Math.max(0, Math.min(127, Math.round(n.velocity * 127))));
		w.varint(toTicks(n.duration));
		if (arts.length) {
			w.u8(arts.length);
			for (const a of arts) writeArticulation(w, a, ticks, toTicks);
		}
	}
	return Uint8Array.from(w.bytes);
}

function bytesToTab(bytes: Uint8Array, openNotes: (tuningKey: string) => number[]): SharedTab {
	const r = new Reader(bytes);
	const version = r.u8();
	if (version !== VERSION)
		throw new Error('This link was made with a different version of Tabutabu and can’t be opened');
	const bpm = r.varint() / 100;
	const secondsPerBar = r.varint() / 1e6;
	const timeSignature: [number, number] = [r.u8(), r.u8()];
	const tuningKey = r.str();
	const bars = r.varint();
	const videoOffsetSec = r.zz() / 1000;
	const trimmedLeadingSec = r.zz() / 1000;
	const open = openNotes(tuningKey);
	const secPerTick = 60 / bpm / PPQ;
	const toSec = (t: number) => t * secPerTick;
	const count = r.varint();
	const notes: TabNote[] = [];
	let ticks = 0;
	for (let i = 0; i < count; i++) {
		ticks += r.varint();
		const b = r.u8();
		const stringIndex = b & 7;
		const fret = r.u8();
		const velocity = r.u8() / 127;
		const duration = toSec(r.varint());
		const articulations: Articulation[] = [];
		if (b & 8) {
			const n = r.u8();
			for (let k = 0; k < n; k++) articulations.push(readArticulation(r, ticks, toSec));
		}
		notes.push({
			id: '',
			time: toSec(ticks),
			duration,
			stringIndex,
			fret,
			midi: (open[stringIndex] ?? 40) + fret,
			velocity,
			channel: 0,
			articulations
		});
	}
	return {
		tuningKey,
		videoOffsetSec,
		tab: {
			notes,
			bpm,
			timeSignature,
			secondsPerBar,
			durationSec: bars * secondsPerBar,
			trimmedLeadingSec
		}
	};
}

// ---- compression + base64url ---------------------------------------------

async function pipeThrough(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
	const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
	return new Uint8Array(await new Response(out).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
	let bin = '';
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
	const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function encodeShare(s: SharedTab): Promise<string> {
	return toBase64Url(await pipeThrough(tabToBytes(s), new CompressionStream('deflate-raw')));
}

// `openNotes` maps a tuning key to its open-string MIDI notes (fallback for
// unknown keys is up to the caller). Note ids are left empty for the caller
// to assign.
export async function decodeShare(
	payload: string,
	openNotes: (tuningKey: string) => number[]
): Promise<SharedTab> {
	let bytes: Uint8Array;
	try {
		bytes = await pipeThrough(
			fromBase64Url(payload.trim()),
			new DecompressionStream('deflate-raw')
		);
	} catch {
		throw new Error("This link's tab data is damaged or incomplete");
	}
	return bytesToTab(bytes, openNotes);
}

// Pull the tab payload out of whatever a gist holds: a full share link, a
// "#tab=…" fragment, or just the payload itself.
export function payloadFromText(text: string): string {
	const m = text.match(/[#&]tab=([A-Za-z0-9_-]+)/);
	return (m ? m[1] : text).trim();
}

// Accepts a gist id, "user/id", or a gist URL; returns the gist id.
export function gistIdFrom(ref: string): string {
	const parts = decodeURIComponent(ref).split(/[/?#]/).filter(Boolean);
	return parts[parts.length - 1] ?? '';
}

// Fetch a public GitHub gist and return the tab payload from its first file.
export async function fetchGistPayload(ref: string): Promise<string> {
	const id = gistIdFrom(ref);
	if (!/^[0-9a-f]+$/i.test(id)) throw new Error(`"${ref}" doesn't look like a gist id`);
	const res = await fetch(`https://api.github.com/gists/${id}`, {
		headers: { Accept: 'application/vnd.github+json' }
	});
	if (!res.ok) throw new Error(`Couldn't load gist ${id} (GitHub said ${res.status})`);
	const gist = (await res.json()) as { files?: Record<string, { content?: string }> };
	const file = Object.values(gist.files ?? {})[0];
	if (!file?.content) throw new Error(`Gist ${id} has no content`);
	return payloadFromText(file.content);
}
