import type { Tab } from './types';
import type { Tuning } from './tuning';
import { STRING_COUNT } from './tuning';

export type RenderMode = 'page' | 'scroll';

// How to show "the current playhead position".
//   line:      thin vertical line at the exact time (default; smoothest)
//   beat:      translucent full-height column snapped to the current beat
//   bar:       translucent full-height column snapped to the current bar
// The stepped modes look cleaner when the browser is screen-recorded because
// the block only moves on beat/bar boundaries rather than sub-frame.
export type PlayheadStyle = 'line' | 'beat' | 'bar';
export type Theme = 'dark' | 'light';

export type RenderConfig = {
	width: number;
	height: number;
	mode: RenderMode;
	playheadStyle: PlayheadStyle;
	theme: Theme;
	stringFlashEnabled: boolean;
	// scroll-mode only
	pixelsPerSecond: number;
	playheadFraction: number;
	// page-mode only
	barsPerPage: number;
	// How many beats of the next page to show as a dimmed peek at the right edge.
	// 0 disables the peek. 1 beat is a nice "what's coming" hint without pulling
	// focus away from the current bar.
	peekBeats: number;
	paddingX: number;
	paddingTop: number;
	paddingBottom: number;
	showTuningLabel: boolean;
	// When false (default), notes are drawn as bare fret numbers at the onset,
	// matching traditional tab notation. When true, a duration bar trails the
	// note to indicate sustain length.
	showNoteLengths: boolean;
};

export const DEFAULT_RENDER_CONFIG: RenderConfig = {
	width: 1280,
	height: 260,
	mode: 'page',
	playheadStyle: 'line',
	theme: 'dark',
	stringFlashEnabled: false,
	pixelsPerSecond: 220,
	playheadFraction: 0.25,
	barsPerPage: 1,
	peekBeats: 0.5,
	paddingX: 68,
	// Vertical padding. Top has room for both the bar-number labels (top of
	// the canvas) AND the palm-mute / let-ring rows (PM_LANE_OFFSET,
	// LR_LANE_OFFSET above the top string). Bottom is
	// smaller because nothing draws below low-E.
	paddingTop: 50,
	paddingBottom: 24,
	showTuningLabel: true,
	showNoteLengths: false
};

type Palette = {
	bg: string;
	string: string;
	stringActive: string;
	barline: string;
	beatline: string;
	tuningLabel: string;
	playhead: string;
	playheadStepped: string;
	noteMask: string;
	noteTextIdle: string;
	noteTextActive: string;
	durationBarActive: string;
	durationBarIdle: string;
	barNumber: string;
	articulation: string;
	articulationActive: string;
	palmMute: string;
	playheadColumn: string;
	// Author-mode hover preview of a note that isn't placed yet.
	notePreview: string;
};

const PALETTE_DARK: Palette = {
	bg: '#0b0f14',
	string: '#3a4553',
	stringActive: '#dbe4f0',
	barline: '#4a5666',
	beatline: '#2a3543',
	tuningLabel: '#8a99ad',
	playhead: '#ff5577',
	playheadStepped: '#c8d1dc',
	// Mask matches the tab background — invisible on its own but opaque, so
	// vertical bar lines don't cut through the digits. Text stays white
	// (bright for active, softer white for idle) regardless of state.
	noteMask: '#0b0f14',
	noteTextIdle: '#dbe4f0',
	noteTextActive: '#ffffff',
	durationBarActive: 'rgba(255, 200, 90, 0.35)',
	durationBarIdle: 'rgba(120, 160, 220, 0.18)',
	barNumber: '#6b788a',
	articulation: '#a0aebd',
	articulationActive: '#ffffff',
	palmMute: '#a0b0c4',
	playheadColumn: 'rgba(255, 204, 85, 0.16)',
	notePreview: '#5aa9ff'
};

const PALETTE_LIGHT: Palette = {
	bg: '#ffffff',
	string: '#9aa3af',
	stringActive: '#1a1f26',
	barline: '#5a6270',
	beatline: '#d5dae0',
	tuningLabel: '#4a5060',
	playhead: '#d9314a',
	playheadStepped: '#5a6270',
	noteMask: '#ffffff',
	noteTextIdle: '#0a0a0a',
	noteTextActive: '#0a0a0a',
	durationBarActive: 'rgba(217, 119, 6, 0.28)',
	durationBarIdle: 'rgba(148, 163, 184, 0.22)',
	barNumber: '#5a6270',
	articulation: '#0a0a0a',
	articulationActive: '#0a0a0a',
	palmMute: '#3a3f47',
	playheadColumn: 'rgba(217, 119, 6, 0.18)',
	notePreview: '#1d6fd1'
};

// Module-level "current" palette swapped at the top of renderTabFrame based on
// the active theme. Kept as a single mutable ref so all the helper functions
// (drawStrings, drawNoteWithArticulations, etc.) don't need to be threaded
// with a palette param.
let COLORS: Palette = PALETTE_DARK;

// Colours for the author-mode hover preview of a note that isn't placed yet.
export function previewNoteColors(theme: Theme): { text: string; mask: string } {
	const p = theme === 'light' ? PALETTE_LIGHT : PALETTE_DARK;
	return { text: p.notePreview, mask: p.noteMask };
}

// Rows above the top string for the "PM" and "L.R." / "P.H." labels, given as
// the distance from the top string up to the row's centre line. Each label
// and its dashes share that centre line, so PM dashes can't cut into the
// row below.
export const PM_LANE_OFFSET = 25;
export const LR_LANE_OFFSET = 12;

export function renderTabFrame(
	ctx: CanvasRenderingContext2D,
	tab: Tab,
	tuning: Tuning,
	currentTime: number,
	cfg: RenderConfig
): void {
	COLORS = cfg.theme === 'light' ? PALETTE_LIGHT : PALETTE_DARK;
	ctx.fillStyle = COLORS.bg;
	ctx.fillRect(0, 0, cfg.width, cfg.height);

	if (cfg.mode === 'page') {
		renderPage(ctx, tab, tuning, currentTime, cfg);
	} else {
		renderScroll(ctx, tab, tuning, currentTime, cfg);
	}
}

// Page mode: the tab holds still, showing a fixed window of N bars. The playhead
// sweeps across from left to right; when it exits the right edge, the window
// jumps to the next N-bar block.
function renderPage(
	ctx: CanvasRenderingContext2D,
	tab: Tab,
	tuning: Tuning,
	currentTime: number,
	cfg: RenderConfig
): void {
	const { width, height, paddingX, paddingTop, paddingBottom, barsPerPage } = cfg;
	const pageDur = tab.secondsPerBar * barsPerPage;
	if (pageDur <= 0) return;

	const pageIndex = Math.floor(currentTime / pageDur);
	const pageStart = pageIndex * pageDur;
	const pageEnd = pageStart + pageDur;

	// Layout: the strip after left/right padding is split between the current page
	// and an optional peek at the next bar, sized in beats (not width fraction).
	const [beatsPerBar0] = tab.timeSignature;
	const secondsPerBeat0 = tab.secondsPerBar / beatsPerBar0;
	const peekDur = Math.max(0, cfg.peekBeats) * secondsPerBeat0;
	const totalDur = pageDur + peekDur;
	const usableWidth = width - paddingX * 2;
	const pxPerSec = usableWidth / totalDur;
	const timeToX = (t: number) => paddingX + (t - pageStart) * pxPerSec;
	const peekBoundaryX = timeToX(pageEnd);

	drawStrings(ctx, cfg, tuning);

	// Bar and beat gridlines, spanning the current page + the peek (1 extra bar
	// into the peek zone, drawn dimmer).
	const beatsPerBar = beatsPerBar0;
	const secondsPerBeat = secondsPerBeat0;
	const totalBars = barsPerPage + (peekDur > 0 ? Math.ceil(peekDur / tab.secondsPerBar) : 0);
	for (let i = 0; i <= totalBars; i++) {
		const t = pageStart + i * tab.secondsPerBar;
		const x = timeToX(t);
		if (x > width - paddingX + 1) break;
		ctx.strokeStyle = COLORS.barline;
		ctx.lineWidth = i === 0 || i === barsPerPage ? 2 : 1.5;
		ctx.globalAlpha = i > barsPerPage ? 0.5 : 1;
		ctx.beginPath();
		ctx.moveTo(x, paddingTop - 8);
		ctx.lineTo(x, height - paddingBottom + 8);
		ctx.stroke();
		ctx.globalAlpha = 1;
		if (i < totalBars) {
			ctx.fillStyle = COLORS.barNumber;
			ctx.globalAlpha = i >= barsPerPage ? 0.5 : 1;
			ctx.font = '600 15px "JetBrains Mono Variable", ui-monospace, Menlo, Consolas, monospace';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'top';
			ctx.fillText(String(pageIndex * barsPerPage + i + 1), x, 3);
			ctx.globalAlpha = 1;
		}
	}
	ctx.strokeStyle = COLORS.beatline;
	ctx.lineWidth = 1;
	for (let b = 0; b < totalBars; b++) {
		for (let beat = 1; beat < beatsPerBar; beat++) {
			const t = pageStart + b * tab.secondsPerBar + beat * secondsPerBeat;
			const x = timeToX(t);
			if (x > width - paddingX + 1) break;
			ctx.globalAlpha = b >= barsPerPage ? 0.5 : 1;
			ctx.beginPath();
			ctx.moveTo(x, paddingTop);
			ctx.lineTo(x, height - paddingBottom);
			ctx.stroke();
		}
	}
	ctx.globalAlpha = 1;

	// Playhead — either a thin line, a stepped-highlight column, or both.
	if (currentTime <= pageEnd) {
		drawPlayheadForStyle(
			ctx,
			cfg,
			currentTime,
			timeToX,
			tab.secondsPerBar,
			beatsPerBar0,
			paddingTop,
			height - paddingBottom
		);
	}

	// Notes: current page at full opacity, peek notes dimmed. Draw peek first,
	// then current, so hits at the boundary land on top of the peek.
	const usableHeight = height - paddingTop - paddingBottom;
	const stringGap = usableHeight / (STRING_COUNT - 1);
	const durToW = (dur: number) => dur * pxPerSec;

	if (peekDur > 0) {
		ctx.globalAlpha = 0.5;
		drawNotes(
			ctx,
			tab,
			cfg,
			currentTime,
			timeToX,
			durToW,
			stringGap,
			(n) => n.time >= pageEnd && n.time < pageEnd + peekDur + 0.5
		);
		ctx.globalAlpha = 1;

		// Divider between current page and peek zone
		ctx.strokeStyle = COLORS.barline;
		ctx.lineWidth = 2;
		ctx.setLineDash([4, 4]);
		ctx.globalAlpha = 0.6;
		ctx.beginPath();
		ctx.moveTo(peekBoundaryX, paddingTop - 12);
		ctx.lineTo(peekBoundaryX, height - paddingBottom + 12);
		ctx.stroke();
		ctx.setLineDash([]);
		ctx.globalAlpha = 1;
	}

	const visibleOnPage = (n: (typeof tab.notes)[number]) =>
		n.time < pageEnd && n.time + n.duration > pageStart;
	if (cfg.stringFlashEnabled) drawStringFlashes(ctx, tab, cfg, currentTime);
	drawNotes(ctx, tab, cfg, currentTime, timeToX, durToW, stringGap, visibleOnPage);
}

function renderScroll(
	ctx: CanvasRenderingContext2D,
	tab: Tab,
	tuning: Tuning,
	currentTime: number,
	cfg: RenderConfig
): void {
	const { width, height, playheadFraction, paddingX, paddingTop, paddingBottom } = cfg;

	// Derive pixels-per-second from the same bars/page + peek settings that
	// page mode uses so switching modes doesn't change the visual pace. Falls
	// back to the config's explicit pixelsPerSecond only if tempo/time-sig
	// aren't available.
	const [beatsPerBar] = tab.timeSignature;
	const secondsPerBeat = beatsPerBar > 0 ? tab.secondsPerBar / beatsPerBar : 0;
	const totalPageDur =
		cfg.barsPerPage * tab.secondsPerBar + Math.max(0, cfg.peekBeats) * secondsPerBeat;
	const usableWidth = width - paddingX * 2;
	const pixelsPerSecond =
		totalPageDur > 0 && usableWidth > 0 ? usableWidth / totalPageDur : cfg.pixelsPerSecond;

	drawStrings(ctx, cfg, tuning);

	const playheadX = width * playheadFraction;
	const timeToX = (t: number) => playheadX + (t - currentTime) * pixelsPerSecond;
	drawPlayheadForStyle(
		ctx,
		cfg,
		currentTime,
		timeToX,
		tab.secondsPerBar,
		tab.timeSignature[0],
		paddingTop,
		height - paddingBottom
	);

	const secondsLeft = playheadX / pixelsPerSecond;
	const secondsRight = (width - playheadX) / pixelsPerSecond;
	const tMin = currentTime - secondsLeft - 1;
	const tMax = currentTime + secondsRight + 0.5;

	const usableHeight = height - paddingTop - paddingBottom;
	const stringGap = usableHeight / (STRING_COUNT - 1);

	const visibleInScroll = (n: (typeof tab.notes)[number]) =>
		n.time <= tMax && n.time + n.duration >= tMin;
	if (cfg.stringFlashEnabled) drawStringFlashes(ctx, tab, cfg, currentTime);
	drawNotes(
		ctx,
		tab,
		cfg,
		currentTime,
		timeToX,
		(_t, dur) => dur * pixelsPerSecond,
		stringGap,
		visibleInScroll
	);

	void paddingX;
	void paddingBottom;
}

function drawStrings(ctx: CanvasRenderingContext2D, cfg: RenderConfig, tuning: Tuning): void {
	const { width, height, paddingX, paddingTop, paddingBottom } = cfg;
	const usableHeight = height - paddingTop - paddingBottom;
	const stringGap = usableHeight / (STRING_COUNT - 1);

	ctx.strokeStyle = COLORS.string;
	ctx.lineWidth = 1;
	for (let s = 0; s < STRING_COUNT; s++) {
		const y = paddingTop + s * stringGap;
		ctx.beginPath();
		ctx.moveTo(paddingX, y);
		ctx.lineTo(width - paddingX, y);
		ctx.stroke();
	}

	if (cfg.showTuningLabel) {
		ctx.fillStyle = COLORS.tuningLabel;
		ctx.font = '600 17px "JetBrains Mono Variable", ui-monospace, Menlo, Consolas, monospace';
		ctx.textAlign = 'right';
		ctx.textBaseline = 'middle';
		// Tuning labels sit at a fixed left offset so bumping `paddingX` only
		// shifts the tab content (strings, notes, playhead) rightwards — the
		// E A D G B e column stays hugging the left edge.
		const tuningLabelRightEdge = 26;
		for (let s = 0; s < STRING_COUNT; s++) {
			const y = paddingTop + s * stringGap;
			ctx.fillText(tuning.noteNames[s], tuningLabelRightEdge, y);
		}
	}
}

// Whole-string flash (opt-in). Each note-on lights up its string line and it
// fades over STRING_FLASH_SEC. Off by default because it can pull the eye away
// from the fret numbers themselves.
const STRING_FLASH_SEC = 0.2;
function drawStringFlashes(
	ctx: CanvasRenderingContext2D,
	tab: Tab,
	cfg: RenderConfig,
	currentTime: number
): void {
	const brightness = new Array<number>(STRING_COUNT).fill(0);
	for (const n of tab.notes) {
		if (n.time > currentTime) break;
		if (n.time < currentTime - STRING_FLASH_SEC) continue;
		const b = Math.max(0, 1 - (currentTime - n.time) / STRING_FLASH_SEC);
		if (b > brightness[n.stringIndex]) brightness[n.stringIndex] = b;
	}
	const usableHeight = cfg.height - cfg.paddingTop - cfg.paddingBottom;
	const stringGap = usableHeight / (STRING_COUNT - 1);
	for (let s = 0; s < STRING_COUNT; s++) {
		const b = brightness[s];
		if (b < 0.02) continue;
		const y = cfg.paddingTop + s * stringGap;
		ctx.globalAlpha = b;
		ctx.strokeStyle = COLORS.stringActive;
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.moveTo(cfg.paddingX, y);
		ctx.lineTo(cfg.width - cfg.paddingX, y);
		ctx.stroke();
		ctx.globalAlpha = 1;
	}
}

function drawPlayhead(
	ctx: CanvasRenderingContext2D,
	cfg: RenderConfig,
	x: number,
	color: string = COLORS.playhead
): void {
	ctx.strokeStyle = color;
	ctx.lineWidth = 2;
	ctx.beginPath();
	ctx.moveTo(x, cfg.paddingTop - 12);
	ctx.lineTo(x, cfg.height - cfg.paddingBottom + 12);
	ctx.stroke();
}

function drawPlayheadForStyle(
	ctx: CanvasRenderingContext2D,
	cfg: RenderConfig,
	currentTime: number,
	timeToX: (t: number) => number,
	secondsPerBar: number,
	beatsPerBar: number,
	yTop: number,
	yBottom: number
): void {
	if (cfg.playheadStyle === 'beat' || cfg.playheadStyle === 'bar') {
		const step =
			cfg.playheadStyle === 'bar' ? secondsPerBar : secondsPerBar / Math.max(1, beatsPerBar);
		if (step > 0) {
			const idx = Math.floor(currentTime / step + 1e-9);
			const snapped = idx * step;
			drawPlayhead(ctx, cfg, timeToX(snapped), COLORS.playheadStepped);
		}
		return;
	}
	drawPlayhead(ctx, cfg, timeToX(currentTime));
}

function drawNotes(
	ctx: CanvasRenderingContext2D,
	tab: Tab,
	cfg: RenderConfig,
	currentTime: number,
	timeToX: (t: number) => number,
	durationToWidth: (t: number, dur: number) => number,
	stringGap: number,
	visible: (n: (typeof tab.notes)[number]) => boolean
): void {
	// Palm-mute markers first (behind the digits): dashed line spanning above
	// each contiguous run of PM notes on the top string.
	drawPalmMuteMarkers(ctx, tab, cfg, timeToX, visible);
	drawLetRingMarkers(ctx, tab, cfg, timeToX, visible);
	drawPinchHarmonicMarkers(ctx, tab, cfg, timeToX, visible);

	ctx.textBaseline = 'middle';

	// One consistent size for fret digits and decorations. Active vs idle is
	// signalled by weight + colour — no size changes, no per-segment emphasis.
	const fontIdle = '400 18px "JetBrains Mono Variable", ui-monospace, Menlo, Consolas, monospace';
	const fontActive = '700 18px "JetBrains Mono Variable", ui-monospace, Menlo, Consolas, monospace';

	// Track the most recent note per string across the whole tab so hammer/pull
	// arcs can link back regardless of whether the previous note is off-page.
	// Two-pass rendering. In dense passages (32nd notes, hammer chains) a
	// later note's mask rectangle can span leftwards far enough to cover the
	// previous note's digits. Drawing every mask BEFORE any text means the
	// text always sits on top of every mask, so no note ever gets clipped
	// by its neighbour's background.
	const lastByString = new Map<number, (typeof tab.notes)[number]>();
	const stringLeft = cfg.paddingX;
	const stringRight = cfg.width - cfg.paddingX;

	// Precompute the visible notes with their positions + prev-on-string
	// links so we can iterate twice cheaply.
	type Placed = {
		n: (typeof tab.notes)[number];
		x: number;
		y: number;
		active: boolean;
		prev: (typeof tab.notes)[number] | null;
	};
	const placed: Placed[] = [];
	for (const n of tab.notes) {
		const prev = lastByString.get(n.stringIndex) ?? null;
		lastByString.set(n.stringIndex, n);
		if (!visible(n)) continue;

		const x = timeToX(n.time);
		if (x < stringLeft - 4 || x > stringRight + 4) continue;
		const y = cfg.paddingTop + n.stringIndex * stringGap;
		const active = currentTime >= n.time && currentTime <= n.time + n.duration;
		placed.push({ n, x, y, active, prev });
	}

	// Pass 1: duration bars + note masks + inline h/p masks.
	for (const p of placed) {
		if (cfg.showNoteLengths && p.n.duration > 0.05) {
			const barW = durationToWidth(p.n.time, p.n.duration);
			ctx.fillStyle = p.active ? COLORS.durationBarActive : COLORS.durationBarIdle;
			ctx.fillRect(p.x, p.y - stringGap * 0.38, barW, stringGap * 0.76);
		}
		drawNoteWithArticulations(
			ctx,
			p.n,
			p.x,
			p.y,
			p.active,
			currentTime,
			fontIdle,
			fontActive,
			durationToWidth(p.n.time, p.n.duration),
			timeToX,
			p.prev,
			'mask'
		);
	}
	// Pass 2: text + all articulation lines/arrows/letters.
	for (const p of placed) {
		drawNoteWithArticulations(
			ctx,
			p.n,
			p.x,
			p.y,
			p.active,
			currentTime,
			fontIdle,
			fontActive,
			durationToWidth(p.n.time, p.n.duration),
			timeToX,
			p.prev,
			'text'
		);
	}
}

// Text drawn right after the fret digit, in order:
//   [n]    pinch harmonic: where the picking hand catches it. The fretted
//          note plus the harmonic interval, read as a (virtual) fret: 5[17]
//          is an octave pinch harmonic picked 12 frets above the fret.
//          Same convention as artificial harmonics.
//   bN     bend to fret N; bNrM bend and release
//   \N     grace slide back down
function noteSuffix(n: import('./types').TabNote): string {
	const arts = n.articulations ?? [];
	let s = '';
	const harmonic = arts.find((a) => a.kind === 'harmonic');
	if (harmonic?.kind === 'harmonic' && harmonic.pinch) s += `[${n.fret + harmonic.semitones}]`;
	for (const a of arts) {
		if (a.kind === 'bend') s += `b${n.fret + a.semitones}`;
		else if (a.kind === 'bendRelease') s += `b${n.fret + a.semitones}r${n.fret}`;
	}
	const grace = arts.find((a) => a.kind === 'graceSlide');
	if (grace?.kind === 'graceSlide') s += `\\${Math.max(0, n.fret - grace.fromSemitones)}`;
	return s;
}

// Renders one note as: [prefix][fret][suffix], with ghost/harmonic wrappers.
// Left-aligned at the onset x. A same-colour rectangle underneath masks the
// string line behind the glyphs. Active vs idle is colour-only — everything
// (fret and decorations) uses the same font size so playback doesn't shift
// glyphs around.
function drawNoteWithArticulations(
	ctx: CanvasRenderingContext2D,
	n: import('./types').TabNote,
	x: number,
	y: number,
	active: boolean,
	currentTime: number,
	fontIdle: string,
	fontActive: string,
	durationPx: number,
	timeToX: (t: number) => number,
	prevOnString: import('./types').TabNote | null,
	pass: 'mask' | 'text'
): void {
	void currentTime;
	const textColor = active ? COLORS.noteTextActive : COLORS.noteTextIdle;
	const decoColor = active ? COLORS.articulationActive : COLORS.articulation;
	const arts = n.articulations ?? [];
	const has = (kind: import('./types').Articulation['kind']) => arts.some((a) => a.kind === kind);

	const ghost = has('ghost');
	const harmonic = arts.find((a) => a.kind === 'harmonic');
	let fretLabel = String(n.fret);
	if (ghost) fretLabel = `(${fretLabel})`;
	// Natural harmonics get <n>; pinch harmonics get a "P.H." label above
	// the staff instead (drawPinchHarmonicMarkers).
	if (harmonic && !harmonic.pinch) fretLabel = `<${fretLabel}>`;

	const slideUp = arts.find((a) => a.kind === 'slideUp');
	const slideDown = arts.find((a) => a.kind === 'slideDown');
	const graceSlide = arts.find((a) => a.kind === 'graceSlide');
	const bend = arts.find((a) => a.kind === 'bend');
	const bendRelease = arts.find((a) => a.kind === 'bendRelease');
	// Prefer drawing an arc to the previous note on the same string for hammer/pull.
	// Fall back to a text `h`/`p` prefix if there's no previous note in a reasonable
	// window (e.g. the previous note is more than 1.5s away or the current note is
	// the first on this string).
	const hpArc =
		(has('hammerOn') || has('pullOff')) &&
		prevOnString !== null &&
		n.time - prevOnString.time <= 1.5;
	let prefix = '';
	if (slideUp) {
		const from = Math.max(0, n.fret - slideUp.fromSemitones);
		prefix = `${from}`;
	} else if (slideDown) {
		const from = n.fret + slideDown.fromSemitones;
		prefix = `${from}`;
	} else if (graceSlide) {
		const from = Math.max(0, n.fret - graceSlide.fromSemitones);
		prefix = `${from}/`;
	} else if (has('tap')) prefix = 't';
	else if (has('hammerOn') && !hpArc) prefix = 'h';
	else if (has('pullOff') && !hpArc) prefix = 'p';

	const suffix = noteSuffix(n);

	// Same font size for fret and decor. Active vs idle differs by weight
	// and colour only.
	const font = active ? fontActive : fontIdle;
	const fretFont = font;
	const decorFont = font;

	ctx.textAlign = 'left';
	ctx.font = font;
	const prefixW = prefix ? ctx.measureText(prefix).width : 0;
	const suffixW = suffix ? ctx.measureText(suffix).width : 0;
	const fretW = ctx.measureText(fretLabel).width;

	// Center the fret itself on the beat; articulations flank it. That way the
	// actual played fret sits over the beat line regardless of suffix/prefix.
	// Slide notation needs a small gap between the origin fret and the played
	// fret so the diagonal line has room to render between them.
	const slideSpace = slideUp || slideDown ? 12 : 0;
	const fretStartX = x - fretW / 2;
	const prefixStartX = fretStartX - prefixW - slideSpace;
	const suffixStartX = fretStartX + fretW;
	const padL = 3;
	const padR = 4;
	// Mask now covers the full glyph box vertically (previously a thin 5 px
	// strip that only hid the horizontal string line). This blocks bar
	// vertical lines behind the digits and makes the note read as a small
	// "sticker" against the tab background.
	const maskH = 22;

	if (pass === 'mask') {
		// Opaque mask so bar vertical lines don't cut through digits.
		// Uses globalAlpha=1 explicitly because peek notes are drawn at
		// alpha 0.5 by the caller and we still want a solid mask.
		const savedAlpha = ctx.globalAlpha;
		ctx.globalAlpha = 1;
		ctx.fillStyle = COLORS.noteMask;
		ctx.fillRect(
			prefixStartX - padL,
			y - maskH / 2,
			prefixW + slideSpace + fretW + suffixW + padL + padR,
			maskH
		);
		ctx.globalAlpha = savedAlpha;
	} else {
		if (prefix) {
			ctx.fillStyle = decoColor;
			ctx.fillText(prefix, prefixStartX, y);
		}
		ctx.fillStyle = textColor;
		ctx.fillText(fretLabel, fretStartX, y);
		if (suffix) {
			ctx.fillStyle = decoColor;
			ctx.fillText(suffix, suffixStartX, y);
		}
	}
	void fretFont;
	void decorFont;

	// Hammer / pull marker. When the notes are far enough apart we draw the
	// traditional slur arc above (hammer) or below (pull) the string with
	// the `h` / `p` letter at its peak. When notes are packed close together
	// (fast 32nds, dense phrasing) the arc collapses to something tiny that
	// collides with vibrato / bends on adjacent notes — in that case we
	// fall back to a single inline `h` or `p` letter sitting on the string.
	if (hpArc && prevOnString) {
		const isHammer = has('hammerOn');
		ctx.font = fretFont;
		const prevFretStr = String(prevOnString.fret);
		const prevFretW = ctx.measureText(prevFretStr).width;
		ctx.font = decorFont;
		const prevSuffix = noteSuffix(prevOnString);
		const prevSuffixW = prevSuffix ? ctx.measureText(prevSuffix).width : 0;
		const prevX = timeToX(prevOnString.time) + prevFretW / 2 + prevSuffixW + 2;
		const endX = prefixStartX - 2;
		const gap = endX - prevX;
		// Threshold: below this the arc would be small enough that its
		// height (14 px above/below) reads bigger than its width — better
		// to just place the letter inline.
		const INLINE_GAP_PX = 32;
		if (gap > 4) {
			const midX = (prevX + endX) / 2;
			const letter = isHammer ? 'h' : 'p';
			const isInline = gap < INLINE_GAP_PX;
			if (pass === 'mask' && isInline) {
				// Inline mode places the letter directly on the string, so
				// it needs a small mask to hide the string line behind it.
				ctx.font = decorFont;
				const letterW = ctx.measureText(letter).width;
				const savedAlpha = ctx.globalAlpha;
				ctx.globalAlpha = 1;
				ctx.fillStyle = COLORS.noteMask;
				ctx.fillRect(midX - letterW / 2 - 2, y - maskH / 2, letterW + 4, maskH);
				ctx.globalAlpha = savedAlpha;
			} else if (pass === 'text') {
				if (!isInline) {
					// Arc + letter above/below the string.
					const midY = y + (isHammer ? -14 : 14);
					ctx.strokeStyle = decoColor;
					ctx.lineWidth = 1.3;
					ctx.beginPath();
					ctx.moveTo(prevX, y - (isHammer ? 4 : -4));
					ctx.quadraticCurveTo(midX, midY, endX, y - (isHammer ? 4 : -4));
					ctx.stroke();
					ctx.font = decorFont;
					ctx.fillStyle = decoColor;
					ctx.textAlign = 'center';
					ctx.textBaseline = 'middle';
					ctx.fillText(letter, midX, midY + (isHammer ? -1 : 1));
					ctx.textAlign = 'left';
					ctx.textBaseline = 'middle';
				} else {
					// Inline letter — mask already drawn in the mask pass.
					ctx.font = decorFont;
					ctx.fillStyle = decoColor;
					ctx.textAlign = 'center';
					ctx.textBaseline = 'middle';
					ctx.fillText(letter, midX, y);
					ctx.textAlign = 'left';
					ctx.textBaseline = 'middle';
				}
			}
		}
	}

	// Bend curved-arrow decoration above the fret — a hook rising from the
	// fret indicating pitch bending up. Size scales with the semitone amount:
	// 1-step bend gets a small hook, 2-step medium, larger bends taller still.
	if (pass === 'text' && (bend || bendRelease)) {
		const semitones = bend?.semitones ?? bendRelease?.semitones ?? 1;
		// Map semitones → height. 1 semi = ~10px, 2 = ~14, 3 = ~18, 4+ capped at 22.
		const height = Math.min(22, 6 + semitones * 4);
		const width = Math.min(20, 8 + semitones * 3);
		const centerX = fretStartX + fretW / 2;
		const startX = centerX - width / 4;
		// Above the fret text (fret ascender reaches ~y-8, so start at y-11 for clearance).
		const startY = y - 11;
		const endX = centerX + (width * 3) / 4;
		const endY = startY - height;
		ctx.strokeStyle = decoColor;
		ctx.lineWidth = 1.3;
		ctx.beginPath();
		ctx.moveTo(startX, startY);
		ctx.quadraticCurveTo(centerX + width / 4, endY, endX, endY);
		ctx.stroke();
		// Arrowhead pointing right
		ctx.beginPath();
		ctx.moveTo(endX, endY);
		ctx.lineTo(endX - 3, endY + 2);
		ctx.moveTo(endX, endY);
		ctx.lineTo(endX - 1, endY + 4);
		ctx.stroke();
	}

	// Slide connector — thin diagonal line spanning the slideSpace gap between
	// the origin fret text and the played fret text on the same string.
	if (pass === 'text' && (slideUp || slideDown)) {
		const lineX0 = prefixStartX + prefixW + 2;
		const lineX1 = fretStartX - 2;
		if (lineX1 > lineX0 + 2) {
			ctx.strokeStyle = decoColor;
			ctx.lineWidth = 1.2;
			ctx.beginPath();
			if (slideUp) {
				ctx.moveTo(lineX0, y + 5);
				ctx.lineTo(lineX1, y - 5);
			} else {
				ctx.moveTo(lineX0, y - 5);
				ctx.lineTo(lineX1, y + 5);
			}
			ctx.stroke();
		}
	}

	const vibrato = arts.find((a) => a.kind === 'vibrato');
	if (pass === 'text' && vibrato) {
		// Wavy line spans only the time range where the pressure envelope is
		// above threshold. Degenerate ranges (start >= end, or width smaller
		// than the fret) fall back to a short marker centered on the fret.
		let vStart = timeToX(vibrato.startTime);
		let vEnd = timeToX(vibrato.endTime);
		if (!(vEnd - vStart >= Math.max(fretW, 20))) {
			vStart = fretStartX;
			vEnd = fretStartX + Math.max(fretW, 24);
		}
		const midY = y - 14;
		const amp = 4;
		const period = 22;
		const cycles = Math.max(1, (vEnd - vStart) / period);
		const samples = Math.max(8, Math.round(cycles * 10));
		ctx.strokeStyle = decoColor;
		ctx.lineWidth = 1.2;
		ctx.beginPath();
		for (let i = 0; i <= samples; i++) {
			const t = i / samples;
			const px = vStart + t * (vEnd - vStart);
			const py = midY + Math.sin(t * cycles * Math.PI * 2) * amp;
			if (i === 0) ctx.moveTo(px, py);
			else ctx.lineTo(px, py);
		}
		ctx.stroke();
	}
}

// Groups consecutive palm-mute notes into ranges and draws a dashed marker above
// the top string with a "PM" label at the start.
function drawPalmMuteMarkers(
	ctx: CanvasRenderingContext2D,
	tab: Tab,
	cfg: RenderConfig,
	timeToX: (t: number) => number,
	visible: (n: (typeof tab.notes)[number]) => boolean
): void {
	const GAP = 0.35; // seconds; larger gaps between PM notes break the marker
	const y = cfg.paddingTop - PM_LANE_OFFSET;

	// PM span: label anchored at the first PM note's centre; dashes trail
	// just a short amount past the LAST PM note in the run (not the note's
	// duration, so a 1/8-note PM doesn't paint dashes across two 16ths).
	// If a non-PM note follows within that trail, we cap the dashes just
	// before it so the following note doesn't look palm-muted.
	const TAIL = 0.05; // seconds of dashes past the last PM note
	const INTERRUPT_GAP = 0.03; // seconds of clearance before an interrupter

	let inRun = false;
	let runStart = 0;
	let lastPMTime = 0;
	let interrupterTime: number | null = null;

	const flush = () => {
		if (!inRun) return;
		let end = lastPMTime + TAIL;
		if (interrupterTime !== null) {
			end = Math.min(end, interrupterTime - INTERRUPT_GAP);
		}
		end = Math.max(runStart + 0.02, end);
		const x1 = timeToX(runStart);
		const x2 = timeToX(end);
		ctx.fillStyle = COLORS.palmMute;
		ctx.font = '700 14px "JetBrains Mono Variable", ui-monospace, Menlo, Consolas, monospace';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText('PM', x1, y);
		const labelW = ctx.measureText('PM').width;
		const dashStart = x1 + labelW / 2 + 4;
		if (x2 > dashStart + 2) {
			ctx.strokeStyle = COLORS.palmMute;
			ctx.setLineDash([3, 4]);
			ctx.lineWidth = 1.2;
			ctx.beginPath();
			ctx.moveTo(dashStart, y);
			ctx.lineTo(x2, y);
			ctx.stroke();
			ctx.setLineDash([]);
		}
		inRun = false;
		interrupterTime = null;
	};

	// Notes are sorted by time in the Tab.
	for (const n of tab.notes) {
		if (!visible(n)) {
			if (n.time > (tab.notes[tab.notes.length - 1]?.time ?? 0)) break;
			continue;
		}
		const isPM = n.articulations?.some((a) => a.kind === 'palmMute');
		if (isPM) {
			if (!inRun) {
				inRun = true;
				runStart = n.time;
				lastPMTime = n.time;
			} else if (n.time - lastPMTime < GAP) {
				lastPMTime = n.time;
			} else {
				flush();
				inRun = true;
				runStart = n.time;
				lastPMTime = n.time;
			}
		} else if (inRun) {
			// A non-PM note breaks the run and clips its trailing dashes.
			interrupterTime = n.time;
			flush();
		}
	}
	flush();
}

// Pinch/artificial harmonic: "P.H." above the staff at the note (the fret
// digit itself stays plain, since <n> would claim a natural harmonic).
function drawPinchHarmonicMarkers(
	ctx: CanvasRenderingContext2D,
	tab: Tab,
	cfg: RenderConfig,
	timeToX: (t: number) => number,
	visible: (n: (typeof tab.notes)[number]) => boolean
): void {
	let lastX = -Infinity;
	for (const n of tab.notes) {
		if (!visible(n)) continue;
		const h = n.articulations?.find((a) => a.kind === 'harmonic');
		if (!h || h.kind !== 'harmonic' || !h.pinch) continue;
		const x = timeToX(n.time);
		// One label per time position even if several strings are pinched.
		if (Math.abs(x - lastX) < 1) continue;
		lastX = x;
		// Shares the L.R. row; moves up to the PM row when the same time
		// also lets ring, so the two labels never collide.
		const ringsToo = n.articulations.some((a) => a.kind === 'letRing');
		const y = cfg.paddingTop - (ringsToo ? PM_LANE_OFFSET : LR_LANE_OFFSET);
		ctx.fillStyle = COLORS.articulation;
		ctx.font = '700 12px "JetBrains Mono Variable", ui-monospace, Menlo, Consolas, monospace';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText('P.H.', x, y);
	}
}

// Let-ring marker: same visual language as PM ("L.R." label + short trailing
// dashed line above the tab) but a distinct colour so the two don't get
// confused. Drawn per note — no "run" merging, since a let-ring is really a
// property of the individual note rather than a span like palm mute.
function drawLetRingMarkers(
	ctx: CanvasRenderingContext2D,
	tab: Tab,
	cfg: RenderConfig,
	timeToX: (t: number) => number,
	visible: (n: (typeof tab.notes)[number]) => boolean
): void {
	const y = cfg.paddingTop - LR_LANE_OFFSET;
	for (const n of tab.notes) {
		if (!visible(n)) continue;
		if (!n.articulations?.some((a) => a.kind === 'letRing')) continue;
		const x = timeToX(n.time);
		ctx.fillStyle = '#c69f5e';
		ctx.font = '700 12px "JetBrains Mono Variable", ui-monospace, Menlo, Consolas, monospace';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText('L.R.', x, y);
		const labelW = ctx.measureText('L.R.').width;
		const dashStart = x + labelW / 2 + 4;
		const dashEnd = dashStart + 20;
		ctx.strokeStyle = '#c69f5e';
		ctx.setLineDash([3, 4]);
		ctx.lineWidth = 1.2;
		ctx.beginPath();
		ctx.moveTo(dashStart, y);
		ctx.lineTo(dashEnd, y);
		ctx.stroke();
		ctx.setLineDash([]);
	}
}
