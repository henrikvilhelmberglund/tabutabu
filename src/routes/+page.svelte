<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { parseMidi } from '$lib/midi/parse';
	import { parseDawproject } from '$lib/dawproject/parse';
	import { inspectMidi, type MidiInspection } from '$lib/midi/expressions';
	import {
		renderTabFrame,
		DEFAULT_RENDER_CONFIG,
		PM_LANE_OFFSET,
		previewNoteColors,
		type RenderMode,
		type PlayheadStyle,
		type Theme
	} from '$lib/tab/renderer';
	import { TUNINGS, STRING_COUNT, MAX_FRET } from '$lib/tab/tuning';
	import type { Tab, TabNote, Articulation } from '$lib/tab/types';
	import {
		NATURAL_HARMONIC_OFFSET,
		harmonicChoices,
		isNaturalHarmonic,
		retuneHarmonic
	} from '$lib/tab/harmonics';
	import {
		shapesForTool,
		shapeSpots,
		matchShape,
		shapeLabel,
		DEFAULT_SHAPE,
		type PowerShape
	} from '$lib/tab/shapes';
	import {
		CHORD_TYPES,
		CHORD_ROW,
		chordVoicings,
		matchChordType,
		closestVoicing,
		chordName,
		tuningUsesFlats,
		voicingFrets,
		pitchName,
		type Voicing
	} from '$lib/tab/chords';
	import { PitchProbe } from '$lib/audio/probe';
	import { ChannelRouter, type ListenChannel } from '$lib/audio/channels';
	import { encodeShare, decodeShare, fetchGistPayload, type SharedTab } from '$lib/tab/share';
	import {
		computeSpectrogram,
		drawSpectrogramSpan,
		spectrogramFromData,
		spectrogramPitchRange,
		SPECTROGRAM_VERSION,
		type Spectrogram,
		type SpectrogramData,
		type SpectroChannel,
		type SpectroStyle
	} from '$lib/audio/spectrogram';
	import {
		sweepShapes,
		sweepShapesFrom,
		patternStart,
		sweepSequence,
		sweepCycle,
		sweepName,
		SWEEP_PATTERNS,
		type SweepShape,
		type SweepPattern
	} from '$lib/tab/sweep';
	import {
		makeEmptyTab,
		makeHistory,
		run as runCmd,
		undo as undoCmd,
		redo as redoCmd,
		canUndo,
		canRedo,
		cmdAddNote,
		cmdRemoveNote,
		cmdUpdateNote,
		cmdReconcileHammerPull,
		cmdSetTempo,
		shiftTimedArticulations,
		batchCommand,
		type Command,
		extendDurationTo,
		newNoteId,
		type History
	} from '$lib/tab/edit';
	import { overrideKey } from '$lib/midi/arrange';
	import { Synth, DEFAULT_SYNTH_OPTIONS } from '$lib/audio/synth';
	import { DawSync, type SyncPortInfo } from '$lib/midi/sync';
	import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';

	let tab = $state<Tab | null>(null);
	let tuningKey = $state<keyof typeof TUNINGS>('standard');
	let currentTime = $state(0);
	let playing = $state(false);
	let pixelsPerSecond = $state(DEFAULT_RENDER_CONFIG.pixelsPerSecond);
	let renderMode = $state<RenderMode>(DEFAULT_RENDER_CONFIG.mode);
	let playheadStyle = $state<PlayheadStyle>(DEFAULT_RENDER_CONFIG.playheadStyle);
	let theme = $state<Theme>(DEFAULT_RENDER_CONFIG.theme);
	let stringFlashEnabled = $state(DEFAULT_RENDER_CONFIG.stringFlashEnabled);
	let barsPerPage = $state(DEFAULT_RENDER_CONFIG.barsPerPage);
	let peekBeats = $state(DEFAULT_RENDER_CONFIG.peekBeats);
	let showNoteLengths = $state(DEFAULT_RENDER_CONFIG.showNoteLengths);
	let fileName = $state<string | null>(null);
	let parseError = $state<string | null>(null);
	// Off by default so MPE MIDI (Bitwig per-note expressions) isn't misinterpreted.
	let honorChannelStrings = $state(false);
	// Per-note manual string overrides. Keyed by overrideKey(time, midi, channel).
	// Reactive so the tab re-parses when they change.
	let overrides = $state<Record<string, number>>({});
	// Per-note manual technique annotations. 'off' means "remove any auto-detected".
	let annotations = $state<Record<string, 'hammer' | 'pull' | 'tap' | 'off'>>({});

	// ---- Authoring mode ------------------------------------------------------
	// A whole separate "editor" mode that lets the user place notes on the
	// strings by hand, backed by an undo stack and eventually an MPE MIDI
	// export path. Toggled by the "Author" button in the header. Grid + tool
	// state lives here; the actual editing helpers are in $lib/tab/edit.ts.
	let mode = $state<'view' | 'author'>('view');
	type Tool = 1 | 2 | 3 | 4 | 5 | 6 | 0;
	let currentTool = $state<Tool>(1);
	const TOOL_NAMES: Record<Tool, string> = {
		1: 'Note',
		2: 'Power 3',
		3: 'Power 2',
		4: 'Chord',
		5: 'Arp',
		6: 'Sweep',
		0: 'Select'
	};
	// Per-tool variant. Pressing the active tool's number key flips just
	// that tool between "normal" and "palm mute" — switching to a different
	// tool and back preserves the PM state it was in. Persisted per session.
	let toolVariants = $state<Record<Tool, 'normal' | 'palmMute'>>({
		0: 'normal',
		1: 'normal',
		2: 'normal',
		3: 'normal',
		4: 'normal',
		5: 'normal',
		6: 'normal'
	});
	let toolVariant = $derived(toolVariants[currentTool] ?? 'normal');
	// Selected shape per power-chord tool (ids from $lib/tab/shapes).
	// Changed with the toolbar dropdown or Ctrl+←/→. Persisted.
	let toolShapes = $state<{ 2: string; 3: string }>({ ...DEFAULT_SHAPE });
	// Chord tool (4): type (Ctrl+←/→, top row), string count (Ctrl+↑/↓) and
	// variation (Shift+←/→, Shift+top row) — an index into the voicing list
	// for wherever the chord is placed. The variation is kept as asked for
	// even when a list is shorter, so stepping types up and back down lands
	// on the same voicing. Persisted.
	let chordTypeId = $state('maj');
	let chordStrings = $state(6);
	let chordVoicingIdx = $state(0);
	// Arp tool (5): the chord above, played one note per grid step.
	// Pattern: Shift+↑ ascending (again: up-and-down), Shift+↓ descending
	// (again: down-and-up). Length in notes (Shift+←/→); 0 = one pass, and
	// anything longer keeps cycling the pattern (loops). Persisted.
	type ArpPattern = 'up' | 'updown' | 'down' | 'downup';
	let arpPattern = $state<ArpPattern>('up');
	const ARP_PATTERN_LABEL: Record<ArpPattern, string> = {
		up: 'up ↗',
		updown: 'up-down ↗↘',
		down: 'down ↘',
		downup: 'down-up ↘↗'
	};
	let arpLength = $state(0);
	// Sweep tool (6): shape (variation, Shift+←/→ … see the sweep section),
	// pattern (Shift+↑/↓ through SWEEP_PATTERNS) and loop count (Shift+←/→).
	// Chord type and string count are shared with the chord / arp tools.
	// Persisted.
	let sweepVariation = $state(0);
	let sweepPatternId = $state('ud-pull');
	let sweepLoops = $state(1);
	// Start new notes on the last fret used on that string (see
	// defaultFretForString). Toggled with the key left of 1. Persisted.
	let reuseLastFret = $state(true);
	let currentShape = $derived.by(() => {
		const tool = currentTool;
		if (tool !== 2 && tool !== 3) return null;
		const shapes = shapesForTool(tool);
		return shapes.find((s) => s.id === toolShapes[tool]) ?? shapes[0];
	});
	// Grid subdivision the pointer snaps to, as divisions of a whole note,
	// coarse to fine. Multiples of 3 are the triplet grids: 6 = quarter
	// triplets, 12 = 8th triplets, 24 = 16th triplets (6 per beat), 48 = 32nd
	// triplets. The Triplets button swaps a grid for its triplet version
	// (×3/2) and back; PgUp/PgDn stay within straight or triplet grids.
	const GRID_STEPS = [4, 6, 8, 12, 16, 24, 32, 48] as const;
	type GridStep = (typeof GRID_STEPS)[number];
	let gridStep = $state<GridStep>(16);
	let tripletGrid = $derived(gridStep % 3 === 0);
	function gridLabel(g: GridStep): string {
		return g % 3 === 0 ? `1/${(g * 2) / 3} T` : `1/${g}`;
	}
	function toggleTriplets() {
		gridStep = (tripletGrid ? (gridStep * 2) / 3 : (gridStep * 3) / 2) as GridStep;
	}
	// The undo/redo stack for the current authoring session. Rebuilt when a
	// new tab is created or loaded.
	let history = $state<History>(makeHistory());
	// New-tab dialog visibility + fields.
	let showNewTabDialog = $state(false);
	let newTabBpm = $state(120);
	let newTabTimeSigTop = $state(4);
	let newTabTimeSigBottom = $state<1 | 2 | 4 | 8 | 16>(4);
	let newTabBars = $state(16);
	// Tap-tempo scratchpad.
	let tapTimes = $state<number[]>([]);
	let tapBpm = $derived.by(() => {
		if (tapTimes.length < 2) return null;
		const deltas: number[] = [];
		for (let i = 1; i < tapTimes.length; i++) deltas.push(tapTimes[i] - tapTimes[i - 1]);
		const avgMs = deltas.reduce((a, b) => a + b, 0) / deltas.length;
		return Math.round(60000 / avgMs);
	});

	// If set, playback in author mode should auto-stop at this song-time.
	// Used by the spacebar-plays-current-bar-or-beat behaviour so we don't
	// bleed into the next bar while auditioning a phrase in progress.
	let authorPlayStopAt = $state<number | null>(null);

	// Playback focus in author mode. Cycles bar-N → beat 1 → beat 2 → beat 3
	// → beat 4 → bar N+1 → beat 1 of N+1 → ... via right/left arrows (when
	// the pointer isn't over a note). Space plays whatever the focus points
	// at. beatIdx=0 means "whole bar"; beatIdx 1..timeSig[0] means that
	// specific beat.
	let authorFocus = $state<{ barIdx: number; beatIdx: number }>({ barIdx: 0, beatIdx: 0 });

	// Author-mode pointer state. Set on pointerdown, updated on pointermove,
	// committed on pointerup.
	type AuthorGesture =
		| {
				kind: 'place';
				stringIndex: number;
				time: number;
				initialFret: number;
				currentFret: number;
				startX: number;
				startY: number;
				// Chord tool: the fret the chord's shape was chosen at (drag start,
				// or the last chord key pressed mid-drag). Dragging moves that shape
				// in parallel while it stays playable.
				anchorFret: number;
		  }
		| {
				kind: 'edit';
				noteId: string;
				stringIndex: number;
				initialFret: number;
				currentFret: number;
				startX: number;
				startY: number;
				// Power-chord tools: dragging the ROOT (lowest string) of a
				// stacked shape moves every note in the shape by the same
				// fret delta. Empty for single-note edits.
				group: ShapeGroupMember[];
				// Chord tool: the recognised chord when its bass note is dragged.
				// At each new bass fret the chord is rebuilt as the same type,
				// string count and variation number instead of being shifted,
				// so open-string shapes stay playable.
				chord: ChordId | null;
		  }
		| {
				// Alt+drag: reposition to another string while preserving MIDI
				// pitch (fret recomputed from the target string's tuning). Use
				// this to try different fingerings for the same note.
				kind: 'move-fingering';
				noteId: string;
				midi: number;
				initialStringIndex: number;
				initialTime: number;
				currentStringIndex: number;
				currentTime: number;
				startX: number;
				startY: number;
		  }
		| {
				// Shift+drag: move the note anywhere (time + string) with the
				// FRET number preserved. Pitch changes because a new string
				// with the same fret sounds a different note.
				kind: 'move-free';
				noteId: string;
				fret: number;
				initialStringIndex: number;
				initialTime: number;
				currentStringIndex: number;
				currentTime: number;
				startX: number;
				startY: number;
		  }
		| {
				// Ctrl+drag: like move-free but leaves the original in place
				// and creates a copy at the drop position.
				kind: 'copy';
				sourceId: string;
				fret: number;
				initialStringIndex: number;
				initialTime: number;
				currentStringIndex: number;
				currentTime: number;
				startX: number;
				startY: number;
		  }
		| {
				// Middle-button drag: erase every note the pointer passes over.
				// Erased notes vanish from the preview immediately; the lot is
				// committed as one undo step on release.
				kind: 'erase';
				ids: string[];
				lastX: number;
				lastY: number;
		  }
		| {
				// Arp tool: dragging any note of an arpeggio moves the whole
				// arpeggio's chord (by its bass fret), keeping its rhythm and
				// order — the same shape while playable, else re-voiced.
				kind: 'edit-arp';
				noteId: string;
				run: Array<{ id: string; time: number; stringIndex: number; fret: number }>;
				bassString: number;
				initialFret: number;
				currentFret: number;
				startX: number;
				startY: number;
				chord: ChordId | null;
		  };
	let authorGesture = $state<AuthorGesture | null>(null);
	// Hover ghost note (shown while nothing is being dragged). null when
	// pointer is off the canvas or we're not in author mode.
	let hoverPos = $state<{ time: number; stringIndex: number } | null>(null);
	let hoverFret = $state<number>(0);

	// Pixels-of-drag per fret / per octave step. Horizontal is deliberately
	// less twitchy than the vertical octave gesture — you want room to land
	// on a specific fret, but octave jumps only need coarse throws.
	const PX_PER_FRET = 18;
	const PX_PER_OCTAVE = 40;

	// Remember what pitch the drag last auditioned so we don't retrigger the
	// preview every frame; only when the fret / string / midi actually
	// changes.
	let lastPreviewKey: string | null = null;
	// Preview length for auditioning a note. Palm-muted notes are cut short
	// so they are clearly different from a ringing note, not just darker.
	function previewDuration(arts: Articulation[]): number {
		return arts.some((a) => a.kind === 'palmMute') ? 0.22 : 0.6;
	}

	function previewIfChanged(
		key: string,
		midi: number,
		stringIndex: number,
		fret: number,
		noteArts?: Articulation[]
	) {
		if (!tab || !audioOn) return;
		if (key === lastPreviewKey) return;
		lastPreviewKey = key;
		// Existing notes preview with their own articulations; new
		// placements follow the tool variant.
		const arts: Articulation[] = noteArts
			? $state.snapshot(noteArts)
			: toolVariant === 'palmMute'
				? [{ kind: 'palmMute' }]
				: [];
		synth.previewNote({
			id: 'preview',
			time: 0,
			duration: previewDuration(arts),
			stringIndex,
			fret,
			midi,
			velocity: 0.7,
			channel: 0,
			articulations: arts
		});
	}

	let canvas: HTMLCanvasElement;
	let timelineCanvas: HTMLCanvasElement;
	// Kept out of $state so buffer identity doesn't drive reactivity.
	let midiBuffer: ArrayBuffer | null = null;
	let isDawprojectFile = false;
	// Non-reactive gate: when true, per-file persistence effects skip writing to
	// IndexedDB. Used while loading a file so the initial empty state isn't
	// saved on top of the file's actual persisted overrides/annotations.
	let suppressPerFilePersist = false;
	let inspection = $state<MidiInspection | null>(null);
	let timelineDragging = false;

	let audioOn = $state(true);
	let volume = $state(DEFAULT_SYNTH_OPTIONS.masterVolume);
	let metronomeOn = $state(DEFAULT_SYNTH_OPTIONS.metronomeEnabled);
	let metronomeVol = $state(DEFAULT_SYNTH_OPTIONS.metronomeVolume);

	// Performance-video overlay
	let videoUrl = $state<string | null>(null);
	let videoFileName = $state<string | null>(null);
	// Video time when tab time = 0. Positive value → video is that many seconds
	// ahead of the tab (start the video farther in). Adjust until they align.
	let videoOffsetSec = $state(0);
	let videoAudioOn = $state(false);
	// 0..1 — volume of the reference video/audio when its audio track is
	// enabled. Bound to `videoElement.volume` via an effect below.
	let videoVolume = $state(0.8);
	let videoElement = $state<HTMLVideoElement | null>(null);
	let videoDuration = $state<number | null>(null);
	// Composite canvas: shows video + tab overlay both during preview (WYSIWYG)
	// and during export. Drawn every rAF frame when a video is loaded.
	let compositeCanvas = $state<HTMLCanvasElement | null>(null);

	// Video export state
	let isExporting = $state(false);
	let exportProgress = $state(0);
	let exportError = $state<string | null>(null);
	let exportStage = $state<'idle' | 'encoding' | 'flushing' | 'finalizing' | 'done'>('idle');
	// After a successful export: blob URL of the resulting MP4 for in-page
	// preview, and the filename we'd download it as. The URL is revoked when
	// the user starts a new export or clears the result.
	let exportResultUrl = $state<string | null>(null);

	// ---- App shell: menus and overlays ----------------------------------------
	// One menu-bar dropdown open at a time; clicking outside the menu bar or
	// pressing Esc closes it. `?` (or Help → Keyboard shortcuts) opens the
	// shortcut overlay.
	type MenuId = 'file' | 'view' | 'tab' | 'sync' | 'export' | 'help';
	let openMenu = $state<MenuId | null>(null);
	// Right-hand shortcut reference: always shown unless collapsed (? or
	// the toolbar keyboard button toggles it). Persisted.
	let shortcutsOpen = $state(true);
	// Author mode: reference video width as a fraction of the tab's. Smaller
	// pulls the tab up toward the middle of the window. Persisted.
	const REF_SCALES = [1, 0.75, 0.55, 0.4];
	let refScale = $state(1);
	function cycleRefScale() {
		const i = REF_SCALES.findIndex((s) => Math.abs(s - refScale) < 0.01);
		refScale = REF_SCALES[(i + 1) % REF_SCALES.length];
	}

	// ---- Reference spectrogram (author mode) ----------------------------------
	// The reference area shows the video or a spectrogram of its audio, lined
	// up with the tab's bars. Audio-only references always show the
	// spectrogram (their video area would be black). The audio is analysed
	// the first time the spectrogram is shown, in a worker.
	let refView = $state<'video' | 'spectrogram'>('video');
	let referenceIsAudio = $state(false);
	let spectrogram = $state.raw<Spectrogram | null>(null);
	let spectroProgress = $state<number | null>(null); // null = not running
	let spectroError = $state<string | null>(null);
	let spectroCanvas = $state<HTMLCanvasElement | undefined>();
	// What's analysed: the whole mix, only the sides (hard-panned guitars),
	// or — when the reference has been split into instruments (optional, see
	// tools/README.md) — the guitar or bass stem. Persisted.
	// The separated instruments (HT-Demucs 6 stems; "other" is whatever
	// isn't one of the rest, e.g. synths or strings).
	const STEM_SOURCES = ['guitar', 'bass', 'drums', 'vocals', 'piano', 'other'] as const;
	type StemSource = (typeof STEM_SOURCES)[number];
	type SpectroSource = SpectroChannel | StemSource;
	const isStem = (s: string): s is StemSource => (STEM_SOURCES as readonly string[]).includes(s);
	let spectroChannel = $state<SpectroSource>('mix');
	// Stem separation: whether the local server can do it, and this
	// reference's split (id = the server's cache id).
	let stemsAvailable = $state<{ device?: string } | null>(null);
	let stems = $state<{
		id: string;
		status: 'running' | 'done' | 'error';
		progress: number;
		error?: string;
	} | null>(null);
	const stemBuffers = new Map<string, ArrayBuffer>();
	// The source actually shown (a stem only once the split is done).
	let effectiveSource = $derived<SpectroSource>(
		isStem(spectroChannel) && stems?.status !== 'done' ? 'mix' : spectroChannel
	);
	// How loud each pitch is (plain), every pitch that stands out, or only the
	// picked notes. Persisted.
	let spectroStyle = $state<SpectroStyle>('notes');
	function setSpectroChannel(c: SpectroSource) {
		spectroChannel = c;
	}
	// Listen to (and analyse) both channels, or only the left or right one in
	// mono — e.g. one of two hard-panned guitars. Sides ignores it for the
	// analysis (it's left minus right already). Persisted.
	let listenChannel = $state<ListenChannel>('both');
	let analysisChannel = $derived<SpectroChannel>(
		effectiveSource === 'sides' ? 'sides' : listenChannel === 'both' ? 'mix' : listenChannel
	);
	// A different source or channel needs a different analysis.
	$effect(() => {
		void effectiveSource;
		void analysisChannel;
		untrack(() => {
			spectroJob++;
			spectrogram = null;
			spectroError = null;
			spectroProgress = null;
		});
	});
	let showSpectrogram = $derived(
		mode === 'author' && !!videoUrl && (refView === 'spectrogram' || referenceIsAudio)
	);
	// The loaded reference file, kept for analysis (not reactive: it's big),
	// and what identifies it for the stored analysis.
	let referenceBuffer: ArrayBuffer | null = null;
	let referenceKey = '';
	let spectroJob = 0;

	function setReferenceAudio(buffer: ArrayBuffer | null, type = '', name = '') {
		referenceBuffer = buffer;
		referenceKey = buffer ? `${name}|${buffer.byteLength}` : '';
		probe.forget();
		probeMidi = null;
		hoverMidi = null;
		referenceIsAudio =
			!!buffer && (type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|oga|flac)$/i.test(name));
		spectroJob++;
		spectrogram = null;
		spectroError = null;
		spectroProgress = null;
		stems = null;
		stemBuffers.clear();
		dropStemAudio();
		if (buffer) void restoreStems(referenceKey);
	}

	$effect(() => {
		if (!showSpectrogram || spectrogram || spectroError || spectroProgress !== null) return;
		const buffer = referenceBuffer;
		if (!buffer) return;
		const job = ++spectroJob;
		spectroProgress = 0;
		loadSpectrogram(buffer, referenceKey, effectiveSource, analysisChannel, (p) => {
			if (job === spectroJob) spectroProgress = p;
		})
			.then((s) => {
				if (job === spectroJob) spectrogram = s;
			})
			.catch((err) => {
				if (job === spectroJob) spectroError = err instanceof Error ? err.message : String(err);
			})
			.finally(() => {
				if (job === spectroJob) spectroProgress = null;
			});
	});

	// The analysis of the reference: the stored one if it's for this file,
	// channel and analysis version, else a fresh one, which is then stored
	// (only the latest reference's, like the reference itself).
	async function loadSpectrogram(
		buffer: ArrayBuffer,
		key: string,
		source: SpectroSource,
		channel: SpectroChannel,
		onProgress: (p: number) => void
	): Promise<Spectrogram> {
		const side = channel === 'left' || channel === 'right' ? `:${channel}` : '';
		const store = `lastSpectrogram:${source}${side}`;
		try {
			const saved = (await idbGet(store)) as (SpectrogramData & { key: string }) | undefined;
			if (saved?.key === key && saved.version === SPECTROGRAM_VERSION) {
				return spectrogramFromData(saved);
			}
		} catch {
			// storage blocked — analyse instead
		}
		const spec = isStem(source)
			? await computeSpectrogram(await getStem(source), channel, onProgress, true)
			: await computeSpectrogram(buffer, channel, onProgress);
		const { tiles: _tiles, ...data } = spec;
		idbSet(store, { ...data, key }).catch(() => {});
		// Stored by versions before the Mix / Sides choice.
		idbDel('lastSpectrogram').catch(() => {});
		return spec;
	}

	// ---- Instrument stems (optional) ------------------------------------------
	// The server splits the reference with HT-Demucs when its Python setup
	// exists (GET /api/separate says so); otherwise none of this shows.
	const STEMS_KEY = 'tabutabu.stems';

	async function getStem(stem: StemSource): Promise<ArrayBuffer> {
		if (!stems || stems.status !== 'done') throw new Error('the instruments are not split yet');
		const k = `${stems.id}:${stem}`;
		let buf = stemBuffers.get(k);
		if (!buf) {
			const res = await fetch(`/api/separate/${stems.id}/${stem}`);
			if (!res.ok) throw new Error(`couldn't load the ${stem} stem (${res.status})`);
			buf = await res.arrayBuffer();
			stemBuffers.set(k, buf);
		}
		return buf;
	}

	// A split done earlier for this reference (the server keeps it).
	async function restoreStems(key: string) {
		let saved: { key: string; id: string } | null = null;
		try {
			saved = JSON.parse(localStorage.getItem(STEMS_KEY) ?? 'null');
		} catch {
			// no saved split
		}
		if (!saved || saved.key !== key) return;
		try {
			const res = await fetch(`/api/separate/${saved.id}`);
			if (!res.ok || key !== referenceKey) return;
			const job = await res.json();
			if (job.status === 'done') stems = { id: saved.id, status: 'done', progress: 1 };
			else if (job.status === 'running') void followStems(key, saved.id);
		} catch {
			// server without separation
		}
	}

	async function splitStems() {
		const buffer = referenceBuffer;
		const key = referenceKey;
		if (!buffer || stems?.status === 'running') return;
		stems = { id: '', status: 'running', progress: 0 };
		try {
			const ext = (videoFileName ?? '').split('.').pop() ?? '';
			const res = await fetch(`/api/separate?ext=${encodeURIComponent(ext)}`, {
				method: 'POST',
				// Without a type the dev server reads the body as empty.
				headers: { 'content-type': 'application/octet-stream' },
				body: buffer
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error ?? `status ${res.status}`);
			if (key !== referenceKey) return;
			try {
				localStorage.setItem(STEMS_KEY, JSON.stringify({ key, id: body.id }));
			} catch {
				// not remembered — can split again
			}
			await followStems(key, body.id);
		} catch (err) {
			if (key === referenceKey) {
				stems = {
					id: '',
					status: 'error',
					progress: 0,
					error: err instanceof Error ? err.message : String(err)
				};
			}
		}
	}

	// Poll a running split until it's done; then show the guitar.
	async function followStems(key: string, id: string) {
		for (;;) {
			const res = await fetch(`/api/separate/${id}`);
			const job = await res.json();
			if (key !== referenceKey) return;
			if (!res.ok || job.status === 'error') {
				stems = { id, status: 'error', progress: 0, error: job.error ?? `status ${res.status}` };
				return;
			}
			stems = { id, status: job.status, progress: job.progress ?? 0 };
			if (job.status === 'done') {
				spectroChannel = 'guitar';
				return;
			}
			await new Promise((r) => setTimeout(r, 1000));
		}
	}

	onMount(() => {
		fetch('/api/separate')
			.then((r) => (r.ok ? r.json() : null))
			.then((a) => (stemsAvailable = a?.available ? { device: a.device } : null))
			.catch(() => {});
	});

	// What the probe plays: the stem, or the reference (mix / sides).
	async function probeSource(): Promise<{
		key: string;
		buffer: ArrayBuffer;
		channel: SpectroChannel;
	} | null> {
		const source = effectiveSource;
		const channel = analysisChannel;
		if (isStem(source)) {
			return { key: `${referenceKey}|${source}`, buffer: await getStem(source), channel };
		}
		return referenceBuffer ? { key: referenceKey, buffer: referenceBuffer, channel } : null;
	}

	// Pitch probe: press and hold on the spectrogram to hear only that pitch
	// band of the reference (Shift: with its harmonics' bands too — sounds more
	// like the note, but overlaps other notes' harmonics, so gaps are less
	// clear), Mix or Sides as shown, from that moment on; drag up/down to move
	// the band. Hovering shows which band it would be.
	const probe = new PitchProbe();
	let probeMidi = $state<number | null>(null); // while a band is held
	let probeWhole = $state(false); // while a whole stem plays
	let hoverMidi = $state<number | null>(null);
	onMount(() => () => probe.stop());

	// Reference time and (semitone-snapped) pitch under the pointer.
	function spectroAt(e: PointerEvent): { refTime: number; midi: number } | null {
		if (!spectroCanvas || !spectrogram) return null;
		const w = spectroCanvas.clientWidth;
		const h = spectroCanvas.clientHeight;
		const cfg = DEFAULT_RENDER_CONFIG;
		const x = Math.max(cfg.paddingX, Math.min(w - cfg.paddingX, e.offsetX));
		const { timeToX, pxPerSec } = tabTimeScale(w, cfg);
		const t = currentTime + (x - timeToX(currentTime)) / pxPerSec;
		const [lo, hi] = spectrogramPitchRange(spectrogram, TUNINGS[tuningKey].openNotes);
		const y = Math.max(0, Math.min(h, e.offsetY));
		return { refTime: t + videoOffsetSec, midi: Math.round(hi - (y / h) * (hi - lo)) };
	}

	function onSpectroDown(e: PointerEvent) {
		if (e.button !== 0 || !referenceBuffer) return;
		const at = spectroAt(e);
		if (!at) return;
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		// One thing at a time: the probe replaces normal playback.
		if (playing) {
			playing = false;
			synth.stop();
			authorPlayStopAt = null;
			videoElement?.pause();
			lastVideoPlayCommand = 'pause';
		}
		// On a separated instrument, a plain hold plays the stem itself (Shift:
		// its pitch band). On the mix, a hold plays the pitch band (Shift: with
		// its harmonics).
		const whole = isStem(effectiveSource) && !e.shiftKey;
		const harmonics = !isStem(effectiveSource) && e.shiftKey;
		if (whole) probeWhole = true;
		else probeMidi = at.midi;
		probeSource()
			.then((src) => {
				if (!src) return;
				if (whole) {
					return probe.playWhole(
						src.key,
						src.buffer,
						'audio/ogg',
						at.refTime,
						videoVolume,
						listenChannel
					);
				}
				return probe.start(
					src.key,
					src.buffer,
					at.refTime,
					at.midi,
					src.channel,
					videoVolume,
					harmonics
				);
			})
			.catch(() => {
				probeMidi = null;
				probeWhole = false;
			});
	}

	function onSpectroMove(e: PointerEvent) {
		const at = spectroAt(e);
		hoverMidi = at?.midi ?? null;
		if (probeMidi !== null && at && at.midi !== probeMidi) {
			probeMidi = at.midi;
			probe.setPitch(at.midi);
		}
	}

	function stopProbe() {
		probe.stop();
		probeMidi = null;
		probeWhole = false;
	}

	// Draw the spectrogram for exactly the span the tab shows (same x
	// mapping, reference time = tab time + offset), with bar lines, the
	// playhead and the tuning's open strings as guides.
	function drawSpectrogramView(c: HTMLCanvasElement) {
		const dpr = window.devicePixelRatio || 1;
		const w = c.clientWidth;
		const h = c.clientHeight;
		if (!w || !h) return;
		if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
			c.width = Math.round(w * dpr);
			c.height = Math.round(h * dpr);
		}
		const ctx = c.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.fillStyle = '#05070a';
		ctx.fillRect(0, 0, w, h);
		ctx.font = '12px "JetBrains Mono Variable", ui-monospace, monospace';
		ctx.textBaseline = 'middle';
		if (!spectrogram) {
			ctx.fillStyle = spectroError ? '#ff6b6b' : '#6b788a';
			ctx.textAlign = 'center';
			ctx.fillText(
				spectroError
					? `Couldn't analyse the reference audio: ${spectroError}`
					: `Analysing reference audio… ${Math.round((spectroProgress ?? 0) * 100)}%`,
				w / 2,
				h / 2
			);
			return;
		}
		const cfg = DEFAULT_RENDER_CONFIG;
		const { timeToX, pxPerSec } = tabTimeScale(w, cfg);
		const x0 = cfg.paddingX;
		const x1 = w - cfg.paddingX;
		const t0 = currentTime + (x0 - timeToX(currentTime)) / pxPerSec;
		const t1 = t0 + (x1 - x0) / pxPerSec;
		ctx.save();
		ctx.beginPath();
		ctx.rect(x0, 0, x1 - x0, h);
		ctx.clip();
		const tuning = TUNINGS[tuningKey];
		const [lo, hi] = spectrogramPitchRange(spectrogram, tuning.openNotes);
		drawSpectrogramSpan(
			ctx,
			spectrogram,
			spectroStyle,
			t0 + videoOffsetSec,
			t1 + videoOffsetSec,
			x0,
			x1,
			h,
			[lo, hi]
		);
		// Bar lines, like the tab below.
		if (tab) {
			ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
			ctx.lineWidth = 1;
			for (let b = Math.floor(t0 / tab.secondsPerBar); b * tab.secondsPerBar <= t1; b++) {
				const x = Math.round(timeToX(b * tab.secondsPerBar)) + 0.5;
				ctx.beginPath();
				ctx.moveTo(x, 0);
				ctx.lineTo(x, h);
				ctx.stroke();
			}
		}
		ctx.restore();
		// Open strings of the current tuning: faint lines + labels in the margin.
		const yOf = (midi: number) => ((hi - midi) / (hi - lo)) * h;
		ctx.textAlign = 'right';
		tuning.openNotes.forEach((m, i) => {
			const y = Math.round(yOf(m)) + 0.5;
			ctx.strokeStyle = 'rgba(127, 180, 255, 0.28)';
			ctx.beginPath();
			ctx.moveTo(x0, y);
			ctx.lineTo(x1, y);
			ctx.stroke();
			ctx.fillStyle = '#7fb4ff';
			ctx.fillText(tuning.noteNames[i], x0 - 8, y);
		});
		// Playhead.
		const px = timeToX(currentTime);
		if (px >= x0 && px <= x1) {
			ctx.fillStyle = '#ff5577';
			ctx.fillRect(Math.round(px), 0, 1.5, h);
		}
		// Pitch probe: the band (held or hovered) and where it's playing.
		const band = probeWhole ? null : (probeMidi ?? hoverMidi);
		if (band !== null) {
			const top = yOf(band + 0.5);
			const bottom = yOf(band - 0.5);
			ctx.fillStyle = probeMidi !== null ? 'rgba(90, 200, 255, 0.16)' : 'rgba(90, 200, 255, 0.07)';
			ctx.fillRect(x0, top, x1 - x0, bottom - top);
			ctx.strokeStyle = probeMidi !== null ? 'rgba(90, 200, 255, 0.8)' : 'rgba(90, 200, 255, 0.35)';
			ctx.beginPath();
			ctx.moveTo(x0, Math.round(top) + 0.5);
			ctx.lineTo(x1, Math.round(top) + 0.5);
			ctx.moveTo(x0, Math.round(bottom) + 0.5);
			ctx.lineTo(x1, Math.round(bottom) + 0.5);
			ctx.stroke();
			const label = pitchName(band, tuningUsesFlats(tuning));
			ctx.textAlign = 'right';
			const tw = ctx.measureText(label).width;
			const ly = (top + bottom) / 2;
			ctx.fillStyle = 'rgba(5, 7, 10, 0.8)';
			ctx.fillRect(x1 - tw - 12, ly - 9, tw + 8, 18);
			ctx.fillStyle = '#5ac8ff';
			ctx.fillText(label, x1 - 8, ly);
		}
		const probePos = probe.position();
		if (probePos !== null) {
			const qx = timeToX(probePos - videoOffsetSec);
			if (qx >= x0 && qx <= x1) {
				ctx.fillStyle = '#5ac8ff';
				ctx.fillRect(Math.round(qx), 0, 1.5, h);
			}
		}
	}
	let showFileDetails = $state(false);
	let showExportResult = $state(false);
	function toggleMenu(id: MenuId) {
		openMenu = openMenu === id ? null : id;
	}
	onMount(() => {
		const onDown = (e: PointerEvent) => {
			if (openMenu && !(e.target as Element | null)?.closest?.('.menubar')) openMenu = null;
		};
		window.addEventListener('pointerdown', onDown, { capture: true });
		return () => window.removeEventListener('pointerdown', onDown, { capture: true });
	});
	let exportResultName = $state<string | null>(null);
	let exportResultSize = $state(0);
	let exportFramesEncoded = $state(0);
	let tabPositionOnVideo = $state<
		'bottom' | 'top' | 'extend-below' | 'extend-above' | 'crop-top-bottom'
	>('bottom');
	let tabSizePercent = $state(90);
	let tabPaddingPercent = $state(2);
	let exportFps = $state(60);
	// Which ffmpeg encoder the server should use. h264_nvenc is fastest on
	// NVIDIA hardware; libx264 is the software fallback. We probe on mount.
	let exportEncoder = $state<'h264_nvenc' | 'hevc_nvenc' | 'av1_nvenc' | 'libx264' | 'libx265'>(
		'h264_nvenc'
	);
	let availableEncoders = $state<string[]>([]);
	let exportRecorder: MediaRecorder | null = null;
	// Used to only issue play/pause commands when playing state changes, not on
	// every rAF tick.
	let lastVideoPlayCommand: 'play' | 'pause' | null = null;
	// Debounce timer for offset-driven seeks. Non-null = a seek is pending.
	let offsetSeekTimer: ReturnType<typeof setTimeout> | null = null;
	// Set to true while we've auto-paused playback for an offset change so we
	// know to resume once the video seek completes.
	let pausedForOffsetSeek = false;
	const synth = new Synth();
	$effect(() => synth.setVolume(volume));
	$effect(() => synth.setMetronome(metronomeOn, metronomeVol));
	// Push the videoVolume slider through to the actual media element — or,
	// once it's routed for channel listening (L / R), to its router.
	$effect(() => {
		const el = videoElement;
		if (!el) return;
		const ch = listenChannel;
		const router = ch !== 'both' ? ChannelRouter.for(el) : ChannelRouter.existing(el);
		if (router) {
			router.setChannel(ch);
			router.setLevel(videoAudioOn && !stemPlaying ? videoVolume : 0);
		} else {
			el.volume = Math.max(0, Math.min(1, videoVolume));
		}
	});
	// If playback is in progress and the metronome is toggled on/off, re-queue so
	// the change is audible immediately rather than only on the next play() call.
	let lastMetronomeState = false;
	$effect(() => {
		if (playing && tab && metronomeOn !== lastMetronomeState) {
			if (audioOn) synthRestart(currentTime);
		}
		lastMetronomeState = metronomeOn;
	});

	// DAW transport sync (loopMIDI etc.)
	let syncPorts = $state<SyncPortInfo[]>([]);
	let syncSelectedPort = $state<string>('');
	let syncConnected = $state(false);
	let syncError = $state<string | null>(null);
	// Positive = Tabutabu jumps forward this many ms whenever the DAW starts or
	// seeks. Compensates for loopMIDI + browser event delivery (usually 10–30 ms).
	let syncOffsetMs = $state(20);
	let keepLeadingSilence = $state(false);
	let preservePositionOnStart = $state(false);
	let syncDebug = $state(false);
	// DAW positions are in "song time" (bar 1 beat 1 = 0). Tab positions can be
	// shifted forward if we trimmed leading silence when parsing the file. This
	// converts one to the other. If the tab preserved leading silence, the trim
	// is 0 and DAW time == tab time.
	function dawToTabTime(dawSec: number): number {
		if (!tab) return 0;
		return dawSec - tab.trimmedLeadingSec + syncOffsetMs / 1000;
	}

	const dawSync = new DawSync({
		onStart: () => {
			if (!tab) return;
			const start = Math.max(0, Math.min(effectiveDurationSec, dawToTabTime(0)));
			currentTime = start;
			lastSeekTime = start;
			if (!playing) playing = true;
			if (audioOn) synth.play(tab, start);
		},
		onContinue: () => {
			if (!tab) return;
			if (!playing) {
				playing = true;
				if (audioOn) synth.play(tab, currentTime);
			}
		},
		onStop: () => {
			if (playing) {
				playing = false;
				synth.stop();
			}
		},
		onSeek: (pos: number) => {
			if (!tab) return;
			const t = Math.max(0, Math.min(effectiveDurationSec, dawToTabTime(pos)));
			currentTime = t;
			lastSeekTime = t;
			if (playing && audioOn) synth.play(tab, t);
		}
	});
	// Keep SPP conversion accurate when a new tab is loaded (its BPM may differ).
	$effect(() => {
		if (tab) dawSync.setTempo(tab.bpm);
	});
	$effect(() => {
		dawSync.preservePositionOnStart = preservePositionOnStart;
	});
	$effect(() => {
		dawSync.debug = syncDebug;
	});

	async function refreshSyncPorts() {
		try {
			syncError = null;
			syncPorts = await dawSync.listPorts();
			if (!syncSelectedPort && syncPorts.length > 0) syncSelectedPort = syncPorts[0].id;
		} catch (err) {
			syncError = err instanceof Error ? err.message : String(err);
		}
	}

	async function syncConnect() {
		try {
			syncError = null;
			await dawSync.connect(syncSelectedPort);
			syncConnected = true;
			try {
				localStorage.setItem('tabutabu.syncPort', syncSelectedPort);
			} catch {
				// ignore
			}
		} catch (err) {
			syncError = err instanceof Error ? err.message : String(err);
			syncConnected = false;
		}
	}

	function syncDisconnect() {
		dawSync.disconnect();
		syncConnected = false;
	}

	// Expose parsed tab on window for interactive debugging in the DevTools
	// console (e.g. `tabDebug.notes.filter(n => Math.abs(n.time - 21.5) < 0.2)`).
	$effect(() => {
		if (typeof window !== 'undefined') {
			(window as unknown as { tabDebug?: Tab | null }).tabDebug = tab;
		}
	});

	async function loadFileFromBuffer(
		buffer: ArrayBuffer,
		name: string,
		persist: boolean
	): Promise<void> {
		parseError = null;
		// Gate persistence effects while we swap in the new file's state. Otherwise
		// the effects would fire between `fileName = name` and the awaited IDB
		// reads and clobber the saved overrides/annotations with the empty ones
		// that are still in memory.
		suppressPerFilePersist = true;
		fileName = name;
		try {
			midiBuffer = buffer;
			// Load per-file overrides + annotations before parsing so the first
			// render applies them.
			try {
				const saved = (await idbGet(`overrides:${name}`)) as Record<string, number> | undefined;
				overrides = saved ?? {};
			} catch {
				overrides = {};
			}
			try {
				const savedAnno = (await idbGet(`annotations:${name}`)) as
					Record<string, 'hammer' | 'pull' | 'tap' | 'off'> | undefined;
				annotations = savedAnno ?? {};
			} catch {
				annotations = {};
			}
			suppressPerFilePersist = false;
			const isDawproject = /\.dawproject$/i.test(name);
			const opts = { honorChannelStrings, keepLeadingSilence, overrides, annotations };
			if (isDawproject) {
				inspection = null;
				tab = await parseDawproject(midiBuffer, TUNINGS[tuningKey], opts);
			} else {
				inspection = inspectMidi(midiBuffer);
				tab = parseMidi(midiBuffer, TUNINGS[tuningKey], opts);
			}
			isDawprojectFile = isDawproject;
			currentTime = 0;
			if (persist) {
				try {
					await idbSet('lastFile', { name, buffer, isDawproject });
				} catch {
					// storage might be full or blocked — best-effort persistence
				}
			}
		} catch (err) {
			parseError = err instanceof Error ? err.message : String(err);
			tab = null;
			midiBuffer = null;
		} finally {
			suppressPerFilePersist = false;
		}
	}

	async function onFile(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		const buf = await file.arrayBuffer();
		await loadFileFromBuffer(buf, file.name, true);
	}

	async function onVideoFile(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		if (videoUrl) URL.revokeObjectURL(videoUrl);
		videoUrl = URL.createObjectURL(file);
		videoFileName = file.name;
		lastVideoPlayCommand = null;
		const buf = await file.arrayBuffer();
		setReferenceAudio(buf, file.type, file.name);
		try {
			await idbSet('lastVideo', { name: file.name, buffer: buf, type: file.type });
		} catch {
			// storage full or blocked — video still works this session
		}
	}

	// Compute the composite layout in a target coordinate system. `outW`/`outH`
	// are the canvas dimensions we're drawing into; the function derives where
	// the video and tab go and whether the canvas needs to be taller than the
	// video (extend modes).
	type CompositeLayout = {
		outW: number;
		outH: number;
		videoX: number;
		videoY: number;
		videoW: number;
		videoH: number;
		tabX: number;
		tabY: number;
		tabW: number;
		tabH: number;
		// Pixels to crop from the SOURCE video's top / bottom before placing
		// it in the output. Used by the "crop-top-bottom" mode so the output
		// stays at source aspect while the tab occupies the (cropped) bottom
		// band. Zero for every other mode.
		cropTop: number;
		cropBottom: number;
	};

	function computeCompositeLayout(baseW: number, baseH: number): CompositeLayout {
		const videoAspect = baseH / baseW;
		// Match the UI canvas's aspect exactly so the export looks like the
		// on-screen tab. The renderer's padding constants determine string
		// spacing — see DEFAULT_RENDER_CONFIG in lib/tab/renderer.ts.
		// The exported tab is always rendered at 1280×260 (see /render), so the
		// preview uses that aspect, not the on-screen tab canvas (whose width
		// depends on the window).
		const tabAspect = 260 / 1280;
		const tabW = (baseW * tabSizePercent) / 100;
		const tabH = tabW * tabAspect;
		const padPx = (baseH * tabPaddingPercent) / 100;

		if (tabPositionOnVideo === 'extend-below' || tabPositionOnVideo === 'extend-above') {
			const outH = baseH + tabH + padPx * 2;
			const isBelow = tabPositionOnVideo === 'extend-below';
			return {
				outW: baseW,
				outH,
				videoX: 0,
				videoY: isBelow ? 0 : tabH + padPx * 2,
				videoW: baseW,
				videoH: baseH,
				tabX: (baseW - tabW) / 2,
				tabY: isBelow ? baseH + padPx : padPx,
				tabW,
				tabH,
				cropTop: 0,
				cropBottom: 0
			};
		}

		if (tabPositionOnVideo === 'crop-top-bottom') {
			// Output stays at source aspect. To fit the tab, we crop the
			// source both from the top (removing headroom) AND from the
			// bottom (removing the strip the tab will occupy). Split 50/50.
			// No source pixels get scaled — just cropped — so the visible
			// person/guitar is at the same size they'd be in the raw source.
			const totalCrop = tabH + padPx;
			const cropTop = Math.floor(totalCrop / 2);
			const cropBottom = totalCrop - cropTop;
			const videoH = baseH - cropTop - cropBottom;
			return {
				outW: baseW,
				outH: baseH,
				videoX: 0,
				videoY: 0,
				videoW: baseW,
				videoH,
				tabX: (baseW - tabW) / 2,
				tabY: baseH - tabH,
				tabW,
				tabH,
				cropTop,
				cropBottom
			};
		}

		// Overlay modes — same size as source video.
		const isBottomOverlay = tabPositionOnVideo === 'bottom';
		return {
			outW: baseW,
			outH: baseH,
			videoX: 0,
			videoY: 0,
			videoW: baseW,
			videoH: baseH,
			tabX: (baseW - tabW) / 2,
			tabY: isBottomOverlay ? baseH - tabH - padPx : padPx,
			tabW,
			tabH,
			cropTop: 0,
			cropBottom: 0
		};
	}

	function drawCompositeInto(
		cctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
		layout: CompositeLayout,
		bgColor: string,
		tabSource: HTMLCanvasElement | null = null
	): void {
		if (!videoElement) return;
		cctx.fillStyle = bgColor;
		cctx.fillRect(0, 0, layout.outW, layout.outH);
		try {
			// When crop-top-bottom mode is active, we need drawImage's 9-arg
			// form to pull only the middle band of the source. Source coords
			// (sx, sy, sw, sh) are in native video pixels; layout.cropTop/
			// cropBottom are in output coords, but for crop-top-bottom mode
			// the output height equals source height so they line up 1:1
			// with the source's native height (via the source's own aspect).
			if (layout.cropTop > 0 || layout.cropBottom > 0) {
				const vw = videoElement.videoWidth;
				const vh = videoElement.videoHeight;
				// The crop values were expressed in *output* pixel space; here
				// we need them in *source* pixel space. Map by the ratio of
				// the source's native height to the layout's implied full
				// source height (= layout.videoH + cropTop + cropBottom).
				const impliedSrcH = layout.videoH + layout.cropTop + layout.cropBottom;
				const srcScale = impliedSrcH > 0 ? vh / impliedSrcH : 1;
				const sy = layout.cropTop * srcScale;
				const sh = layout.videoH * srcScale;
				cctx.drawImage(
					videoElement,
					0,
					sy,
					vw,
					sh,
					layout.videoX,
					layout.videoY,
					layout.videoW,
					layout.videoH
				);
			} else {
				cctx.drawImage(videoElement, layout.videoX, layout.videoY, layout.videoW, layout.videoH);
			}
		} catch {
			return;
		}
		const src = tabSource ?? canvas;
		if (src) {
			cctx.drawImage(src, layout.tabX, layout.tabY, layout.tabW, layout.tabH);
		}
	}

	// Off-screen tab canvas used during export so we can render the tab at any
	// arbitrary time synchronously, without having to wait for the app's rAF
	// loop to catch up. Sized at a fixed logical resolution (2560×520 gives
	// crisp output regardless of the display DPR).
	let exportTabCanvas: HTMLCanvasElement | null = null;

	// Ensures the offscreen export tab canvas exists at the target width/height
	// requested by the caller. If the size changed since the last call, resize.
	// Callers pass the exact composite tab region size so text is 1:1 (no
	// scaling in drawImage → same font-to-canvas ratio as the live UI).
	function renderExportTabAt(t: number, targetW: number, targetH: number): void {
		if (!tab) return;
		if (!exportTabCanvas) {
			exportTabCanvas = document.createElement('canvas');
		}
		const w = Math.max(1, Math.round(targetW));
		const h = Math.max(1, Math.round(targetH));
		if (exportTabCanvas.width !== w || exportTabCanvas.height !== h) {
			exportTabCanvas.width = w;
			exportTabCanvas.height = h;
		}
		const ectx = exportTabCanvas.getContext('2d');
		if (!ectx) return;
		const cfg = { ...DEFAULT_RENDER_CONFIG };
		cfg.width = w;
		cfg.height = h;
		cfg.mode = renderMode;
		cfg.playheadStyle = playheadStyle;
		cfg.theme = theme;
		cfg.stringFlashEnabled = stringFlashEnabled;
		cfg.pixelsPerSecond = pixelsPerSecond;
		cfg.barsPerPage = barsPerPage;
		cfg.peekBeats = peekBeats;
		cfg.showNoteLengths = showNoteLengths;
		// Match the UI's paddings (already in DEFAULT_RENDER_CONFIG) so the
		// exported tab looks identical to what the user sees on screen.
		ectx.setTransform(1, 0, 0, 1, 0, 0);
		renderTabFrame(ectx, tab, TUNINGS[tuningKey], t, cfg);
	}

	function drawComposite(): void {
		if (!compositeCanvas || !videoElement) return;
		const cctx = compositeCanvas.getContext('2d');
		if (!cctx) return;

		// Base dimensions come from the source video, but the DISPLAY canvas is
		// sized to its CSS box × devicePixelRatio for a crisp preview. The
		// layout scales up/down to match.
		const srcW = videoElement.videoWidth || 1920;
		const srcH = videoElement.videoHeight || 1080;
		const layout = computeCompositeLayout(srcW, srcH);
		const cssW = compositeCanvas.clientWidth;
		if (cssW <= 0) return;
		const dpr = window.devicePixelRatio || 1;
		const scale = cssW / layout.outW;
		const cssH = Math.round(layout.outH * scale);
		const dW = Math.round(cssW * dpr);
		const dH = Math.round(cssH * dpr);
		if (compositeCanvas.width !== dW || compositeCanvas.height !== dH) {
			compositeCanvas.width = dW;
			compositeCanvas.height = dH;
			compositeCanvas.style.height = cssH + 'px';
		}

		const displayLayout = computeCompositeLayout(dW, dH);
		// Recompute with actual device pixels for the display target.
		void displayLayout;

		// Scale the layout to device pixels and draw.
		const displayScale = dW / layout.outW;
		const scaled: CompositeLayout = {
			outW: dW,
			outH: dH,
			videoX: layout.videoX * displayScale,
			videoY: layout.videoY * displayScale,
			videoW: layout.videoW * displayScale,
			videoH: layout.videoH * displayScale,
			tabX: layout.tabX * displayScale,
			tabY: layout.tabY * displayScale,
			tabW: layout.tabW * displayScale,
			tabH: layout.tabH * displayScale,
			cropTop: layout.cropTop * displayScale,
			cropBottom: layout.cropBottom * displayScale
		};
		drawCompositeInto(cctx, scaled, '#000');
	}

	let exportCancelled = false;

	// Seek and wait for the `seeked` event, with a timeout so a browser that
	// never fires it doesn't block the whole export. If the video is already
	// at the target time we skip the wait entirely.
	async function seekVideoTo(el: HTMLVideoElement, t: number): Promise<void> {
		if (Math.abs(el.currentTime - t) < 1e-3) return;
		await new Promise<void>((resolve) => {
			const onSeeked = () => {
				el.removeEventListener('seeked', onSeeked);
				resolve();
			};
			el.addEventListener('seeked', onSeeked);
			const timeout = setTimeout(() => {
				el.removeEventListener('seeked', onSeeked);
				resolve();
			}, 2000);
			void timeout;
			el.currentTime = t;
		});
	}

	// Puppeteer-driven server export. The client just packages tab data +
	// source video + render config and POSTs to /api/export. The server
	// launches puppeteer, which loads /render/<jobId> in its own foreground
	// tab (unthrottled), captures frames via rVFC, and pipes them into ffmpeg
	// with NVENC. This lets the user's tab be backgrounded during export.
	async function startExport() {
		if (!tab || !videoElement || !videoUrl || !compositeCanvas) return;
		if (exportResultUrl) {
			URL.revokeObjectURL(exportResultUrl);
			exportResultUrl = null;
			exportResultName = null;
			exportResultSize = 0;
		}
		exportError = null;
		isExporting = true;
		exportProgress = 0;
		exportCancelled = false;
		exportStage = 'encoding';
		exportFramesEncoded = 0;

		const el = videoElement;
		const srcW = el.videoWidth || 1920;
		const srcH = el.videoHeight || 1080;
		const layout = computeCompositeLayout(srcW, srcH);
		// NVENC prefers multiples of 16. Round up and center-letterbox.
		const align = 16;
		const width = Math.ceil(layout.outW / align) * align;
		const height = Math.ceil(layout.outH / align) * align;
		const offsetX = Math.floor((width - layout.outW) / 2);
		const offsetY = Math.floor((height - layout.outH) / 2);
		const scaledLayout: CompositeLayout = {
			outW: width,
			outH: height,
			videoX: layout.videoX + offsetX,
			videoY: layout.videoY + offsetY,
			videoW: layout.videoW,
			videoH: layout.videoH,
			tabX: layout.tabX + offsetX,
			tabY: layout.tabY + offsetY,
			tabW: layout.tabW,
			tabH: layout.tabH,
			cropTop: layout.cropTop,
			cropBottom: layout.cropBottom
		};

		// Grab the source video bytes so we can send it with the config.
		let videoBlob: Blob | null = null;
		try {
			videoBlob = await (await fetch(videoUrl)).blob();
		} catch (err) {
			exportError =
				'Could not read source video: ' + (err instanceof Error ? err.message : String(err));
			isExporting = false;
			return;
		}

		const configPayload = {
			width,
			height,
			offsetX,
			offsetY,
			compositeLayout: scaledLayout,
			videoOffsetSec,
			encoder: exportEncoder,
			bitrate: 8_000_000,
			tab,
			tuningKey,
			renderMode,
			playheadStyle,
			theme,
			stringFlashEnabled,
			pixelsPerSecond,
			barsPerPage,
			peekBeats,
			showNoteLengths,
			videoMime: videoBlob.type || 'video/mp4'
		};

		const form = new FormData();
		form.append('config', JSON.stringify(configPayload));
		form.append(
			'video',
			videoBlob,
			videoFileName || 'source' + (videoBlob.type.includes('webm') ? '.webm' : '.mp4')
		);

		exportStage = 'finalizing';
		console.log('[export] uploading job to server', {
			width,
			height,
			encoder: exportEncoder,
			videoBytes: videoBlob.size
		});
		let response: Response;
		try {
			response = await fetch('/api/export', { method: 'POST', body: form });
		} catch (err) {
			exportError = 'Server request failed: ' + (err instanceof Error ? err.message : String(err));
			isExporting = false;
			return;
		}
		console.log('[export] response status', response.status);
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			console.error('[export] server error body:', text);
			exportError = `Server error ${response.status}: ${text}`;
			isExporting = false;
			return;
		}

		if (!exportCancelled && !exportError) {
			const blob = await response.blob();
			console.log('[export] response blob', { size: blob.size, type: blob.type });
			if (blob.size === 0) {
				exportError = 'server returned empty body';
				isExporting = false;
				return;
			}
			if (exportResultUrl) URL.revokeObjectURL(exportResultUrl);
			exportResultUrl = URL.createObjectURL(blob);
			showExportResult = true;
			exportResultName = (fileName ?? 'tabutabu').replace(/\.[^.]+$/, '') + '-tab.mp4';
			exportResultSize = blob.size;
			exportStage = 'done';
			console.log('[export] preview ready', exportResultName);
		}

		isExporting = false;
		exportProgress = 0;
		setTimeout(() => {
			if (!isExporting) exportStage = 'idle';
		}, 2000);
	}

	function cancelExport() {
		exportCancelled = true;
	}

	function clearVideo() {
		if (videoUrl) URL.revokeObjectURL(videoUrl);
		videoUrl = null;
		videoFileName = null;
		lastVideoPlayCommand = null;
		void idbDel('lastVideo');
		for (const s of ['mix', 'sides', ...STEM_SOURCES]) {
			for (const side of ['', ':left', ':right']) void idbDel(`lastSpectrogram:${s}${side}`);
		}
		setReferenceAudio(null);
	}

	// Called every rAF. Handles two things:
	//   - Drift correction: if the video's currentTime has drifted from the
	//     desired target (tab time + offset), snap it back. Skipped while an
	//     offset-driven seek is already pending so we don't race.
	//   - Play/pause: mirror the tab's playing state.
	// Offset-change-driven seeks are handled by a separate $effect below, so
	// they only fire when the offset actually changes (rather than being
	// rescheduled every frame, which is what stopped them from ever firing).
	function syncVideo(): void {
		if (!videoElement || !videoUrl) return;
		// During export we drive the video directly (play() + rVFC). Any drift
		// correction here would yank currentTime back to the tab's playhead
		// and reset the export playback to 0.
		if (isExporting) return;

		if (!offsetSeekTimer) {
			const target = Math.max(0, currentTime + videoOffsetSec);
			// 300ms tolerance rather than 100. Small clock drift between audio and
			// video decoders is normal; an in-play seek to correct it causes
			// visible stutter. Only correct when they meaningfully diverge.
			if (Math.abs(videoElement.currentTime - target) > 0.3) {
				videoElement.currentTime = target;
			}
		}

		// The reference plays whenever playback runs — independent of the synth
		// (turning the synth off to hear only the reference must not stop it).
		if (playing) {
			if (lastVideoPlayCommand !== 'play') {
				ChannelRouter.resume();
				videoElement.play().catch(() => {});
				lastVideoPlayCommand = 'play';
			}
		} else {
			if (lastVideoPlayCommand !== 'pause') {
				videoElement.pause();
				lastVideoPlayCommand = 'pause';
			}
		}
	}

	// Debounce offset-change-driven seeks. Fires once on load (offset transitions
	// from default 0 to the persisted value) and on every subsequent change.
	// While tuning during playback, we auto-pause and wait for `seeked` to fire
	// before resuming — otherwise audio drifts ahead of the still-decoding video.
	$effect(() => {
		void videoOffsetSec;
		void videoUrl;
		if (!videoUrl) return;

		// Everything below reads reactive state we don't want to track — only the
		// two deps above should trigger this effect. Otherwise every spacebar
		// toggle would cause an unrelated seek storm.
		untrack(() => {
			if (playing && !pausedForOffsetSeek) {
				pausedForOffsetSeek = true;
				playing = false;
				synth.stop();
			}
		});

		if (offsetSeekTimer) clearTimeout(offsetSeekTimer);
		offsetSeekTimer = setTimeout(() => {
			offsetSeekTimer = null;
			const el = videoElement;
			if (!el) {
				resumeAfterOffsetSeek();
				return;
			}
			const target = untrack(() => Math.max(0, currentTime + videoOffsetSec));
			if (Math.abs(el.currentTime - target) < 0.001) {
				resumeAfterOffsetSeek();
				return;
			}
			// Fallback in case `seeked` never fires (rare browser edge case). If
			// the seek is genuinely long, this bails out early — playback resumes
			// even if the video is still mid-decode, and drift correction picks
			// up whatever's left.
			const fallback = setTimeout(() => {
				el.removeEventListener('seeked', onSeeked);
				resumeAfterOffsetSeek();
			}, 800);
			const onSeeked = () => {
				clearTimeout(fallback);
				el.removeEventListener('seeked', onSeeked);
				resumeAfterOffsetSeek();
			};
			el.addEventListener('seeked', onSeeked, { once: true });
			el.currentTime = target;
		}, 150);
	});

	function resumeAfterOffsetSeek(): void {
		if (!pausedForOffsetSeek) return;
		pausedForOffsetSeek = false;
		if (tab) {
			playing = true;
			if (audioOn) synthRestart(currentTime);
		}
	}

	function nudgeOffset(deltaSec: number) {
		videoOffsetSec = Math.round((videoOffsetSec + deltaSec) * 1000) / 1000;
	}

	// Track the loaded video's duration so we can extend the tab's effective
	// end to whichever is longer. The tab keeps its notes; the timeline and
	// auto-pause use `effectiveDurationSec` instead of `tab.durationSec`.
	$effect(() => {
		const el = videoElement;
		if (!el) {
			videoDuration = null;
			return;
		}
		const capture = () => {
			if (el.duration && isFinite(el.duration)) videoDuration = el.duration;
		};
		// Prime the video decoder on first metadata load: seek to the target
		// position (tab time + video offset) so drawImage doesn't draw a
		// stale/black frame during the first playback. Without this the very
		// first Play after page load produced a bad preview and had to be
		// worked around by pressing Reset before Play.
		const prime = () => {
			if (playing) return;
			const target = Math.max(0, currentTime + videoOffsetSec);
			if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
		};
		el.addEventListener('loadedmetadata', capture);
		el.addEventListener('loadedmetadata', prime);
		el.addEventListener('durationchange', capture);
		capture();
		return () => {
			el.removeEventListener('loadedmetadata', capture);
			el.removeEventListener('loadedmetadata', prime);
			el.removeEventListener('durationchange', capture);
		};
	});

	const effectiveDurationSec = $derived.by(() => {
		if (!tab) return 0;
		let end = tab.durationSec;
		if (videoDuration !== null) end = Math.max(end, videoDuration - videoOffsetSec);
		return end;
	});

	// Re-run parsing whenever tuning, channel-string mode, or the leading-silence
	// toggle changes.
	$effect(() => {
		const t = TUNINGS[tuningKey];
		const opts = { honorChannelStrings, keepLeadingSilence, overrides, annotations };
		if (!midiBuffer) return;
		// Authored tabs are detached from any source file (see
		// detachFromSourceFile); never re-parse over them.
		if (untrack(() => mode) === 'author') return;
		const run = async () => {
			try {
				tab = isDawprojectFile
					? await parseDawproject(midiBuffer!, t, opts)
					: parseMidi(midiBuffer!, t, opts);
			} catch (err) {
				parseError = err instanceof Error ? err.message : String(err);
			}
		};
		run();
	});

	// ---- Authoring-mode handlers --------------------------------------------

	function enterAuthorMode() {
		// If there's already a tab loaded, just switch modes and start editing
		// on top of it. Otherwise open the New-tab dialog to configure BPM /
		// time signature / tuning before we can place any notes.
		mode = 'author';
		if (!tab) {
			tapTimes = [];
			showNewTabDialog = true;
		} else {
			detachFromSourceFile();
		}
	}

	// Once a tab is being authored it becomes its own document: drop the
	// link to the parsed MIDI/dawproject buffer so tuning / override changes
	// can't re-parse the old file over the user's edits.
	function detachFromSourceFile() {
		midiBuffer = null;
		isDawprojectFile = false;
	}

	// Changing the tuning while authoring keeps the fret numbers (that's
	// what the tab shows) and recomputes each note's pitch for the new
	// open strings, so playback and MIDI export follow the new tuning.
	let lastAuthorTuningKey: string | null = null;
	$effect(() => {
		const key = tuningKey;
		if (untrack(() => mode) !== 'author') {
			lastAuthorTuningKey = key;
			return;
		}
		if (lastAuthorTuningKey === null || lastAuthorTuningKey === key) {
			lastAuthorTuningKey = key;
			return;
		}
		lastAuthorTuningKey = key;
		untrack(() => {
			if (!tab) return;
			const open = TUNINGS[key].openNotes;
			for (const n of tab.notes) n.midi = open[n.stringIndex] + n.fret;
		});
	});

	// Explicit "New tab…" button in the author toolbar. Always opens the
	// dialog regardless of whether a tab is currently loaded, so the user
	// can wipe an old session and start over.
	function openNewTabDialog() {
		tapTimes = [];
		showNewTabDialog = true;
	}

	function resetTaps() {
		tapTimes = [];
	}

	// Apply the currently-estimated tap BPM to the loaded tab. Updates the
	// derived seconds-per-bar so the renderer / grid / focus / playback all
	// pick up the new tempo. Note times themselves are absolute (seconds)
	// and don't shift — the goal is to line the bar grid up with the
	// audible downbeats of the reference video/audio.
	function applyTapBpm() {
		if (!tab || tapBpm === null) return;
		const clamped = Math.max(20, Math.min(400, tapBpm));
		const beats = tab.timeSignature[0];
		const newSecondsPerBar = beats * (60 / clamped);
		tab.bpm = clamped;
		tab.secondsPerBar = newSecondsPerBar;
		tab = tab;
		tapTimes = [];
	}

	// Typed tempo: notes keep their place in the bar (they move with the
	// grid), and so does the playhead. Undoable.
	function setTempo(value: number) {
		if (!tab || !Number.isFinite(value)) return;
		const bpm = Math.max(20, Math.min(400, value));
		if (Math.abs(bpm - tab.bpm) < 1e-9) return;
		const k = tab.bpm / bpm;
		commitEdit(cmdSetTempo(bpm));
		currentTime *= k;
		if (playing && audioOn) synthRestart(currentTime);
	}

	function tapTempo() {
		const now = performance.now();
		// Reset the tap set if the last tap was more than 2 s ago — the user
		// probably restarted the count.
		if (tapTimes.length > 0 && now - tapTimes[tapTimes.length - 1] > 2000) {
			tapTimes = [now];
		} else {
			tapTimes = [...tapTimes, now];
			// Cap so we don't drift on stale samples.
			if (tapTimes.length > 12) tapTimes = tapTimes.slice(-12);
		}
	}

	function confirmNewTab() {
		const bpm = Math.max(20, Math.min(400, newTabBpm));
		const top = Math.max(1, Math.min(16, newTabTimeSigTop));
		const newTab = makeEmptyTab({
			bpm,
			timeSignature: [top, newTabTimeSigBottom],
			bars: Math.max(1, newTabBars)
		});
		detachFromSourceFile();
		tab = newTab;
		history = makeHistory();
		fileName = null;
		currentTime = 0;
		playing = false;
		synth.stop();
		authorFocus = { barIdx: 0, beatIdx: 0 };
		authorPlayStopAt = null;
		showNewTabDialog = false;
		// Wipe the previously-loaded MIDI/dawproject from IDB so a refresh
		// doesn't half-restore an old session on top of this fresh one.
		void idbDel('lastFile').catch(() => {});
		void idbSet('authorTab', $state.snapshot(newTab)).catch(() => {});
	}

	// ---- Share links -------------------------------------------------------
	// "Share link" copies a URL with the whole tab packed into its #tab=…
	// fragment. Opening such a link — or #gist=<id>, a public GitHub gist
	// holding the link or its payload, for a shorter URL — loads the tab.
	let shareStatus = $state<string | null>(null);
	let shareStatusTimer: ReturnType<typeof setTimeout> | undefined;
	function flashShareStatus(text: string) {
		shareStatus = text;
		clearTimeout(shareStatusTimer);
		shareStatusTimer = setTimeout(() => (shareStatus = null), 2500);
	}

	async function copyShareLink() {
		if (!tab) return;
		try {
			const payload = await encodeShare({
				tab: $state.snapshot(tab),
				tuningKey,
				videoOffsetSec
			});
			const url = `${location.origin}${location.pathname}#tab=${payload}`;
			await navigator.clipboard.writeText(url);
			flashShareStatus(`Copied (${url.length.toLocaleString()} chars)`);
		} catch (err) {
			flashShareStatus('Copy failed');
			console.error('Share link failed', err);
		}
	}

	// Load a tab from the current URL's #tab= / #gist= fragment, if any.
	// Returns whether one was opened.
	async function openFromHash(): Promise<boolean> {
		const params = new URLSearchParams(location.hash.slice(1));
		const tabParam = params.get('tab');
		const gistParam = params.get('gist');
		if (!tabParam && !gistParam) return false;
		// Drop the fragment right away: edits autosave, and a refresh must
		// reopen the edited tab, not the original link.
		clearShareHash();
		try {
			const payload = tabParam ?? (await fetchGistPayload(gistParam!));
			const shared = await decodeShare(
				payload,
				(key) => (key in TUNINGS ? TUNINGS[key] : TUNINGS.standard).openNotes
			);
			if (
				mode === 'author' &&
				tab &&
				tab.notes.length > 0 &&
				!confirm('Open the shared tab? It replaces the tab you are editing.')
			) {
				return false;
			}
			openSharedTab(shared);
			return true;
		} catch (err) {
			alert(`Couldn't open the shared tab: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	function clearShareHash() {
		window.history.replaceState(null, '', location.pathname + location.search);
	}

	function openSharedTab(shared: SharedTab) {
		const opened: Tab = {
			...shared.tab,
			notes: shared.tab.notes.map((n) => ({ ...n, id: newNoteId() }))
		};
		detachFromSourceFile();
		mode = 'author';
		if (shared.tuningKey in TUNINGS) tuningKey = shared.tuningKey as keyof typeof TUNINGS;
		tab = opened;
		history = makeHistory();
		fileName = null;
		playing = false;
		synth.stop();
		currentTime = 0;
		authorFocus = { barIdx: 0, beatIdx: 0 };
		authorPlayStopAt = null;
		videoOffsetSec = shared.videoOffsetSec;
		void idbSet('authorTab', $state.snapshot(opened)).catch(() => {});
	}

	// Run an author-mode edit as one undo step. Every edit is followed by a
	// hammer/pull reconcile so auto h/p directions stay correct after the
	// previous note on a string is edited, moved or deleted.
	function commitEdit(cmd: Command) {
		if (!tab) return;
		runCmd(tab, history, batchCommand(cmd.label, [cmd, cmdReconcileHammerPull()]));
	}

	function handleUndo() {
		if (!tab) return;
		if (undoCmd(tab, history)) tab = tab; // trigger reactivity
	}
	function handleRedo() {
		if (!tab) return;
		if (redoCmd(tab, history)) tab = tab;
	}

	// Derive the [start, end) time range of the current author focus.
	function authorFocusRange(): { start: number; end: number } {
		if (!tab) return { start: 0, end: 0 };
		const beats = tab.timeSignature[0];
		const secondsPerBeat = tab.secondsPerBar / beats;
		const barStart = authorFocus.barIdx * tab.secondsPerBar;
		if (authorFocus.beatIdx === 0) {
			return { start: barStart, end: barStart + tab.secondsPerBar };
		}
		const beat = Math.max(1, Math.min(beats, authorFocus.beatIdx));
		return {
			start: barStart + (beat - 1) * secondsPerBeat,
			end: barStart + beat * secondsPerBeat
		};
	}

	// Snap the currentTime playhead to the start of the current focus
	// (called after the user navigates focus with arrow keys).
	function syncPlayheadToFocus(): void {
		if (!tab) return;
		const { start } = authorFocusRange();
		currentTime = start;
	}

	// Right / Left arrow when NOT hovering a note: walk through
	// bar → beat 1 → beat 2 → ... → beat N → next bar's "bar" scope → ...
	function authorAdvanceFocus(dir: 1 | -1): void {
		if (!tab) return;
		const beats = tab.timeSignature[0];
		let { barIdx, beatIdx } = authorFocus;
		if (dir > 0) {
			if (beatIdx < beats) beatIdx += 1;
			else {
				barIdx += 1;
				beatIdx = 0;
			}
		} else {
			if (beatIdx > 0) beatIdx -= 1;
			else if (barIdx > 0) {
				barIdx -= 1;
				beatIdx = beats;
			}
		}
		authorFocus = { barIdx, beatIdx };
		syncPlayheadToFocus();
	}

	// Ctrl+Space in author mode — start playback from the current playhead
	// and run all the way to the end of the tab (no bar/beat auto-stop).
	// Useful for auditioning the whole piece against the reference video.
	// Shift+Space: play through like Ctrl+Space, but hear the selected
	// instrument stem instead of the reference (whose own audio is muted
	// meanwhile). Without a stem selected, it's the same as Ctrl+Space.
	let stemAudio: { key: string; url: string; el: HTMLAudioElement } | null = null;
	let stemPlaying = $state(false);

	function dropStemAudio() {
		if (!stemAudio) return;
		stemAudio.el.pause();
		URL.revokeObjectURL(stemAudio.url);
		stemAudio = null;
		stemPlaying = false;
	}

	async function authorPlayThroughStem() {
		if (!tab) return;
		const source = effectiveSource;
		if (playing || !isStem(source) || !stems) {
			authorPlayThrough();
			return;
		}
		let buffer: ArrayBuffer;
		try {
			buffer = await getStem(source);
		} catch {
			authorPlayThrough();
			return;
		}
		const key = `${stems.id}:${source}`;
		if (stemAudio?.key !== key) {
			dropStemAudio();
			const url = URL.createObjectURL(new Blob([buffer], { type: 'audio/ogg' }));
			stemAudio = { key, url, el: new Audio(url) };
		}
		const el = stemAudio!.el;
		setStemLevel(el);
		ChannelRouter.resume();
		el.currentTime = Math.max(0, currentTime + videoOffsetSec);
		stemPlaying = true;
		void el.play().catch(() => (stemPlaying = false));
		authorPlayThrough();
	}

	// Called every frame: keep the stem with the tab clock, and stop it
	// whenever playback stops (however that happens).
	function syncStem() {
		if (!stemPlaying || !stemAudio) return;
		const el = stemAudio.el;
		if (!playing) {
			el.pause();
			stemPlaying = false;
			return;
		}
		const target = Math.max(0, currentTime + videoOffsetSec);
		if (Math.abs(el.currentTime - target) > 0.3) el.currentTime = target;
		setStemLevel(el);
	}

	// Volume and channel (L / LR / R) for the stem's player.
	function setStemLevel(el: HTMLAudioElement) {
		const router = listenChannel !== 'both' ? ChannelRouter.for(el) : ChannelRouter.existing(el);
		if (router) {
			router.setChannel(listenChannel);
			router.setLevel(videoVolume);
		} else {
			el.volume = Math.max(0, Math.min(1, videoVolume));
		}
	}

	function authorPlayThrough(): void {
		if (!tab) return;
		if (playing) {
			playing = false;
			synth.stop();
			authorPlayStopAt = null;
			return;
		}
		authorPlayStopAt = null;
		playing = true;
		const start = currentTime;
		if (videoElement && videoUrl) {
			const target = Math.max(0, start + videoOffsetSec);
			if (Math.abs(videoElement.currentTime - target) > 0.05) {
				videoElement.currentTime = target;
			}
			void videoElement.play().catch(() => {});
			lastVideoPlayCommand = 'play';
		}
		if (audioOn) synth.play(tab, start);
	}

	// Author-mode Space handler. Plays the currently-focused range (bar or
	// beat). Second press while already playing stops immediately.
	function authorTogglePlay() {
		if (!tab) return;
		if (playing) {
			playing = false;
			synth.stop();
			authorPlayStopAt = null;
			return;
		}
		const { start, end } = authorFocusRange();
		// Jump the playhead to the start of the focused range so the audio
		// clock (and the video sync) all agree on where playback begins.
		currentTime = start;
		authorPlayStopAt = end;
		playing = true;
		if (videoElement && videoUrl) {
			const target = Math.max(0, start + videoOffsetSec);
			if (Math.abs(videoElement.currentTime - target) > 0.05) {
				videoElement.currentTime = target;
			}
			void videoElement.play().catch(() => {});
			lastVideoPlayCommand = 'play';
		}
		if (audioOn) synth.play(tab, start, end);
	}

	function togglePlay() {
		if (!tab) return;
		playing = !playing;
		if (playing) {
			// Prime the video: explicit position + play in the same tick as audio.
			// If we let syncVideo do this on the next rAF, the video is ~16ms behind
			// and any drift correction fires an instant seek right as audio starts,
			// which looks like stutter.
			if (videoElement && videoUrl) {
				const target = Math.max(0, currentTime + videoOffsetSec);
				if (Math.abs(videoElement.currentTime - target) > 0.05) {
					videoElement.currentTime = target;
				}
				videoElement.play().catch(() => {});
			}
			if (audioOn) synth.play(tab, currentTime);
			lastVideoPlayCommand = 'play';
		} else {
			synth.stop();
			if (videoElement) videoElement.pause();
			lastVideoPlayCommand = 'pause';
		}
	}

	function reset() {
		currentTime = 0;
		playing = false;
		synth.stop();
	}

	// Any change to currentTime while playing (scrubbing) reseeds the audio from
	// the new position. Tracker is a plain variable, not $state.
	let lastSeekTime = 0;
	$effect(() => {
		if (!playing || !tab) {
			lastSeekTime = currentTime;
			return;
		}
		// Only reseed if the user actually moved the slider (not just rAF ticks).
		if (Math.abs(currentTime - lastSeekTime) > 0.15) {
			if (audioOn) synthRestart(currentTime);
			else synth.stop();
			lastSeekTime = currentTime;
		}
	});

	// Restart synth playback from `t` mid-play (after a scrub, metronome
	// toggle, etc.). Keeps the author-mode focus bound so an in-progress
	// bar/beat preview doesn't start leaking notes past its end.
	function synthRestart(t: number) {
		if (!tab) return;
		synth.play(tab, t, authorPlayStopAt ?? undefined);
	}

	function seekBy(deltaSec: number) {
		if (!tab) return;
		const next = Math.max(0, Math.min(effectiveDurationSec, currentTime + deltaSec));
		currentTime = next;
		lastSeekTime = next;
		if (playing && audioOn) synthRestart(next);
	}

	// Convert a pointer event's page coords to (time, stringIndex) using the
	// same layout math the renderer uses. Handles both page and scroll modes.
	function pointerToTabPos(ev: {
		clientX: number;
		clientY: number;
	}): { time: number; stringIndex: number } | null {
		if (!tab) return null;
		const rect = canvas.getBoundingClientRect();
		// Renderer works in CSS-pixel logical coords; use rect.width/height (CSS
		// pixels), not canvas.width/height which are now device pixels.
		const cx = ev.clientX - rect.left;
		const cy = ev.clientY - rect.top;
		const cfg = DEFAULT_RENDER_CONFIG;
		const cssW = rect.width;
		const cssH = rect.height;
		const usableHeight = cssH - cfg.paddingTop - cfg.paddingBottom;
		const stringGap = usableHeight / (STRING_COUNT - 1);
		const stringIndex = Math.max(
			0,
			Math.min(STRING_COUNT - 1, Math.round((cy - cfg.paddingTop) / stringGap))
		);
		let time: number;
		if (renderMode === 'page') {
			const pageDur = tab.secondsPerBar * barsPerPage;
			const secondsPerBeat = tab.secondsPerBar / tab.timeSignature[0];
			const peekDur = peekBeats * secondsPerBeat;
			const totalDur = pageDur + peekDur;
			const usableWidth = cssW - cfg.paddingX * 2;
			const pxPerSec = usableWidth / totalDur;
			const pageIndex = Math.floor(currentTime / pageDur);
			const pageStart = pageIndex * pageDur;
			time = pageStart + (cx - cfg.paddingX) / pxPerSec;
		} else {
			const usableWidth = cssW - cfg.paddingX * 2;
			const totalDur =
				barsPerPage * tab.secondsPerBar + peekBeats * (tab.secondsPerBar / tab.timeSignature[0]);
			const pxPerSec = totalDur > 0 ? usableWidth / totalDur : pixelsPerSecond;
			const playheadX = cssW * cfg.playheadFraction;
			time = currentTime + (cx - playheadX) / pxPerSec;
		}
		return { time, stringIndex };
	}

	function findNearestNote(pos: { time: number; stringIndex: number }): Tab['notes'][0] | null {
		if (!tab) return null;
		// Match on same string within a small time window; pick the closest.
		const TIME_TOL = 0.15;
		let closest: Tab['notes'][0] | null = null;
		let bestDt = Infinity;
		for (const n of tab.notes) {
			if (n.stringIndex !== pos.stringIndex) continue;
			const dt = Math.abs(n.time - pos.time);
			if (dt > TIME_TOL) continue;
			if (dt < bestDt) {
				bestDt = dt;
				closest = n;
			}
		}
		return closest;
	}

	// Return the two notes on the same string flanking `clickTime` — the last
	// note at or before, and the first note strictly after. Both must exist for
	// a hammer/pull annotation to make sense (there needs to be a source note).
	function findFlankingNotes(pos: { time: number; stringIndex: number }): {
		prev: Tab['notes'][0];
		next: Tab['notes'][0];
	} | null {
		if (!tab) return null;
		let prev: Tab['notes'][0] | null = null;
		let next: Tab['notes'][0] | null = null;
		for (const n of tab.notes) {
			if (n.stringIndex !== pos.stringIndex) continue;
			if (n.time <= pos.time) prev = n;
			else {
				next = n;
				break;
			}
		}
		return prev && next ? { prev, next } : null;
	}

	let dragging: { note: Tab['notes'][0] } | null = null;

	function toggleAnnotation(key: string, desired: 'hammer' | 'pull' | 'tap' | 'off'): void {
		const current = annotations[key];
		if (current === desired) {
			const { [key]: _, ...rest } = annotations;
			annotations = rest;
		} else {
			annotations = { ...annotations, [key]: desired };
		}
	}

	// ---- Authoring-mode canvas interactions ----------------------------------

	function snapTime(t: number): number {
		if (!tab) return t;
		// gridStep is the "denominator" (16 = sixteenth). Interval in seconds
		// = whole-note duration / gridStep = (240 / bpm) / gridStep.
		const step = 240 / tab.bpm / gridStep;
		return Math.max(0, Math.round(t / step) * step);
	}

	// Starting fret when you hover / click an empty spot. With "reuse fret" on
	// (toggle: the key left of 1, or the toolbar button) it's the last note on
	// that string, so walking a run of notes on one string is one click each.
	// Otherwise — or with no earlier note — the tool's own default: fret 0,
	// or 12 for sweeps (they're mostly barre-like; from fret 0 they turn into
	// odd open-string shapes).
	const SWEEP_START_FRET = 12;

	// The hover fret depends on the tool and on "reuse fret", so refresh it
	// when either changes, not only when the mouse moves.
	$effect(() => {
		void currentTool;
		void reuseLastFret;
		untrack(() => {
			if (!hoverPos || !tab) return;
			const existing = findAuthorNoteAt(hoverPos);
			hoverFret = existing
				? existing.fret
				: defaultFretForString(hoverPos.stringIndex, hoverPos.time);
		});
	});

	function defaultFretForString(stringIndex: number, atTime: number): number {
		const base = currentTool === 6 ? SWEEP_START_FRET : 0;
		if (!tab || !reuseLastFret) return base;
		let best: TabNote | null = null;
		for (const n of tab.notes) {
			if (n.stringIndex !== stringIndex) continue;
			if (n.time >= atTime - 1e-6) break;
			best = n;
		}
		return best ? best.fret : base;
	}

	// Nearest existing note within a small time+string tolerance. Used to
	// hit-test clicks against notes for edit/delete/move gestures.
	//
	// Tolerance = ½ grid step so we never mis-hit an adjacent grid position.
	// At 120 BPM with gridStep=16 that's 0.0625 s — well inside the 0.125 s
	// gap between 16ths, so you can freely click any 1/2/3/4 subdivision
	// within a beat without the click snapping to the previous note.
	function findAuthorNoteAt(pos: { time: number; stringIndex: number }): TabNote | null {
		if (!tab) return null;
		const step = 240 / tab.bpm / gridStep;
		const timeTol = step / 2;
		let best: TabNote | null = null;
		let bestDt = Infinity;
		for (const n of tab.notes) {
			if (n.stringIndex !== pos.stringIndex) continue;
			const dt = Math.abs(n.time - pos.time);
			if (dt <= timeTol && dt < bestDt) {
				best = n;
				bestDt = dt;
			}
		}
		return best;
	}

	// The note nearest in time to `pos` on any string (within half a grid
	// step): M acts on the whole moment, so any spot in its column will do.
	function findColumnNoteAt(pos: { time: number; stringIndex: number }): TabNote | null {
		if (!tab) return null;
		const onString = findAuthorNoteAt(pos);
		if (onString) return onString;
		const timeTol = 240 / tab.bpm / gridStep / 2;
		let best: TabNote | null = null;
		let bestDt = Infinity;
		for (const n of tab.notes) {
			const dt = Math.abs(n.time - pos.time);
			if (dt <= timeTol && dt < bestDt) {
				best = n;
				bestDt = dt;
			}
		}
		return best;
	}

	// Holding M (palm mute) or R (let ring) and moving paints it over every
	// moment the pointer passes (or clears it — the first moment decides
	// which); released, it's one undo step. A tap toggles just the one
	// moment. The first moment is heard as soon as the key goes down.
	const MOMENT_KEYS = { m: 'palmMute', r: 'letRing' } as const;
	let pmPaint = $state<{
		kind: 'palmMute' | 'letRing';
		on: boolean;
		times: number[];
		code: string;
		lastX: number;
		lastY: number;
	} | null>(null);

	function pmPaintAdd(clientX: number, clientY: number) {
		const p = pmPaint;
		if (!p) return;
		const times = new Set(p.times);
		const steps = Math.max(1, Math.ceil(Math.hypot(clientX - p.lastX, clientY - p.lastY) / 4));
		for (let i = 1; i <= steps; i++) {
			const t = i / steps;
			const pos = pointerToTabPos({
				clientX: p.lastX + (clientX - p.lastX) * t,
				clientY: p.lastY + (clientY - p.lastY) * t
			});
			const hit = pos ? findColumnNoteAt(pos) : null;
			if (hit) times.add(hit.time);
		}
		pmPaint = { ...p, times: [...times], lastX: clientX, lastY: clientY };
	}

	// The notes the paint would change, and their new articulations.
	function pmPaintChanges(): Array<{ id: string; arts: Articulation[] }> {
		const p = pmPaint;
		if (!p || !tab) return [];
		const changes: Array<{ id: string; arts: Articulation[] }> = [];
		for (const t of p.times) {
			for (const n of stackAt(t)) {
				const has = n.articulations.some((a) => a.kind === p.kind);
				if (has === p.on) continue;
				const rest = withoutArts(n.articulations, p.kind);
				changes.push({ id: n.id, arts: p.on ? [...rest, { kind: p.kind }] : rest });
			}
		}
		return changes;
	}

	function startPmPaint(key: 'm' | 'r', hit: TabNote, code: string) {
		const kind = MOMENT_KEYS[key];
		pmPaint = {
			kind,
			on: !hit.articulations.some((a) => a.kind === kind),
			times: [hit.time],
			code,
			lastX: lastPointerClient.x,
			lastY: lastPointerClient.y
		};
		// Heard right away, as it will sound.
		const arts = new Map(pmPaintChanges().map((c) => [c.id, c.arts]));
		auditionNotes(
			stackAt(hit.time).map((n) => ({ ...n, articulations: arts.get(n.id) ?? n.articulations }))
		);
	}

	function endPmPaint() {
		const p = pmPaint;
		if (!p) return;
		const changes = pmPaintChanges();
		pmPaint = null;
		if (changes.length === 0 || !tab) return;
		const name = p.kind === 'palmMute' ? 'palm mute' : 'let ring';
		commitEdit(
			batchCommand(
				`${p.on ? 'Add' : 'Remove'} ${name}`,
				changes.map((c) => cmdUpdateNote(c.id, { articulations: c.arts }))
			)
		);
	}

	function noteDefaultDuration(palmMute: boolean): number {
		if (!tab) return 0.5;
		const oneBeat = tab.secondsPerBar / tab.timeSignature[0];
		// PM notes get half a beat (an 1/8 note) so the dashed marker in
		// notation doesn't extend across a whole beat's worth of empty tab,
		// and the visual duration lines up with the plucked-and-damped
		// sound. Normal notes get a whole beat as before.
		if (palmMute) return oneBeat / 2;
		return oneBeat;
	}

	function onAuthorPointerDown(ev: PointerEvent) {
		if (!tab || artHold || pmPaint) return;
		const pos = pointerToTabPos(ev);
		if (!pos) return;

		// Middle button erases the note under the cursor, and keeps erasing
		// whatever it passes over while held.
		if (ev.button === 1) {
			const hit = findAuthorNoteAt(pos);
			authorGesture = {
				kind: 'erase',
				ids: hit ? [hit.id] : [],
				lastX: ev.clientX,
				lastY: ev.clientY
			};
			canvas.setPointerCapture(ev.pointerId);
			ev.preventDefault();
			return;
		}
		if (ev.button !== 0) return;

		// Any new gesture starts with an "unheard" preview slot.
		lastPreviewKey = null;

		const hit = findAuthorNoteAt(pos);
		// Modifier gestures on existing notes:
		//   Shift  = move-free    (drag anywhere, keep FRET; pitch changes)
		//   Alt    = move-fingering (drag to another string, keep MIDI pitch)
		//   Ctrl   = copy         (like move-free but leaves original in place)
		if (hit && (ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey)) {
			const base = {
				initialStringIndex: hit.stringIndex,
				initialTime: hit.time,
				currentStringIndex: hit.stringIndex,
				currentTime: hit.time,
				startX: ev.clientX,
				startY: ev.clientY
			};
			if (ev.altKey) {
				authorGesture = { kind: 'move-fingering', noteId: hit.id, midi: hit.midi, ...base };
			} else if (ev.ctrlKey || ev.metaKey) {
				authorGesture = { kind: 'copy', sourceId: hit.id, fret: hit.fret, ...base };
			} else {
				authorGesture = { kind: 'move-free', noteId: hit.id, fret: hit.fret, ...base };
			}
			canvas.setPointerCapture(ev.pointerId);
			ev.preventDefault();
			previewPlacePitch();
			return;
		}
		// Only an arpeggio's FIRST note grabs it; clicking any other note in
		// the arp tool starts a new arpeggio there instead (e.g. over a loop's
		// last note spilling into the next bar), replacing that note.
		const run = isSequenceTool() && hit ? arpStartingAt(hit) : null;
		if (run) {
			// Arp tool on an arpeggio: drag moves the whole arpeggio.
			const voicing = runVoicing(run);
			authorGesture = {
				kind: 'edit-arp',
				noteId: hit!.id,
				run: run.map((n) => ({
					id: n.id,
					time: n.time,
					stringIndex: n.stringIndex,
					fret: n.fret
				})),
				bassString: voicing[0].stringIndex,
				initialFret: voicing[0].fret,
				currentFret: voicing[0].fret,
				startX: ev.clientX,
				startY: ev.clientY,
				// A sweep just moves as a block (its shapes are all movable).
				chord: currentTool === 6 ? null : identifyVoicing(voicing)
			};
			canvas.setPointerCapture(ev.pointerId);
			ev.preventDefault();
			previewPlacePitch();
			return;
		}
		if (hit && !isSequenceTool()) {
			// Edit existing note's fret via drag.
			const group = powerChordGroupFor(hit);
			authorGesture = {
				kind: 'edit',
				noteId: hit.id,
				stringIndex: hit.stringIndex,
				initialFret: hit.fret,
				currentFret: hit.fret,
				startX: ev.clientX,
				startY: ev.clientY,
				group,
				chord: currentTool === 4 && group.length > 0 ? identifyChord(hit, group) : null
			};
			canvas.setPointerCapture(ev.pointerId);
			ev.preventDefault();
			previewPlacePitch();
			return;
		}

		// Empty area (or, in the arp tool, a note that isn't an arpeggio's
		// first) → start placement drag, from the fret shown under the pointer.
		const snappedTime = snapTime(pos.time);
		const startingFret = hit ? hit.fret : defaultFretForString(pos.stringIndex, snappedTime);
		authorGesture = {
			kind: 'place',
			stringIndex: pos.stringIndex,
			time: snappedTime,
			initialFret: startingFret,
			currentFret: startingFret,
			startX: ev.clientX,
			startY: ev.clientY,
			anchorFret: startingFret
		};
		canvas.setPointerCapture(ev.pointerId);
		ev.preventDefault();
		// Audition the initial pitch immediately so the user hears the
		// note that would be committed on release. Preview updates as
		// they drag to a different fret via onAuthorPointerMove.
		previewPlacePitch();
	}

	// Preview whichever pitch(es) the current 'place' or 'edit' gesture is
	// about to commit — one voice per note in the power-chord stack, so
	// even the higher voicings can be heard while dragging.
	function previewPlacePitch(): void {
		if (!tab || !authorGesture) return;
		const tuning = TUNINGS[tuningKey];
		if (authorGesture.kind === 'place') {
			const g = authorGesture;
			const placed = placementNotes(g);
			const artsAt = (time: number) => placementArts(time);
			const key =
				'place:' +
				placed
					.map(
						(s) =>
							`${s.time.toFixed(4)},${s.stringIndex},${s.fret}` +
							(artsAt(s.time).some((a) => a.kind === 'palmMute') ? 'pm' : '')
					)
					.join('|');
			if (key === lastPreviewKey) return;
			lastPreviewKey = key;
			if (!audioOn) return;
			// Root-heavy velocity balance so the fundamental still cuts
			// through the sawtooth harmonics of the upper voicings. (An
			// arpeggio's notes are even.)
			const n = placed.length;
			const vels = isSequenceTool()
				? []
				: n === 3
					? [0.9, 0.8, 0.72]
					: n === 2
						? [0.9, 0.8]
						: [0.85];
			const times = placed.map((s) => s.time);
			synth.previewNote(
				placed.map((s, i) => {
					const arts = artsAt(s.time);
					return {
						id: 'preview',
						time: s.time - g.time,
						// Arpeggio notes stop as the next one starts.
						duration: Math.min(previewDuration(arts), untilNext(s.time, times)),
						stringIndex: s.stringIndex,
						fret: s.fret,
						midi: tuning.openNotes[s.stringIndex] + s.fret,
						velocity: vels[i] ?? 0.8,
						channel: 0,
						articulations: s.art ? [...arts, { kind: s.art } as Articulation] : [...arts]
					};
				})
			);
		} else if (authorGesture.kind === 'edit-arp') {
			// Play the moved arpeggio through, each note up to the next.
			const g = authorGesture;
			const key = `edit-arp:${g.noteId}:${g.currentFret}`;
			if (key === lastPreviewKey) return;
			lastPreviewKey = key;
			if (!audioOn) return;
			const targets = arpEditTargets(g);
			const t0 = targets[0].time;
			const times = targets.map((n) => n.time);
			synth.previewNote(
				targets.map((n) => {
					const arts = $state.snapshot(noteArtsById(n.id));
					return {
						id: 'preview',
						time: n.time - t0,
						duration: Math.min(previewDuration(arts), untilNext(n.time, times)),
						stringIndex: n.stringIndex,
						fret: n.fret,
						midi: tuning.openNotes[n.stringIndex] + n.fret,
						velocity: 0.8,
						channel: 0,
						articulations: arts
					};
				})
			);
		} else if (authorGesture.kind === 'edit' && authorGesture.group.length > 0) {
			// Shape drag: audition the whole power chord at its new position.
			const g = authorGesture;
			const delta = g.currentFret - g.initialFret;
			const key = `edit-shape:${g.noteId}:${delta}`;
			if (key === lastPreviewKey) return;
			lastPreviewKey = key;
			if (!audioOn) return;
			const rootArts = noteArtsById(g.noteId);
			const members = [
				{ stringIndex: g.stringIndex, fret: g.currentFret, arts: rootArts },
				...editTargets(g).members.map((m) => ({
					stringIndex: m.stringIndex,
					fret: m.fret,
					arts: m.id ? noteArtsById(m.id) : rootArts
				}))
			];
			synth.previewNote(
				members.map((m, i) => ({
					id: 'preview',
					time: 0,
					duration: previewDuration(m.arts),
					stringIndex: m.stringIndex,
					fret: m.fret,
					midi: tuning.openNotes[m.stringIndex] + m.fret,
					velocity: i === 0 ? 0.9 : 0.78,
					channel: 0,
					articulations: $state.snapshot(m.arts)
				}))
			);
		} else if (authorGesture.kind === 'edit') {
			const midi = tuning.openNotes[authorGesture.stringIndex] + authorGesture.currentFret;
			previewIfChanged(
				`edit:${authorGesture.noteId}:${authorGesture.currentFret}`,
				midi,
				authorGesture.stringIndex,
				authorGesture.currentFret,
				noteArtsById(authorGesture.noteId)
			);
		} else if (authorGesture.kind === 'move-free' || authorGesture.kind === 'copy') {
			const midi = tuning.openNotes[authorGesture.currentStringIndex] + authorGesture.fret;
			previewIfChanged(
				`mv:${authorGesture.currentStringIndex},${authorGesture.fret}`,
				midi,
				authorGesture.currentStringIndex,
				authorGesture.fret,
				noteArtsById(authorGesture.kind === 'copy' ? authorGesture.sourceId : authorGesture.noteId)
			);
		} else if (authorGesture.kind === 'move-fingering') {
			const newFret = authorGesture.midi - tuning.openNotes[authorGesture.currentStringIndex];
			if (newFret < 0 || newFret > MAX_FRET) return;
			previewIfChanged(
				`mvf:${authorGesture.currentStringIndex},${newFret}`,
				authorGesture.midi,
				authorGesture.currentStringIndex,
				newFret,
				noteArtsById(authorGesture.noteId)
			);
		}
	}

	function noteArtsById(id: string): Articulation[] {
		return tab?.notes.find((n) => n.id === id)?.articulations ?? [];
	}

	function onAuthorPointerMove(ev: PointerEvent) {
		if (!tab) return;
		lastPointerClient = { x: ev.clientX, y: ev.clientY };
		if (artHold) {
			// Holding B/S/V: the mouse adjusts the articulation, and the hover
			// target stays locked to the note the key was pressed on.
			updateArtHold(ev.clientX, ev.clientY, pointerToTabPos(ev)?.time ?? null);
			return;
		}
		// Painting palm mute (M held); the hover still follows the pointer.
		if (pmPaint) pmPaintAdd(ev.clientX, ev.clientY);
		if (!authorGesture) {
			// Not dragging → update hover ghost. If we're hovering directly
			// over an existing note, echo that note's fret (so the ghost
			// preview matches what's under the cursor); otherwise fall back
			// to the "reuse previous note on this string" convenience.
			const pos = pointerToTabPos(ev);
			if (!pos) {
				hoverPos = null;
				return;
			}
			const snapped = snapTime(pos.time);
			hoverPos = { time: snapped, stringIndex: pos.stringIndex };
			const existing = findAuthorNoteAt({ time: snapped, stringIndex: pos.stringIndex });
			hoverFret = existing ? existing.fret : defaultFretForString(pos.stringIndex, snapped);
			return;
		}
		if (authorGesture.kind === 'erase') {
			// Sample the path since the last event every few pixels so a
			// fast swipe can't jump over a note between two events.
			const g = authorGesture;
			const ids = new Set(g.ids);
			const dist = Math.hypot(ev.clientX - g.lastX, ev.clientY - g.lastY);
			const steps = Math.max(1, Math.ceil(dist / 4));
			for (let i = 1; i <= steps; i++) {
				const t = i / steps;
				const pos = pointerToTabPos({
					clientX: g.lastX + (ev.clientX - g.lastX) * t,
					clientY: g.lastY + (ev.clientY - g.lastY) * t
				});
				const hit = pos ? findAuthorNoteAt(pos) : null;
				if (hit) ids.add(hit.id);
			}
			authorGesture = { ...g, ids: [...ids], lastX: ev.clientX, lastY: ev.clientY };
			return;
		}
		const dx = ev.clientX - authorGesture.startX;
		const dy = ev.clientY - authorGesture.startY;
		if (
			authorGesture.kind === 'move-fingering' ||
			authorGesture.kind === 'move-free' ||
			authorGesture.kind === 'copy'
		) {
			// All three "reposition" gestures share the same pointer-tracking:
			// string index comes from the pointer's y, time comes from the
			// snapped x. They differ only in what they commit on release.
			const pos = pointerToTabPos(ev);
			if (!pos) return;
			authorGesture = {
				...authorGesture,
				currentStringIndex: pos.stringIndex,
				currentTime: snapTime(pos.time)
			};
			previewPlacePitch();
			return;
		}
		const fretDelta = Math.round(dx / PX_PER_FRET);
		// Up is a decreasing dy, and up should INCREASE octave → invert.
		const octaveDelta = Math.round(-dy / PX_PER_OCTAVE);
		const raw = authorGesture.initialFret + fretDelta + octaveDelta * 12;
		let currentFret = Math.max(0, Math.min(MAX_FRET, raw));
		if (authorGesture.kind === 'edit' && authorGesture.group.length > 0 && !authorGesture.chord) {
			// Shape drag: clamp the shared delta so every note in the shape
			// stays within 0..MAX_FRET (the shape never gets squashed).
			// (A recognised chord is re-voiced instead, so only its root is
			// clamped — by the plain 0..MAX_FRET above.)
			const inits = [authorGesture.initialFret, ...authorGesture.group.map((m) => m.initialFret)];
			const minDelta = -Math.min(...inits);
			const maxDelta = MAX_FRET - Math.max(...inits);
			const delta = Math.max(minDelta, Math.min(maxDelta, raw - authorGesture.initialFret));
			currentFret = authorGesture.initialFret + delta;
		}
		if (authorGesture.kind === 'edit-arp' && !authorGesture.chord) {
			// Unrecognised arpeggio: it only shifts, so keep every note on
			// the fretboard.
			const frets = authorGesture.run.map((n) => n.fret);
			const minDelta = -Math.min(...frets);
			const maxDelta = MAX_FRET - Math.max(...frets);
			const delta = Math.max(minDelta, Math.min(maxDelta, raw - authorGesture.initialFret));
			currentFret = authorGesture.initialFret + delta;
		}
		authorGesture = { ...authorGesture, currentFret };
		previewPlacePitch();
	}

	function onAuthorPointerUp(ev: PointerEvent) {
		if (!tab || !authorGesture) return;
		try {
			canvas.releasePointerCapture(ev.pointerId);
		} catch {
			// noop
		}
		// Kill any in-flight preview immediately on release so the note
		// doesn't keep ringing after the user commits (or gives up on) a
		// placement.
		synth.stopPreview();
		lastPreviewKey = null;
		const g = authorGesture;
		authorGesture = null;

		if (g.kind === 'erase') {
			if (g.ids.length > 0) {
				commitEdit(
					batchCommand(
						g.ids.length > 1 ? `Delete ${g.ids.length} notes` : 'Delete note',
						g.ids.map((id) => cmdRemoveNote(id))
					)
				);
			}
			return;
		}
		if (g.kind === 'place') {
			const { notes, displaced } = buildPlacement(g);
			const end = Math.max(...notes.map((n) => n.time + n.duration));
			const extend = extendDurationTo(tab, end);
			commitEdit(
				batchCommand(
					currentTool === 5
						? 'Place arpeggio'
						: currentTool === 6
							? 'Place sweep'
							: notes.length > 1
								? 'Place chord'
								: 'Place note',
					[
						...(extend ? [extend] : []),
						...displaced.map((n) => cmdRemoveNote(n.id)),
						...notes.map((n) => cmdAddNote(n))
					]
				)
			);
			// The mouse-down preview is cut on release; play a placed
			// arpeggio through once so it can be heard in full.
			if (isSequenceTool()) {
				const ids = new Set(notes.map((n) => n.id));
				auditionNotes(tab.notes.filter((n) => ids.has(n.id)));
			}
			return;
		}
		if (g.kind === 'edit-arp') {
			if (g.currentFret === g.initialFret) {
				// A click (no drag) on an arpeggio note in PM variant toggles
				// palm mute on that note's time position, as elsewhere.
				if (toolVariant === 'palmMute') {
					const note = tab.notes.find((n) => n.id === g.noteId);
					if (note) toggleArticulationKey('m', note);
				}
				return;
			}
			const tuning = TUNINGS[tuningKey];
			// Each time holds only this arpeggio's note, so nothing else is
			// displaced by a note changing string.
			commitEdit(
				batchCommand(
					'Move arpeggio',
					arpEditTargets(g).map((n) =>
						cmdUpdateNote(n.id, {
							stringIndex: n.stringIndex,
							fret: n.fret,
							midi: tuning.openNotes[n.stringIndex] + n.fret
						})
					)
				)
			);
			return;
		}
		if (g.kind === 'edit') {
			// Zero-drag click on an existing note.
			if (g.currentFret === g.initialFret) {
				// In palm-mute variant, click toggles palm mute on every note
				// at that time (same as the M key).
				if (toolVariant === 'palmMute') {
					const note = tab.notes.find((n) => n.id === g.noteId);
					if (note) toggleArticulationKey('m', note);
				}
				return;
			}
			const tuning = TUNINGS[tuningKey];
			const targets = editTargets(g);
			if (targets.replace) {
				// Re-voiced chord: move the root, swap the rest for the new voicing.
				const root = tab.notes.find((n) => n.id === g.noteId);
				if (!root) return;
				commitEdit(
					batchCommand('Move chord', [
						cmdUpdateNote(g.noteId, {
							fret: g.currentFret,
							midi: tuning.openNotes[g.stringIndex] + g.currentFret
						}),
						...g.group.map((m) => cmdRemoveNote(m.id)),
						...chordMemberNotes(root, targets.members).map((n) => cmdAddNote(n))
					])
				);
				return;
			}
			const updates = [
				{ id: g.noteId, stringIndex: g.stringIndex, fret: g.currentFret },
				...targets.members.map((m) => ({
					id: m.id!,
					stringIndex: m.stringIndex,
					fret: m.fret
				}))
			];
			commitEdit(
				batchCommand(
					updates.length > 1 ? 'Move chord shape' : 'Edit note',
					updates.map((u) =>
						cmdUpdateNote(u.id, { fret: u.fret, midi: tuning.openNotes[u.stringIndex] + u.fret })
					)
				)
			);
			return;
		}
		if (g.kind === 'move-fingering') {
			// Preserve MIDI pitch, recompute fret for the target string.
			const tuning = TUNINGS[tuningKey];
			const newFret = g.midi - tuning.openNotes[g.currentStringIndex];
			if (newFret < 0 || newFret > MAX_FRET) return;
			if (
				g.currentStringIndex === g.initialStringIndex &&
				Math.abs(g.currentTime - g.initialTime) < 1e-6
			)
				return;
			const displaced = notesDisplacedBy(
				g.currentTime,
				[g.currentStringIndex],
				new Set([g.noteId])
			);
			commitEdit(
				batchCommand('Move note', [
					...displaced.map((n) => cmdRemoveNote(n.id)),
					cmdUpdateNote(g.noteId, {
						stringIndex: g.currentStringIndex,
						fret: newFret,
						time: g.currentTime,
						articulations: movedArts(g.noteId, g.currentTime, displaced)
					})
				])
			);
			return;
		}
		if (g.kind === 'move-free') {
			// Keep the fret number, recompute MIDI for the target string.
			// This is the "just drag the note" case — pitch changes because
			// the fret is played on a different string.
			const tuning = TUNINGS[tuningKey];
			if (
				g.currentStringIndex === g.initialStringIndex &&
				Math.abs(g.currentTime - g.initialTime) < 1e-6
			)
				return;
			const midi = tuning.openNotes[g.currentStringIndex] + g.fret;
			const displaced = notesDisplacedBy(
				g.currentTime,
				[g.currentStringIndex],
				new Set([g.noteId])
			);
			commitEdit(
				batchCommand('Move note', [
					...displaced.map((n) => cmdRemoveNote(n.id)),
					cmdUpdateNote(g.noteId, {
						stringIndex: g.currentStringIndex,
						time: g.currentTime,
						midi,
						articulations: movedArts(g.noteId, g.currentTime, displaced)
					})
				])
			);
			return;
		}
		if (g.kind === 'copy') {
			// Ctrl+drag: duplicate the source note at the drop location.
			// Original stays put. New note gets its own id.
			const src = tab.notes.find((n) => n.id === g.sourceId);
			if (!src) return;
			if (
				g.currentStringIndex === g.initialStringIndex &&
				Math.abs(g.currentTime - g.initialTime) < 1e-6
			)
				return;
			const displaced = notesDisplacedBy(g.currentTime, [g.currentStringIndex]);
			const tuning = TUNINGS[tuningKey];
			const copy: TabNote = {
				...src,
				id: newNoteId(),
				stringIndex: g.currentStringIndex,
				time: g.currentTime,
				midi: tuning.openNotes[g.currentStringIndex] + g.fret,
				articulations: adoptStackState(
					shiftTimedArticulations([...src.articulations], g.currentTime - src.time),
					g.currentTime,
					new Set(displaced.map((n) => n.id))
				)
			};
			const extend = extendDurationTo(tab, copy.time + copy.duration);
			commitEdit(
				batchCommand('Copy note', [
					...(extend ? [extend] : []),
					...displaced.map((n) => cmdRemoveNote(n.id)),
					cmdAddNote(copy)
				])
			);
			return;
		}
	}

	// Articulations for a note being moved to `time`: time-based ranges (vibrato)
	// shift with it, and it takes on the PM / let-ring state of the stack it
	// lands in.
	// `displaced` are notes the move replaces; they don't count as the stack.
	function movedArts(id: string, time: number, displaced: TabNote[] = []): Articulation[] {
		const note = tab?.notes.find((n) => n.id === id);
		if (!note) return [];
		return adoptStackState(
			shiftTimedArticulations([...note.articulations], time - note.time),
			time,
			new Set([id, ...displaced.map((n) => n.id)])
		);
	}

	function onAuthorPointerLeave() {
		hoverPos = null;
	}

	// ---- Hover-key articulations ----------------------------------------------
	// Keys act on the note under the pointer, no selection needed.
	//   Toggle keys: M palm mute, R let ring (both: every note at that time),
	//   G ghost, H hammer/pull (direction from the previous note on the
	//   string), T tap.
	//   Hold keys: B bend, S slide, V vibrato, N harmonic. Tapping toggles
	//   (adding uses the last value you set); holding the key and moving the
	//   mouse adjusts it, and release commits one undo step.

	type HoldArtKey = 'b' | 's' | 'v' | 'n';
	type ArtHold = {
		key: HoldArtKey;
		// Physical key (e.code) that started the hold; keyup matches on it.
		code: string;
		noteId: string;
		before: Articulation[];
		startX: number;
		startY: number;
		moved: boolean;
		// Starting amount for relative drags: bend semitones (B), slide
		// origin offset in frets (S, negative = slide up from below), or
		// index into harmonicChoices (N).
		base: number;
		baseRelease: boolean;
		lastAuditionKey: string;
	};
	let artHold: ArtHold | null = null;
	let lastPointerClient = { x: 0, y: 0 };
	const PX_PER_SEMITONE = 24;
	const ART_MOVE_THRESHOLD = 6;

	// Last bend / slide / pinch-harmonic values the user set, so tapping the
	// key on the next note repeats them. Persisted across reloads.
	type ArtMemory = {
		bend: { semitones: number; release: boolean };
		slideOffset: number;
		pinchInterval: number;
	};
	const ART_MEMORY_KEY = 'tabutabu.artMemory';
	let artMemory: ArtMemory = loadArtMemory();
	function loadArtMemory(): ArtMemory {
		const fallback: ArtMemory = {
			bend: { semitones: 2, release: false },
			slideOffset: -2,
			pinchInterval: 12
		};
		try {
			const raw = typeof localStorage !== 'undefined' && localStorage.getItem(ART_MEMORY_KEY);
			return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
		} catch {
			return fallback;
		}
	}
	function saveArtMemory() {
		try {
			localStorage.setItem(ART_MEMORY_KEY, JSON.stringify(artMemory));
		} catch {
			// storage full or blocked
		}
	}

	const withoutArts = (arts: Articulation[], ...kinds: Articulation['kind'][]) =>
		arts.filter((a) => !kinds.includes(a.kind));

	// Palm mute and let ring are notated as a line above the staff, so they
	// belong to a time position, not a single string: every note sounding at
	// the same time shares them.
	function stackAt(time: number, exclude?: Set<string>): TabNote[] {
		if (!tab) return [];
		return tab.notes.filter((n) => Math.abs(n.time - time) < 1e-4 && !exclude?.has(n.id));
	}

	// Articulations for a note joining the stack at `time`: palm mute / let
	// ring copied from the notes already there. With no stack, `arts` is
	// returned unchanged.
	function adoptStackState(arts: Articulation[], time: number, exclude?: Set<string>) {
		const stack = stackAt(time, exclude);
		if (stack.length === 0) return arts;
		const pm = stack.some((n) => n.articulations.some((a) => a.kind === 'palmMute'));
		const lr = stack.some((n) => n.articulations.some((a) => a.kind === 'letRing'));
		const rest = withoutArts(arts, 'palmMute', 'letRing');
		if (pm) rest.push({ kind: 'palmMute' });
		if (lr) rest.push({ kind: 'letRing' });
		return rest;
	}

	// What a new placement at `time` gets: the tool variant, unless it joins
	// an existing stack, whose state wins.
	function placementArts(time: number, exclude?: Set<string>): Articulation[] {
		const base: Articulation[] = toolVariant === 'palmMute' ? [{ kind: 'palmMute' }] : [];
		return adoptStackState(base, time, exclude);
	}

	// Notes already sounding at `time` on any of `strings` — a string can
	// only play one note at a time, so new notes landing there replace them.
	// `keep` excludes the notes being moved themselves.
	function notesDisplacedBy(time: number, strings: number[], keep?: Set<string>): TabNote[] {
		const set = new Set(strings);
		return stackAt(time).filter((n) => set.has(n.stringIndex) && !keep?.has(n.id));
	}

	function prevNoteOnString(note: TabNote): TabNote | null {
		if (!tab) return null;
		let prev: TabNote | null = null;
		for (const n of tab.notes) {
			if (n.time >= note.time - 1e-6) break;
			if (n.stringIndex === note.stringIndex) prev = n;
		}
		return prev;
	}

	// Plays the notes as they sit relative to each other: a chord together,
	// an arpeggio in sequence with each note stopping as the next starts.
	function auditionNotes(notes: TabNote[]) {
		if (!audioOn || playing || notes.length === 0) return;
		const t0 = Math.min(...notes.map((n) => n.time));
		const times = notes.map((n) => n.time);
		synth.previewNote(
			notes.map((n) => ({
				...$state.snapshot(n),
				time: n.time - t0,
				duration: Math.min(previewDuration(n.articulations), untilNext(n.time, times))
			}))
		);
	}

	// Time from `t` to the next later time in `times` (Infinity if none).
	function untilNext(t: number, times: number[]): number {
		let next = Infinity;
		for (const x of times) if (x > t + 1e-4 && x < next) next = x;
		return next - t;
	}

	// Apply per-note articulation lists as one undo step and let the user
	// hear the result.
	function setArticulations(label: string, changes: Array<{ id: string; arts: Articulation[] }>) {
		if (!tab || changes.length === 0) return;
		commitEdit(
			batchCommand(
				label,
				changes.map((c) => cmdUpdateNote(c.id, { articulations: c.arts }))
			)
		);
		const ids = new Set(changes.map((c) => c.id));
		auditionNotes(tab.notes.filter((n) => ids.has(n.id)));
	}

	// Returns true when the key was handled.
	function toggleArticulationKey(code: string, hit: TabNote): boolean {
		if (!tab) return false;
		const has = (k: Articulation['kind']) => hit.articulations.some((a) => a.kind === k);
		const shapeKinds: Record<string, { kind: 'palmMute' | 'ghost' | 'letRing'; name: string }> = {
			m: { kind: 'palmMute', name: 'palm mute' },
			g: { kind: 'ghost', name: 'ghost note' },
			r: { kind: 'letRing', name: 'let ring' }
		};
		const shape = shapeKinds[code];
		if (shape) {
			const on = !has(shape.kind);
			// PM / let ring: the whole vertical stack. Ghost is per-note
			// notation, so it only spreads to a power-chord shape.
			const ids =
				shape.kind === 'ghost'
					? [hit.id, ...powerChordGroupFor(hit).map((m) => m.id)]
					: stackAt(hit.time).map((n) => n.id);
			const changes = ids.flatMap((id) => {
				const n = tab!.notes.find((x) => x.id === id);
				if (!n) return [];
				const rest = withoutArts(n.articulations, shape.kind);
				return [{ id, arts: on ? [...rest, { kind: shape.kind }] : rest }];
			});
			setArticulations(`${on ? 'Add' : 'Remove'} ${shape.name}`, changes);
			return true;
		}
		if (code === 't') {
			const on = !has('tap');
			const rest = withoutArts(hit.articulations, 'tap', 'hammerOn', 'pullOff');
			setArticulations(on ? 'Add tap' : 'Remove tap', [
				{ id: hit.id, arts: on ? [...rest, { kind: 'tap' }] : rest }
			]);
			return true;
		}
		if (code === 'h') {
			const rest = withoutArts(hit.articulations, 'tap', 'hammerOn', 'pullOff');
			if (has('hammerOn') || has('pullOff')) {
				setArticulations('Remove hammer/pull', [{ id: hit.id, arts: rest }]);
				return true;
			}
			const prev = prevNoteOnString(hit);
			// Same fret twice can't be hammered or pulled.
			if (prev && prev.fret === hit.fret) return true;
			const kind = !prev || prev.fret < hit.fret ? 'hammerOn' : 'pullOff';
			setArticulations(kind === 'hammerOn' ? 'Add hammer-on' : 'Add pull-off', [
				{ id: hit.id, arts: [...rest, { kind }] }
			]);
			return true;
		}
		return false;
	}

	function defaultVibratoEnd(note: TabNote): number {
		if (!tab) return note.time;
		const beat = tab.secondsPerBar / tab.timeSignature[0];
		let end = note.time + beat;
		for (const n of tab.notes) {
			if (n.stringIndex === note.stringIndex && n.time > note.time + 1e-6) {
				end = Math.min(end, n.time);
				break;
			}
		}
		return end;
	}

	// Slide origin offset clamped onto the fretboard. A remembered "from 2
	// below" on an open-ish note flips to "from 2 above" instead of vanishing.
	function fitSlideOffset(fret: number, offset: number): number {
		if (fret + offset < 0) offset = -offset;
		return Math.max(0, Math.min(MAX_FRET, fret + offset)) - fret;
	}

	// Default harmonic for a tap: the natural harmonic at node frets,
	// otherwise a pinch harmonic at the last interval used.
	function defaultHarmonicIndex(fret: number): number {
		const choices = harmonicChoices(fret);
		const natural = NATURAL_HARMONIC_OFFSET[fret];
		const want = natural ?? artMemory.pinchInterval;
		const i = choices.indexOf(want);
		return i >= 0 ? i : choices.indexOf(12);
	}

	function beginArtHold(key: HoldArtKey, hit: TabNote, code: string) {
		const arts = hit.articulations;
		let base = 0;
		let baseRelease = false;
		if (key === 'b') {
			const b = arts.find((a) => a.kind === 'bend' || a.kind === 'bendRelease');
			base = b && 'semitones' in b ? b.semitones : artMemory.bend.semitones;
			baseRelease = b ? b.kind === 'bendRelease' : artMemory.bend.release;
		} else if (key === 's') {
			const s = arts.find((a) => a.kind === 'slideUp' || a.kind === 'slideDown');
			if (s && 'fromSemitones' in s)
				base = s.kind === 'slideUp' ? -s.fromSemitones : s.fromSemitones;
			else base = fitSlideOffset(hit.fret, artMemory.slideOffset);
		} else if (key === 'n') {
			const h = arts.find((a) => a.kind === 'harmonic');
			const i = h && 'semitones' in h ? harmonicChoices(hit.fret).indexOf(h.semitones) : -1;
			base = i >= 0 ? i : defaultHarmonicIndex(hit.fret);
		}
		artHold = {
			key,
			code,
			noteId: hit.id,
			before: [...arts],
			startX: lastPointerClient.x,
			startY: lastPointerClient.y,
			moved: false,
			base,
			baseRelease,
			lastAuditionKey: ''
		};
		updateArtHold(lastPointerClient.x, lastPointerClient.y, null);
	}

	// Recompute the held articulation from the pointer and show it live by
	// writing straight to the note; endArtHold turns it into a real command.
	function updateArtHold(clientX: number, clientY: number, pointerTime: number | null) {
		if (!tab || !artHold) return;
		const h = artHold;
		const note = tab.notes.find((n) => n.id === h.noteId);
		if (!note) return;
		const dx = clientX - h.startX;
		const dy = clientY - h.startY;
		if (Math.abs(dx) >= ART_MOVE_THRESHOLD || Math.abs(dy) >= ART_MOVE_THRESHOLD) h.moved = true;
		const b = h.before;
		let next: Articulation[];
		if (h.key === 'b') {
			const rest = withoutArts(b, 'bend', 'bendRelease');
			const had = rest.length !== b.length;
			if (!h.moved && had) {
				next = rest;
			} else {
				const semis = h.moved
					? Math.max(0, Math.min(5, h.base + Math.round(dx / PX_PER_SEMITONE)))
					: h.base;
				let release = h.baseRelease;
				if (dy > 16) release = true;
				else if (dy < -16) release = false;
				next =
					semis === 0
						? rest
						: [...rest, { kind: release ? 'bendRelease' : 'bend', semitones: semis }];
			}
		} else if (h.key === 's') {
			const rest = withoutArts(b, 'slideUp', 'slideDown');
			const had = rest.length !== b.length;
			let offset: number;
			if (!h.moved) offset = had ? 0 : h.base;
			else offset = h.base + Math.round(dx / PX_PER_FRET);
			const origin = Math.max(0, Math.min(MAX_FRET, note.fret + offset));
			offset = origin - note.fret;
			next =
				offset === 0
					? rest
					: offset < 0
						? [...rest, { kind: 'slideUp', fromSemitones: -offset }]
						: [...rest, { kind: 'slideDown', fromSemitones: offset }];
		} else if (h.key === 'n') {
			const rest = withoutArts(b, 'harmonic');
			const had = rest.length !== b.length;
			if (!h.moved && had) {
				next = rest;
			} else {
				const choices = harmonicChoices(note.fret);
				const idx = h.moved
					? Math.max(0, Math.min(choices.length - 1, h.base + Math.round(dx / PX_PER_SEMITONE)))
					: h.base;
				const semitones = choices[idx];
				next = [
					...rest,
					{ kind: 'harmonic', semitones, pinch: !isNaturalHarmonic(note.fret, semitones) }
				];
			}
		} else {
			const rest = withoutArts(b, 'vibrato');
			const had = rest.length !== b.length;
			const step = 240 / tab.bpm / gridStep;
			if (!h.moved) {
				next = had
					? rest
					: [...rest, { kind: 'vibrato', startTime: note.time, endTime: defaultVibratoEnd(note) }];
			} else if (pointerTime === null) {
				return;
			} else {
				// Vibrato end follows the pointer, snapped to the grid.
				const end = Math.max(note.time + step, snapTime(pointerTime));
				next = [...rest, { kind: 'vibrato', startTime: note.time, endTime: end }];
			}
		}
		note.articulations = next;
		tab = tab;
		if (h.key !== 'v') {
			const key = JSON.stringify(next);
			if (key !== h.lastAuditionKey) {
				h.lastAuditionKey = key;
				auditionNotes([note]);
			}
		}
	}

	function endArtHold() {
		const h = artHold;
		artHold = null;
		if (!h || !tab) return;
		const note = tab.notes.find((n) => n.id === h.noteId);
		if (!note) return;
		const final = note.articulations;
		note.articulations = h.before;
		if (JSON.stringify(final) === JSON.stringify(h.before)) {
			tab = tab;
			return;
		}
		// Remember what was just set so the next tap repeats it.
		for (const a of final) {
			if (h.key === 'b' && (a.kind === 'bend' || a.kind === 'bendRelease'))
				artMemory.bend = { semitones: a.semitones, release: a.kind === 'bendRelease' };
			else if (h.key === 's' && a.kind === 'slideUp') artMemory.slideOffset = -a.fromSemitones;
			else if (h.key === 's' && a.kind === 'slideDown') artMemory.slideOffset = a.fromSemitones;
			else if (h.key === 'n' && a.kind === 'harmonic' && a.pinch)
				artMemory.pinchInterval = a.semitones;
		}
		saveArtMemory();
		const labels: Record<HoldArtKey, string> = {
			b: 'Edit bend',
			s: 'Edit slide',
			v: 'Edit vibrato',
			n: 'Edit harmonic'
		};
		commitEdit(
			batchCommand(labels[h.key], [cmdUpdateNote(h.noteId, { articulations: [...final] })])
		);
	}

	// Draws grid subdivision lines + hover ghost + in-flight placement/edit
	// preview on top of the existing tab rendering. All coordinates match
	// pointerToTabPos' formulas above so what you see is exactly where a
	// click will land.
	// The tab's time → x mapping for a canvas `cssW` wide (same maths as the
	// renderer), shared by the author overlay and the spectrogram so both line
	// up with the notes. pageStart..pageEnd is the page (or, in scroll mode,
	// the span treated as the page); the peek follows it.
	function tabTimeScale(
		cssW: number,
		cfg: typeof DEFAULT_RENDER_CONFIG
	): {
		timeToX: (t: number) => number;
		pxPerSec: number;
		pageStart: number;
		pageEnd: number;
	} {
		const secondsPerBar = tab?.secondsPerBar ?? 2;
		const secondsPerBeat = secondsPerBar / (tab?.timeSignature[0] ?? 4);
		const peekDur = peekBeats * secondsPerBeat;
		const usableWidth = cssW - cfg.paddingX * 2;
		if (renderMode === 'page') {
			const pageDur = secondsPerBar * barsPerPage;
			const pxPerSec = usableWidth / (pageDur + peekDur);
			const pageStart = Math.floor(currentTime / pageDur) * pageDur;
			return {
				timeToX: (t) => cfg.paddingX + (t - pageStart) * pxPerSec,
				pxPerSec,
				pageStart,
				pageEnd: pageStart + pageDur
			};
		}
		const totalDur = barsPerPage * secondsPerBar + peekDur;
		const pxPerSec = totalDur > 0 ? usableWidth / totalDur : pixelsPerSecond;
		const playheadX = cssW * cfg.playheadFraction;
		const pageStart = currentTime - playheadX / pxPerSec;
		return {
			timeToX: (t) => playheadX + (t - currentTime) * pxPerSec,
			pxPerSec,
			pageStart,
			pageEnd: pageStart + totalDur
		};
	}

	function drawAuthorOverlay(
		ctx: CanvasRenderingContext2D,
		cssW: number,
		cssH: number,
		cfg: typeof DEFAULT_RENDER_CONFIG
	): void {
		if (!tab) return;
		const usableHeight = cssH - cfg.paddingTop - cfg.paddingBottom;
		const stringGap = usableHeight / (STRING_COUNT - 1);
		const secondsPerBeat = tab.secondsPerBar / tab.timeSignature[0];
		const peekDur = peekBeats * secondsPerBeat;
		const { timeToX, pageStart, pageEnd } = tabTimeScale(cssW, cfg);

		// Play-focus highlight. Whole-bar focus = subtle white overlay across
		// the bar; single-beat focus = blue overlay on just that beat. No
		// text label — the bar number is already drawn at the top of the
		// bar by the renderer, and the colour tells you which mode you're
		// in.
		const focus = authorFocusRange();
		if (focus.end > pageStart && focus.start < pageEnd + peekDur) {
			const fx0 = timeToX(Math.max(pageStart, focus.start));
			const fx1 = timeToX(Math.min(pageEnd + peekDur, focus.end));
			ctx.fillStyle =
				authorFocus.beatIdx === 0 ? 'rgba(255, 255, 255, 0.06)' : 'rgba(80, 160, 240, 0.16)';
			ctx.fillRect(fx0, cfg.paddingTop - 8, Math.max(1, fx1 - fx0), usableHeight + 16);
		}

		// Grid subdivision lines — visible enough that the user can see
		// every snap position. Beats (renderer draws those) are darker;
		// subdivisions in between are lighter but still legible.
		const step = 240 / tab.bpm / gridStep;
		const secondsPerBeatLocal = tab.secondsPerBar / tab.timeSignature[0];
		ctx.lineWidth = 1;
		const gStart = Math.ceil(pageStart / step) * step;
		for (let t = gStart; t <= pageEnd + peekDur + 1e-6; t += step) {
			const x = timeToX(t);
			if (x < cfg.paddingX - 1 || x > cssW - cfg.paddingX + 1) continue;
			// Is this a beat boundary? (Renderer already draws those, but our
			// step might not include them if it's a triplet grid; render our
			// own for consistency, brighter.) Detect by modulo of the beat.
			const rel = t / secondsPerBeatLocal;
			const isBeat = Math.abs(rel - Math.round(rel)) < 1e-4;
			ctx.strokeStyle = isBeat ? 'rgba(255, 255, 255, 0.20)' : 'rgba(255, 255, 255, 0.11)';
			ctx.beginPath();
			ctx.moveTo(x, cfg.paddingTop);
			ctx.lineTo(x, cssH - cfg.paddingBottom);
			ctx.stroke();
		}

		// Tool name and what it will place (shape / chord / sweep info),
		// bottom-right under the low string (the only strip nothing else draws
		// in). The tool's key shortcuts are in the box left of the tab.
		const toolInfo = currentShape
			? (() => {
					const shapes = shapesForTool(currentTool);
					const idx = shapes.indexOf(currentShape) + 1;
					return `shape ${idx}/${shapes.length}: ${shapeLabel(currentShape, shapes, TUNINGS[tuningKey])} (${currentShape.name})`;
				})()
			: isChordTool()
				? chordToolLabel()
				: currentTool === 6
					? sweepToolLabel()
					: '';
		const toolLabel = [TOOL_NAMES[currentTool], toolInfo].filter(Boolean).join(' · ');
		ctx.save();
		ctx.font = '600 12px "JetBrains Mono Variable", ui-monospace, monospace';
		ctx.fillStyle = '#5d6878';
		ctx.textAlign = 'right';
		ctx.textBaseline = 'bottom';
		ctx.fillText(toolLabel, cssW - cfg.paddingX, cssH - 2);
		ctx.restore();

		// Palm-mute hover indicator. Follows the pointer and matches the
		// renderer's placed-note markers: "PM" label centered above the
		// note position, dashed line extends only to the RIGHT of that
		// label so nothing crosses over to before the note.
		// Shown only when a click here would actually place a PM note (tool
		// variant or joining a PM stack), never over an existing note.
		if (
			hoverPos &&
			!authorGesture &&
			!artHold &&
			!findAuthorNoteAt(hoverPos) &&
			placementArts(hoverPos.time).some((a) => a.kind === 'palmMute')
		) {
			const x = timeToX(hoverPos.time);
			if (x >= cfg.paddingX && x <= cssW - cfg.paddingX) {
				const pmY = cfg.paddingTop - PM_LANE_OFFSET;
				ctx.fillStyle = '#a0b0c4';
				ctx.font = '700 14px "JetBrains Mono Variable", ui-monospace, monospace';
				ctx.textAlign = 'center';
				ctx.textBaseline = 'middle';
				ctx.fillText('PM', x, pmY);
				const labelW = ctx.measureText('PM').width;
				const dashStart = x + labelW / 2 + 4;
				const dashEnd = Math.min(dashStart + 32, cssW - cfg.paddingX);
				if (dashEnd > dashStart + 2) {
					ctx.strokeStyle = '#a0b0c4';
					ctx.setLineDash([3, 4]);
					ctx.lineWidth = 1.2;
					ctx.beginPath();
					ctx.moveTo(dashStart, pmY);
					ctx.lineTo(dashEnd, pmY);
					ctx.stroke();
					ctx.setLineDash([]);
				}
			}
		}

		// Hover ghost note(s). Skip when a drag is active — that path draws
		// its own preview below. Power-chord tools show the full stack.
		// Over an existing note (or while a B/S/V key is held) only outline
		// the target, so the note's own decorations stay readable while you
		// add articulations to it.
		// (In the arp tool a click on a note places a new arpeggio unless it's
		// an arpeggio's first note, so the placement preview shows instead.)
		const hoverTarget = artHold
			? (tab.notes.find((n) => n.id === artHold!.noteId) ?? null)
			: !authorGesture && hoverPos && !isSequenceTool()
				? findAuthorNoteAt(hoverPos)
				: null;
		const hoverRun = !artHold ? hoveredArpRun() : null;
		if (hoverRun) {
			// Arp tool over a placed arpeggio: outline every note a drag or
			// key would change.
			for (const n of hoverRun) {
				const x = timeToX(n.time);
				if (x < cfg.paddingX - 4 || x > cssW - cfg.paddingX + 4) continue;
				drawHoverOutline(ctx, x, cfg.paddingTop + n.stringIndex * stringGap, String(n.fret));
			}
		} else if (hoverTarget) {
			const x = timeToX(hoverTarget.time);
			if (x >= cfg.paddingX && x <= cssW - cfg.paddingX) {
				const targets = [hoverTarget, ...powerChordGroupFor(hoverTarget)];
				for (const t of targets) {
					const fret = 'fret' in t ? t.fret : t.initialFret;
					drawHoverOutline(ctx, x, cfg.paddingTop + t.stringIndex * stringGap, String(fret));
				}
			}
		} else if (!authorGesture && hoverPos) {
			const spots = toolPreviewSpots(hoverPos.stringIndex, hoverFret);
			const sweep = currentTool === 6 ? sweepShapeAt(hoverPos.stringIndex, hoverFret) : null;
			const ghosts: Array<{
				time: number;
				stringIndex: number;
				fret: number;
				art?: Articulation['kind'];
			}> =
				currentTool === 6
					? sweep
						? sweepNotes(sweep, hoverPos.time)
						: [{ time: hoverPos.time, stringIndex: hoverPos.stringIndex, fret: hoverFret }]
					: currentTool === 5
						? arpeggiate(spots, hoverPos.time)
						: spots.map((s) => ({ time: hoverPos!.time, ...s }));
			ghosts.forEach((s, i) => {
				const x = timeToX(s.time);
				if (x < cfg.paddingX || x > cssW - cfg.paddingX) return;
				const y = cfg.paddingTop + s.stringIndex * stringGap;
				drawGhostNote(ctx, x, y, String(s.fret), false);
				// Hammer-on / pull-off: the letter between this note and the
				// previous one on its string, like the tab draws tight h/p.
				if (s.art === 'hammerOn' || s.art === 'pullOff') {
					const prev = ghosts.slice(0, i).findLast((p) => p.stringIndex === s.stringIndex);
					if (prev) {
						const mid = (timeToX(prev.time) + x) / 2;
						drawGhostNote(ctx, mid, y, s.art === 'hammerOn' ? 'h' : 'p', false);
					}
				}
			});
		}

		// In-flight drag. The tab itself is rendered with the drag applied
		// (gesturePreviewTab), so from the click on the notes look placed; all
		// that's left to draw is an impossible fingering.
		if (authorGesture?.kind === 'move-fingering') {
			const g = authorGesture;
			const newFret = g.midi - TUNINGS[tuningKey].openNotes[g.currentStringIndex];
			if (newFret < 0 || newFret > MAX_FRET) {
				// Pitch isn't reachable on that string: nothing to preview.
				const x = timeToX(g.currentTime);
				const y = cfg.paddingTop + g.currentStringIndex * stringGap;
				drawGhostNote(ctx, x, y, '×', true, '#ff5577');
			}
		}
	}

	// The tab as it would look if the in-flight drag were committed right
	// now. Rendered in place of the real tab during a drag so moved notes
	// carry their vibrato / bends / PM / h/p with them live. Notes are
	// shallow-copied so nothing here touches the real tab.
	function gesturePreviewTab(): Tab | null {
		if (tab && pmPaint && !authorGesture) {
			const changes = pmPaintChanges();
			if (changes.length === 0) return null;
			const byId = new Map(changes.map((c) => [c.id, c.arts]));
			return {
				...tab,
				notes: tab.notes.map((n) => (byId.has(n.id) ? { ...n, articulations: byId.get(n.id)! } : n))
			};
		}
		if (!tab || !authorGesture) return null;
		const g = authorGesture;
		const tuning = TUNINGS[tuningKey];
		if (g.kind === 'erase') {
			if (g.ids.length === 0) return null;
			const gone = new Set(g.ids);
			const preview: Tab = {
				...tab,
				notes: tab.notes.filter((n) => !gone.has(n.id)).map((n) => ({ ...n }))
			};
			cmdReconcileHammerPull().apply(preview);
			return preview;
		}
		const notes: TabNote[] = tab.notes.map((n) => ({ ...n }));
		const byId = (id: string) => notes.find((n) => n.id === id);
		// Notes the drop would replace (same time, same string) vanish from
		// the preview, exactly as the commit removes them.
		const dropDisplaced = (displaced: TabNote[]) => {
			const gone = new Set(displaced.map((d) => d.id));
			for (let i = notes.length - 1; i >= 0; i--) if (gone.has(notes[i].id)) notes.splice(i, 1);
		};
		const refret = (n: TabNote, stringIndex: number, fret: number) => {
			n.stringIndex = stringIndex;
			n.articulations = retuneHarmonic(n.articulations, fret);
			n.fret = fret;
			n.midi = tuning.openNotes[stringIndex] + fret;
		};
		if (g.kind === 'place') {
			const { notes: placed, displaced } = buildPlacement(g);
			dropDisplaced(displaced);
			notes.push(...placed);
		} else if (g.kind === 'edit-arp') {
			if (g.currentFret === g.initialFret) return null;
			for (const t of arpEditTargets(g)) {
				const n = byId(t.id);
				if (n) refret(n, t.stringIndex, t.fret);
			}
		} else if (g.kind === 'edit') {
			if (g.currentFret === g.initialFret) return null;
			const root = byId(g.noteId);
			if (!root) return null;
			refret(root, g.stringIndex, g.currentFret);
			const targets = editTargets(g);
			if (targets.replace) {
				const gone = new Set(g.group.map((m) => m.id));
				for (let i = notes.length - 1; i >= 0; i--) if (gone.has(notes[i].id)) notes.splice(i, 1);
				notes.push(...chordMemberNotes(root, targets.members));
			} else {
				for (const m of targets.members) {
					const n = m.id ? byId(m.id) : undefined;
					if (n) refret(n, m.stringIndex, m.fret);
				}
			}
		} else if (g.kind === 'move-free' || g.kind === 'move-fingering') {
			const n = byId(g.noteId);
			if (!n) return null;
			const fret =
				g.kind === 'move-free' ? g.fret : g.midi - tuning.openNotes[g.currentStringIndex];
			if (fret < 0 || fret > MAX_FRET) return null;
			const displaced = notesDisplacedBy(
				g.currentTime,
				[g.currentStringIndex],
				new Set([g.noteId])
			);
			dropDisplaced(displaced);
			n.articulations = movedArts(g.noteId, g.currentTime, displaced);
			n.time = g.currentTime;
			refret(n, g.currentStringIndex, fret);
		} else if (g.kind === 'copy') {
			const src = byId(g.sourceId);
			if (!src) return null;
			const displaced = notesDisplacedBy(g.currentTime, [g.currentStringIndex]);
			dropDisplaced(displaced);
			const copy: TabNote = {
				...src,
				id: 'preview-copy',
				time: g.currentTime,
				articulations: adoptStackState(
					shiftTimedArticulations([...src.articulations], g.currentTime - src.time),
					g.currentTime,
					new Set(displaced.map((d) => d.id))
				)
			};
			refret(copy, g.currentStringIndex, g.fret);
			notes.push(copy);
		}
		notes.sort((a, b) => a.time - b.time);
		const preview: Tab = { ...tab, notes };
		// Same h/p fix-up a commit would run, applied to the copies.
		cmdReconcileHammerPull().apply(preview);
		return preview;
	}

	function drawHoverOutline(
		ctx: CanvasRenderingContext2D,
		x: number,
		y: number,
		label: string
	): void {
		ctx.save();
		ctx.font = '400 18px "JetBrains Mono Variable", ui-monospace, Menlo, Consolas, monospace';
		const w = ctx.measureText(label).width;
		ctx.strokeStyle = '#7fb4ff';
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.roundRect(x - w / 2 - 5, y - 12, w + 10, 24, 4);
		ctx.stroke();
		ctx.restore();
	}

	// Hover preview of a note that isn't placed yet: preview-coloured (blue)
	// digits on the tab background, slightly faded when `solid=false`. Once
	// you click, the drag preview is drawn as placed notes instead.
	// `errorColor` marks an impossible spot.
	function drawGhostNote(
		ctx: CanvasRenderingContext2D,
		x: number,
		y: number,
		label: string,
		solid: boolean,
		errorColor: string | null = null
	): void {
		const colors = previewNoteColors(theme);
		ctx.save();
		ctx.font = '400 18px "JetBrains Mono Variable", ui-monospace, Menlo, Consolas, monospace';
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'center';
		const w = ctx.measureText(label).width;
		ctx.fillStyle = errorColor ?? colors.mask;
		ctx.fillRect(x - w / 2 - 4, y - 11, w + 8, 22);
		ctx.globalAlpha = errorColor || solid ? 1 : 0.8;
		ctx.fillStyle = errorColor ? '#ffffff' : colors.text;
		ctx.fillText(label, x, y);
		ctx.restore();
	}

	// In the power-chord tools, find the other notes of the shape whose ROOT
	// is `root`: notes sounding at the same time on the next 1-2 thinner
	// strings. Returns [] when `root` isn't the lowest note of a stack (so
	// clicking the 5th / octave falls back to a single-note edit, letting
	// you turn 5 7 7 into 5 7 9 without switching tools).
	type ShapeGroupMember = { id: string; stringIndex: number; initialFret: number };
	function powerChordGroupFor(root: TabNote): ShapeGroupMember[] {
		if (!tab || (currentTool !== 2 && currentTool !== 3 && currentTool !== 4)) return [];
		if (!isStackRoot(root)) return [];
		// Power 3 spans two strings above the root, Power 2 one, chords all.
		const span = currentTool === 2 ? 2 : currentTool === 3 ? 1 : STRING_COUNT;
		return tab.notes
			.filter(
				(n) =>
					n.id !== root.id &&
					Math.abs(n.time - root.time) < 1e-4 &&
					n.stringIndex < root.stringIndex &&
					n.stringIndex >= root.stringIndex - span
			)
			.map((n) => ({ id: n.id, stringIndex: n.stringIndex, initialFret: n.fret }));
	}

	// Lowest note sounding at its time (nothing on a lower string).
	function isStackRoot(note: TabNote): boolean {
		return !stackAt(note.time).some((n) => n.stringIndex > note.stringIndex);
	}

	// Where the notes above the root end up for an 'edit' drag at the
	// gesture's current fret. Every member shifts by the root's delta,
	// keeping its id — unless it's a recognised chord (tool 4) whose shifted
	// shape isn't playable; that one is rebuilt as the same type / string
	// count / variation at the new bass fret (or the closest voicing if it
	// wasn't a generated one), replacing the old notes (`replace`).
	function editTargets(g: Extract<AuthorGesture, { kind: 'edit' }>): {
		replace: boolean;
		members: Array<{ id?: string; stringIndex: number; fret: number }>;
	} {
		const delta = g.currentFret - g.initialFret;
		const shifted = g.group.map((m) => ({
			id: m.id,
			stringIndex: m.stringIndex,
			fret: memberFret(m, delta)
		}));
		if (!g.chord || delta === 0) return { replace: false, members: shifted };
		const target: Voicing = [{ stringIndex: g.stringIndex, fret: g.currentFret }, ...shifted];
		// Keep the chord's own shape (xx0231 → xx1342) whenever the moved
		// shape is still playable; only fall back to the variation number
		// when it isn't (e.g. an open string would need a negative fret).
		const { list } = chordVoicings(
			TUNINGS[tuningKey],
			typeById(g.chord.typeId),
			g.stringIndex,
			g.currentFret,
			g.chord.strings
		);
		if (list.some((v) => sameVoicing(v, target))) return { replace: false, members: shifted };
		const v = voicingFor(g.chord, g.stringIndex, g.currentFret, target);
		return v ? { replace: true, members: v.slice(1) } : { replace: false, members: shifted };
	}

	// A shape member's fret after the root moved by `delta` frets.
	function memberFret(m: ShapeGroupMember, delta: number): number {
		return m.initialFret + delta;
	}

	// Ctrl+←/→ in the power-chord tools. Over a chord's root it reshapes that
	// chord (and makes the new shape the tool's shape); anywhere else it just
	// changes the tool's shape and plays it at the hover position.
	function cycleShape(dir: 1 | -1) {
		if (!tab || (currentTool !== 2 && currentTool !== 3)) return;
		const tool = currentTool;
		const shapes = shapesForTool(tool);
		const tuning = TUNINGS[tuningKey];
		const hit = hoverPos && !authorGesture ? findAuthorNoteAt(hoverPos) : null;
		const root = hit && isStackRoot(hit) ? hit : null;
		let fromId = toolShapes[tool];
		if (root) {
			const group = powerChordGroupFor(root);
			const members = group.map((m) => ({ stringIndex: m.stringIndex, fret: m.initialFret }));
			const matched = matchShape(shapes, tuning, root, members);
			if (matched) fromId = matched.id;
		}
		const i = shapes.findIndex((s) => s.id === fromId);
		const next = shapes[(i + dir + shapes.length) % shapes.length];
		toolShapes = { ...toolShapes, [tool]: next.id };
		if (root) {
			reshapeChord(root, next);
		} else if (hoverPos) {
			const arts = placementArts(hoverPos.time);
			auditionNotes(
				shapeSpots(next, tuning, hoverPos.stringIndex, hoverFret).map((s, idx) => ({
					id: 'preview',
					time: 0,
					duration: 0.6,
					stringIndex: s.stringIndex,
					fret: s.fret,
					midi: tuning.openNotes[s.stringIndex] + s.fret,
					velocity: idx === 0 ? 0.9 : 0.8,
					channel: 0,
					articulations: [...arts]
				}))
			);
		}
	}

	// New notes for the strings above `root` in a shape or chord, sounding
	// with it and taking over its palm mute / let ring / ghost.
	function chordMemberNotes(
		root: TabNote,
		spots: Array<{ stringIndex: number; fret: number }>
	): TabNote[] {
		const tuning = TUNINGS[tuningKey];
		const keep = root.articulations.filter(
			(a) => a.kind === 'palmMute' || a.kind === 'letRing' || a.kind === 'ghost'
		);
		return spots.map((s) => ({
			id: newNoteId(),
			time: root.time,
			duration: root.duration,
			stringIndex: s.stringIndex,
			fret: s.fret,
			midi: tuning.openNotes[s.stringIndex] + s.fret,
			velocity: 0.8,
			channel: root.channel,
			articulations: [...keep]
		}));
	}

	// ---- Chord tool (4) ----------------------------------------------------
	// A chord is named by its type, string count and variation (an index into
	// chordVoicings(...).list for its bass position). Keys:
	//   Ctrl+←/→, top row (physical Q…P [ ])       type
	//   Ctrl+↑/↓                                 more / fewer strings
	//   Shift+←/→, Shift+top row                 variation
	// They act on, in order: the chord being placed (mouse held), the chord
	// whose bass note is under the pointer (rebuilt in place, one undo step),
	// or the tool's setting, auditioned at the hover position.
	type ChordId = { typeId: string; strings: number; variation: number };
	type ChordAction =
		| { kind: 'type'; dir: 1 | -1 }
		| { kind: 'typeAt'; index: number }
		| { kind: 'strings'; dir: 1 | -1 }
		| { kind: 'variation'; dir: 1 | -1 }
		| { kind: 'variationAt'; index: number };

	const TOP_ROW_CODES = [
		'KeyQ',
		'KeyW',
		'KeyE',
		'KeyR',
		'KeyT',
		'KeyY',
		'KeyU',
		'KeyI',
		'KeyO',
		'KeyP',
		'BracketLeft',
		'BracketRight'
	];
	// Labels for the physical-position keys, named as on a US QWERTY keyboard
	// (a sequential Q W E … row reads better than a layout's own characters).
	// Presses still go by physical position, whatever the layout.
	const topRowKeyLabels = 'QWERTYUIOP[]'.split('');
	// The key left of 1 ("reuse fret" toggle).
	const backquoteKeyLabel = '`';
	// Previous / next variation keys (physical . and /).
	const variationKeyLabels = ['.', '/'];

	const clampIndex = (i: number, n: number) => Math.max(0, Math.min(n - 1, i));
	const wrapIndex = (i: number, n: number) => ((i % n) + n) % n;
	const typeById = (id: string) => CHORD_TYPES.find((c) => c.id === id) ?? CHORD_TYPES[0];
	// Chord names use flats in a flat tuning (Eb Standard), like its string names.
	const flatNames = () => tuningUsesFlats(TUNINGS[tuningKey]);
	function sameVoicing(a: Voicing, b: Voicing) {
		return (
			a.length === b.length &&
			a.every((n) => b.some((m) => m.stringIndex === n.stringIndex && m.fret === n.fret))
		);
	}
	function voicingOf(root: TabNote, group: ShapeGroupMember[]): Voicing {
		return [
			{ stringIndex: root.stringIndex, fret: root.fret },
			...group.map((m) => ({ stringIndex: m.stringIndex, fret: m.initialFret }))
		];
	}
	function toolChordId(): ChordId {
		return { typeId: chordTypeId, strings: chordStrings, variation: chordVoicingIdx };
	}

	// The voicing `id` names with the bass at (bassString, bassFret). A
	// variation of -1 means "closest to `near`" (a chord that isn't one of the
	// generated voicings).
	function voicingFor(
		id: ChordId,
		bassString: number,
		bassFret: number,
		near?: Voicing
	): Voicing | null {
		const { list } = chordVoicings(
			TUNINGS[tuningKey],
			typeById(id.typeId),
			bassString,
			bassFret,
			id.strings
		);
		if (list.length === 0) return null;
		if (id.variation >= 0) return list[clampIndex(id.variation, list.length)];
		return list[Math.max(0, near ? closestVoicing(list, near) : 0)];
	}

	// What an existing chord is, or null if its notes aren't a known type.
	function identifyChord(root: TabNote, group: ShapeGroupMember[]): ChordId | null {
		return identifyVoicing(voicingOf(root, group));
	}

	// What a voicing (bass first) is, or null if it isn't a known chord type.
	function identifyVoicing(current: Voicing): ChordId | null {
		const tuning = TUNINGS[tuningKey];
		const type = matchChordType(tuning, current);
		if (!type) return null;
		const bass = current[0];
		const { list } = chordVoicings(tuning, type, bass.stringIndex, bass.fret, current.length);
		return {
			typeId: type.id,
			strings: current.length,
			variation: list.findIndex((v) => sameVoicing(v, current))
		};
	}

	// ---- Recognising placed arpeggios (arp tool) ------------------------------
	// An arpeggio is found from the notes themselves (so copied or imported
	// ones work too): consecutive single notes at an even spacing of at most
	// a beat, around the given note. It ends at a gap, a moment with more
	// than one note, or a string coming back on a different fret — which is
	// what separates an Am arpeggio from a C arpeggio right after it.
	function arpRunAt(hit: TabNote): TabNote[] | null {
		if (!tab) return null;
		const slots: Array<{ time: number; notes: TabNote[] }> = [];
		for (const n of tab.notes) {
			const last = slots[slots.length - 1];
			if (last && Math.abs(n.time - last.time) < 1e-4) last.notes.push(n);
			else slots.push({ time: n.time, notes: [n] });
		}
		const i = slots.findIndex((s) => s.notes.includes(hit));
		if (i < 0 || slots[i].notes.length !== 1) return null;
		const beat = tab.secondsPerBar / tab.timeSignature[0];
		const single = (s?: { notes: TabNote[] }) => !!s && s.notes.length === 1;
		const gapNext = single(slots[i + 1]) ? slots[i + 1].time - slots[i].time : Infinity;
		const gapPrev = single(slots[i - 1]) ? slots[i].time - slots[i - 1].time : Infinity;
		const step = gapNext <= beat + 1e-6 ? gapNext : gapPrev <= beat + 1e-6 ? gapPrev : null;
		if (step === null) return null;

		// Frets seen per string. In the sweep tool one string (the top of the
		// sweep, 15p12) may use two frets; everywhere else one.
		const frets = new Map<number, Set<number>>([[hit.stringIndex, new Set([hit.fret])]]);
		const maxPerString = currentTool === 6 ? 2 : 1;
		const fits = (n: TabNote) => {
			const seen = frets.get(n.stringIndex);
			if (!seen || seen.has(n.fret)) return true;
			if (seen.size >= maxPerString) return false;
			// Only one string gets the second fret.
			return ![...frets.values()].some((s) => s.size > 1);
		};
		const add = (n: TabNote) => {
			const seen = frets.get(n.stringIndex) ?? new Set<number>();
			seen.add(n.fret);
			frets.set(n.stringIndex, seen);
		};
		const run = [hit];
		for (let j = i + 1; j < slots.length; j++) {
			const n = slots[j].notes[0];
			if (!single(slots[j]) || Math.abs(n.time - run[run.length - 1].time - step) > 1e-4) break;
			if (!fits(n)) break;
			add(n);
			run.push(n);
		}
		for (let j = i - 1; j >= 0; j--) {
			const n = slots[j].notes[0];
			if (!single(slots[j]) || Math.abs(run[0].time - n.time - step) > 1e-4) break;
			if (!fits(n)) break;
			add(n);
			run.unshift(n);
		}
		// A run on one string is a melody, not an arpeggio.
		return run.length >= 2 && frets.size >= 2 ? run : null;
	}

	// The chord an arpeggio outlines: one note per string it uses, bass
	// (lowest string) first.
	function runVoicing(run: Array<{ stringIndex: number; fret: number }>): Voicing {
		const byString = new Map<number, number>();
		for (const n of run) byString.set(n.stringIndex, n.fret);
		return [...byString.entries()]
			.sort((a, b) => b[0] - a[0])
			.map(([stringIndex, fret]) => ({ stringIndex, fret }));
	}

	// Moves each arpeggio note onto `next`, keeping its place in the chord:
	// the lowest tone stays the lowest, the 2nd the 2nd, and so on (spread
	// out when the new chord has a different number of tones).
	function remapArp<T extends { stringIndex: number; fret: number }>(
		run: T[],
		next: Voicing
	): Array<T & { stringIndex: number; fret: number }> {
		const open = TUNINGS[tuningKey].openNotes;
		const pitch = (s: { stringIndex: number; fret: number }) => open[s.stringIndex] + s.fret;
		const oldTones = [...runVoicing(run)].sort((a, b) => pitch(a) - pitch(b));
		const newTones = [...next].sort((a, b) => pitch(a) - pitch(b));
		return run.map((n) => {
			const r = oldTones.findIndex((t) => t.stringIndex === n.stringIndex && t.fret === n.fret);
			const r2 =
				oldTones.length === newTones.length
					? r
					: Math.round((r * (newTones.length - 1)) / Math.max(1, oldTones.length - 1));
			const t = newTones[clampIndex(r2, newTones.length)];
			return { ...n, stringIndex: t.stringIndex, fret: t.fret };
		});
	}

	// Where an 'edit-arp' drag puts every note: the arpeggio's chord moved
	// in the same shape while playable, else re-voiced (like a chord drag);
	// an unrecognised chord just shifts.
	function arpEditTargets(
		g: Extract<AuthorGesture, { kind: 'edit-arp' }>
	): Array<{ id: string; time: number; stringIndex: number; fret: number }> {
		const delta = g.currentFret - g.initialFret;
		if (delta === 0) return g.run;
		const shifted = g.run.map((n) => ({ ...n, fret: n.fret + delta }));
		if (!g.chord) return shifted;
		const moved = runVoicing(shifted);
		const { list } = chordVoicings(
			TUNINGS[tuningKey],
			typeById(g.chord.typeId),
			g.bassString,
			g.currentFret,
			g.chord.strings
		);
		if (list.some((v) => sameVoicing(v, moved))) return shifted;
		const v = voicingFor(g.chord, g.bassString, g.currentFret, moved);
		return v ? remapArp(g.run, v) : shifted;
	}

	// `id` with `action` applied, for a chord with its bass at the given
	// position. Types, string counts and variations stop at their ends.
	function applyChordAction(
		id: ChordId,
		action: ChordAction,
		bassString: number,
		bassFret: number
	): ChordId {
		const tuning = TUNINGS[tuningKey];
		const listFor = (c: ChordId) =>
			chordVoicings(tuning, typeById(c.typeId), bassString, bassFret, c.strings);
		switch (action.kind) {
			case 'type': {
				const i = CHORD_TYPES.findIndex((c) => c.id === id.typeId);
				return { ...id, typeId: CHORD_TYPES[clampIndex(i + action.dir, CHORD_TYPES.length)].id };
			}
			case 'typeAt':
				return { ...id, typeId: CHORD_ROW[action.index] ?? id.typeId };
			case 'strings': {
				// Step from the count actually in use (a 6 asked for on the A
				// string is really 5).
				const used = listFor(id).strings || Math.min(id.strings, bassString + 1);
				return { ...id, strings: Math.max(3, Math.min(STRING_COUNT, used + action.dir)) };
			}
			case 'variation': {
				const n = listFor(id).list.length;
				if (n === 0) return id;
				// Variations wrap around (last → first), unlike types.
				return { ...id, variation: wrapIndex(clampIndex(id.variation, n) + action.dir, n) };
			}
			case 'variationAt': {
				const n = listFor(id).list.length;
				return n === 0 || action.index < n ? { ...id, variation: action.index } : id;
			}
		}
	}

	// Apply a chord key to an existing chord or arpeggio whose notes form
	// `current` (bass first). Updates the tool's settings to match, and
	// returns the new voicing — or null when there's nothing to change.
	function changeExistingChord(
		current: Voicing,
		action: ChordAction
	): { id: ChordId; voicing: Voicing } | null {
		const tuning = TUNINGS[tuningKey];
		const bass = current[0];
		const known = identifyVoicing(current);
		let base: ChordId = known ?? { ...toolChordId(), strings: current.length, variation: -1 };
		if (known) {
			const { list } = chordVoicings(
				tuning,
				typeById(known.typeId),
				bass.stringIndex,
				bass.fret,
				known.strings
			);
			if (known.variation < 0) {
				// Hand-edited chord: carry on from the voicing it's closest to.
				base = { ...known, variation: Math.max(0, closestVoicing(list, current)) };
			} else if (clampIndex(chordVoicingIdx, list.length) === known.variation) {
				// The tool's variation already names this chord; keep the
				// tool's (possibly higher) number so stepping the type up
				// and back down returns to the same voicing.
				base = { ...known, variation: chordVoicingIdx };
			}
		}
		const next = applyChordAction(base, action, bass.stringIndex, bass.fret);
		const v = voicingFor(next, bass.stringIndex, bass.fret, current);
		if (!v) return null;
		chordTypeId = next.typeId;
		chordStrings = next.strings;
		if (next.variation >= 0) chordVoicingIdx = next.variation;
		if (sameVoicing(v, current)) return null;
		return { id: next, voicing: v };
	}

	function chordAction(action: ChordAction) {
		if (!tab || !isChordTool()) return;
		const tuning = TUNINGS[tuningKey];

		// Placed arpeggio under the pointer (arp tool): new chord, same
		// rhythm and order.
		const run = hoveredArpRun();
		if (run) {
			const current = runVoicing(run);
			const bass = current[0];
			const change = changeExistingChord(current, action);
			if (!change) return;
			const moved = remapArp(run, change.voicing);
			commitEdit(
				batchCommand(
					`Change arpeggio to ${chordName(
						tuning.openNotes[bass.stringIndex] + bass.fret,
						typeById(change.id.typeId),
						flatNames()
					)}`,
					moved.map((n) =>
						cmdUpdateNote(n.id, {
							stringIndex: n.stringIndex,
							fret: n.fret,
							midi: tuning.openNotes[n.stringIndex] + n.fret
						})
					)
				)
			);
			const ids = new Set(run.map((n) => n.id));
			auditionNotes(tab.notes.filter((n) => ids.has(n.id)));
			return;
		}

		// Existing chord (or single note) under the pointer: rebuild it.
		const hit = !authorGesture && hoverPos ? findAuthorNoteAt(hoverPos) : null;
		if (currentTool === 4 && hit && isStackRoot(hit)) {
			const group = powerChordGroupFor(hit);
			const current = voicingOf(hit, group);
			const change = changeExistingChord(current, action);
			if (!change) return;
			const { id: next, voicing: v } = change;
			commitEdit(
				batchCommand(`Change chord to ${chordName(hit.midi, typeById(next.typeId), flatNames())}`, [
					...group.map((m) => cmdRemoveNote(m.id)),
					...chordMemberNotes(hit, v.slice(1)).map((n) => cmdAddNote(n))
				])
			);
			const ids = new Set(stackAt(hit.time).map((n) => n.id));
			auditionNotes(tab.notes.filter((n) => ids.has(n.id)));
			return;
		}

		// Otherwise change the tool's setting, relative to the chord being
		// placed or previewed at the pointer.
		const g = authorGesture?.kind === 'place' ? authorGesture : null;
		const at = g
			? { stringIndex: g.stringIndex, fret: g.currentFret }
			: hoverPos && !authorGesture
				? { stringIndex: hoverPos.stringIndex, fret: hoverFret }
				: { stringIndex: STRING_COUNT - 1, fret: 0 };
		const next = applyChordAction(toolChordId(), action, at.stringIndex, at.fret);
		chordTypeId = next.typeId;
		chordStrings = next.strings;
		chordVoicingIdx = Math.max(0, next.variation);
		if (g) {
			// The newly chosen chord is picked at the current fret; further
			// dragging moves it from here.
			authorGesture = { ...g, anchorFret: g.currentFret };
			previewPlacePitch();
		} else {
			auditionHoverChord();
		}
	}

	// Play what a click at the hover position would place with the chord or
	// arp tool: the chord together, or the arpeggio in time.
	function auditionHoverChord() {
		if (!hoverPos || authorGesture || !isChordTool()) return;
		const tuning = TUNINGS[tuningKey];
		const v = voicingFor(toolChordId(), hoverPos.stringIndex, hoverFret);
		if (!v) return;
		const at = hoverPos.time;
		const notes = currentTool === 5 ? arpeggiate(v, at) : v.map((s) => ({ time: at, ...s }));
		auditionNotes(
			notes.map((s, i) => ({
				id: 'preview',
				time: s.time,
				duration: 0.6,
				stringIndex: s.stringIndex,
				fret: s.fret,
				midi: tuning.openNotes[s.stringIndex] + s.fret,
				velocity: currentTool === 5 ? 0.8 : i === 0 ? 0.85 : 0.72,
				channel: 0,
				articulations: placementArts(s.time)
			}))
		);
	}

	// Arp tool: Shift+↑ ascending (again: up-and-down), Shift+↓ descending
	// (again: down-and-up); Shift+←/→ one note fewer / more.
	function arpAction(action: { kind: 'up' | 'down' } | { kind: 'length'; dir: 1 | -1 }) {
		if (!tab || currentTool !== 5) return;
		const run = hoveredArpRun();
		if (run) {
			rebuildArp(run, action);
			return;
		}
		const g = authorGesture?.kind === 'place' ? authorGesture : null;
		if (action.kind === 'length') {
			// Step from the length in use (a single pass until changed).
			const current = arpLength > 0 ? arpLength : currentArpPassLength(g);
			arpLength = Math.max(1, Math.min(64, current + action.dir));
		} else if (action.kind === 'up') {
			arpPattern = arpPattern === 'up' ? 'updown' : 'up';
		} else {
			arpPattern = arpPattern === 'down' ? 'downup' : 'down';
		}
		if (g) previewPlacePitch();
		else auditionHoverChord();
	}

	// Direction / length keys over a placed arpeggio: rebuild it from its own
	// chord, start and speed with the new pattern or one note fewer / more.
	// The tool's direction / length follow, like the chord keys.
	function rebuildArp(
		run: TabNote[],
		action: { kind: 'up' | 'down' } | { kind: 'length'; dir: 1 | -1 }
	) {
		if (!tab) return;
		const tuning = TUNINGS[tuningKey];
		let length = run.length;
		if (action.kind === 'length') {
			length = Math.max(1, Math.min(64, run.length + action.dir));
			arpLength = length;
		} else if (action.kind === 'up') {
			arpPattern = arpPattern === 'up' ? 'updown' : 'up';
		} else {
			arpPattern = arpPattern === 'down' ? 'downup' : 'down';
		}
		const step = run[1].time - run[0].time;
		const placed = arpeggiate(runVoicing(run), run[0].time, { pattern: arpPattern, length, step });
		// Palm mute / let ring / ghost carry over from the arpeggio's first note.
		const keep = run[0].articulations.filter(
			(a) => a.kind === 'palmMute' || a.kind === 'letRing' || a.kind === 'ghost'
		);
		const runIds = new Set(run.map((n) => n.id));
		const notes: TabNote[] = placed.map((p) => ({
			id: newNoteId(),
			time: p.time,
			duration: step,
			stringIndex: p.stringIndex,
			fret: p.fret,
			midi: tuning.openNotes[p.stringIndex] + p.fret,
			velocity: 0.8,
			channel: 0,
			articulations: [...keep]
		}));
		// A longer arpeggio can run into later notes on the same strings.
		const displaced = notes.flatMap((n) => notesDisplacedBy(n.time, [n.stringIndex], runIds));
		const extend = extendDurationTo(tab, Math.max(...notes.map((n) => n.time + n.duration)));
		commitEdit(
			batchCommand('Change arpeggio', [
				...(extend ? [extend] : []),
				...run.map((n) => cmdRemoveNote(n.id)),
				...displaced.map((n) => cmdRemoveNote(n.id)),
				...notes.map((n) => cmdAddNote(n))
			])
		);
		const ids = new Set(notes.map((n) => n.id));
		auditionNotes(tab.notes.filter((n) => ids.has(n.id)));
	}

	// Notes in one pass of the current pattern for the chord being placed or
	// hovered (6 for an up pass over 6 strings, 11 up-and-down).
	function currentArpPassLength(g: Extract<AuthorGesture, { kind: 'place' }> | null): number {
		const at = g
			? { stringIndex: g.stringIndex, fret: g.currentFret }
			: hoverPos
				? { stringIndex: hoverPos.stringIndex, fret: hoverFret }
				: null;
		const tones = at ? (voicingFor(toolChordId(), at.stringIndex, at.fret)?.length ?? 0) : 0;
		return arpCycle(Math.max(1, tones || chordStrings), arpPattern).pass.length;
	}

	// Bottom-right canvas label for the chord tool: the chord under the
	// pointer (existing chord, chord being placed, or the preview), its
	// string count and variation, and the frets.
	function chordToolLabel(): string {
		if (!tab) return '';
		const tuning = TUNINGS[tuningKey];
		const g = authorGesture?.kind === 'place' ? authorGesture : null;
		const hit = !authorGesture && hoverPos ? findAuthorNoteAt(hoverPos) : null;
		let bass: { stringIndex: number; fret: number } | null;
		let id: ChordId;
		let voicing: Voicing | null;
		const run = hoveredArpRun();
		if (run) {
			const current = runVoicing(run);
			const known = identifyVoicing(current);
			if (!known)
				return `arpeggio (${run.length} notes) over ${voicingFrets(current, STRING_COUNT)}: not a known chord`;
			const type = typeById(known.typeId);
			const name = chordName(
				tuning.openNotes[current[0].stringIndex] + current[0].fret,
				type,
				flatNames()
			);
			return `${name} arpeggio · ${run.length} notes: ${voicingFrets(current, STRING_COUNT)}`;
		}
		if (currentTool === 4 && hit && isStackRoot(hit)) {
			const group = powerChordGroupFor(hit);
			const known = identifyChord(hit, group);
			const current = voicingOf(hit, group);
			if (!known) return `${voicingFrets(current, STRING_COUNT)}: not a known chord`;
			bass = hit;
			id = known;
			voicing = current;
		} else {
			bass = g
				? { stringIndex: g.stringIndex, fret: g.currentFret }
				: hoverPos && !authorGesture
					? { stringIndex: hoverPos.stringIndex, fret: hoverFret }
					: null;
			id = toolChordId();
			voicing = g
				? placeGestureSpots(g)
				: bass
					? voicingFor(id, bass.stringIndex, bass.fret)
					: null;
		}
		const type = typeById(id.typeId);
		const rowIdx = CHORD_ROW.indexOf(type.id);
		const typeKey = rowIdx >= 0 ? ` [${topRowKeyLabels[rowIdx]}]` : '';
		if (!bass) return `chord: ${type.suffix || 'major'}${typeKey}`;
		const name =
			chordName(tuning.openNotes[bass.stringIndex] + bass.fret, type, flatNames()) + typeKey;
		const { strings, list } = chordVoicings(tuning, type, bass.stringIndex, bass.fret, id.strings);
		if (!voicing || list.length === 0) return `${name}: no voicing from this string`;
		const idx = list.findIndex((v) => sameVoicing(v, voicing!));
		const variation =
			idx >= 0 ? `variation ${idx + 1}/${list.length}` : `variation ?/${list.length}`;
		const arp =
			currentTool === 5
				? ` · ${ARP_PATTERN_LABEL[arpPattern]} ${
						arpLength > 0
							? `${arpLength} notes`
							: `${arpCycle(voicing.length, arpPattern).pass.length} notes (1 pass)`
					}`
				: '';
		return `${name} · ${strings} strings · ${variation}: ${voicingFrets(voicing, STRING_COUNT)}${arp}`;
	}

	// Replace the notes above `root` with `shape`'s members. The root stays.
	function reshapeChord(root: TabNote, shape: PowerShape) {
		if (!tab) return;
		const tuning = TUNINGS[tuningKey];
		const group = powerChordGroupFor(root);
		const adds = chordMemberNotes(
			root,
			shapeSpots(shape, tuning, root.stringIndex, root.fret).slice(1)
		);
		// The group already holds every note on the strings a shape can
		// use, so removing it leaves those strings free.
		commitEdit(
			batchCommand('Change chord shape', [
				...group.map((g) => cmdRemoveNote(g.id)),
				...adds.map((n) => cmdAddNote(n))
			])
		);
		const ids = new Set([root.id, ...adds.map((a) => a.id)]);
		auditionNotes(tab.notes.filter((n) => ids.has(n.id)));
	}

	// Where the notes of an in-progress placement go. For chords, the shape
	// picked at the anchor fret moves in parallel as the bass is dragged
	// (Dsus2 xx0230 → xx5785), like dragging a placed chord; only when that
	// moved shape can't be played does it fall back to the tool's variation
	// at the current fret.
	function placeGestureSpots(
		g: Extract<AuthorGesture, { kind: 'place' }>
	): Array<{ stringIndex: number; fret: number }> {
		const here = toolPreviewSpots(g.stringIndex, g.currentFret);
		if (!isChordTool() || g.currentFret === g.anchorFret) return here;
		const anchor = voicingFor(toolChordId(), g.stringIndex, g.anchorFret);
		if (!anchor) return here;
		const delta = g.currentFret - g.anchorFret;
		const moved: Voicing = anchor.map((n) => ({
			stringIndex: n.stringIndex,
			fret: n.fret + delta
		}));
		const { list } = chordVoicings(
			TUNINGS[tuningKey],
			typeById(chordTypeId),
			g.stringIndex,
			g.currentFret,
			anchor.length
		);
		return list.some((v) => sameVoicing(v, moved)) ? moved : here;
	}

	// Back to a tool's defaults (Shift+number, or Shift+click its button):
	// no palm mute, and the tool's own shape / chord / arp / sweep settings.
	// The chord, arp and sweep tools share their chord type and string
	// count, so resetting any of them resets those for all three.
	function resetTool(t: Tool) {
		toolVariants = { ...toolVariants, [t]: 'normal' };
		if (t === 2 || t === 3) toolShapes = { ...toolShapes, [t]: DEFAULT_SHAPE[t] };
		if (t === 4 || t === 5 || t === 6) {
			chordTypeId = 'maj';
			chordStrings = 6;
		}
		if (t === 4 || t === 5) chordVoicingIdx = 0;
		if (t === 5) {
			arpPattern = 'up';
			arpLength = 0;
		}
		if (t === 6) {
			sweepVariation = 0;
			sweepPatternId = SWEEP_PATTERNS[0].id;
			sweepLoops = 1;
		}
	}

	// Tools that build a chord from the chord settings: 4 (struck together)
	// and 5 (arpeggiated).
	function isChordTool(): boolean {
		return currentTool === 4 || currentTool === 5;
	}

	// Tools whose notes are spread out in time (one per grid step): arp and
	// sweep. They place over existing notes, and edit a placed run from its
	// first note.
	function isSequenceTool(): boolean {
		return currentTool === 5 || currentTool === 6;
	}

	// ---- Sweep tool (6) ------------------------------------------------------
	// Shares chord type and string count with the chord / arp tools; has its
	// own shape (variation) list — which includes inversions — pattern and
	// loop count.
	function sweepPattern(): SweepPattern {
		return SWEEP_PATTERNS.find((p) => p.id === sweepPatternId) ?? SWEEP_PATTERNS[0];
	}

	// Shapes whose current pattern starts on (startString, startFret): the
	// note you click is the first note of the sweep — its bass for patterns
	// that start low, its top note for ones that start from the top.
	function sweepShapeList(startString: number, startFret: number, pattern = sweepPattern()) {
		return sweepShapesFrom(
			TUNINGS[tuningKey],
			typeById(chordTypeId),
			startString,
			startFret,
			chordStrings,
			pattern
		);
	}

	function sameSweepShape(a: SweepShape, b: SweepShape): boolean {
		return (
			a.extraFret === b.extraFret &&
			a.bassExtraFret === b.bassExtraFret &&
			sameVoicing(a.tones, b.tones)
		);
	}

	// The shape the tool would place starting at the given spot.
	function sweepShapeAt(startString: number, startFret: number): SweepShape | null {
		const { list } = sweepShapeList(startString, startFret);
		return list.length ? list[clampIndex(sweepVariation, list.length)] : null;
	}

	// While placing, the shape picked at the anchor fret moves in parallel as
	// the bass is dragged, like the chord and arp tools, as long as the moved
	// shape is still a valid sweep shape.
	function sweepPlaceShape(g: Extract<AuthorGesture, { kind: 'place' }>): SweepShape | null {
		const here = sweepShapeAt(g.stringIndex, g.currentFret);
		if (g.currentFret === g.anchorFret) return here;
		const anchor = sweepShapeAt(g.stringIndex, g.anchorFret);
		if (!anchor) return here;
		const delta = g.currentFret - g.anchorFret;
		const moved: SweepShape = {
			rootPc: (anchor.rootPc + delta + 1200) % 12,
			tones: anchor.tones.map((t) => ({ ...t, fret: t.fret + delta })),
			extraFret: anchor.extraFret + delta,
			bassExtraFret: anchor.bassExtraFret === null ? null : anchor.bassExtraFret + delta
		};
		const { list } = sweepShapeList(g.stringIndex, g.currentFret);
		return list.find((s) => sameSweepShape(s, moved)) ?? here;
	}

	// A sweep's notes one per grid step from `start` (`opts` overrides the
	// tool's pattern / loops / step when rebuilding a placed sweep).
	function sweepNotes(
		shape: SweepShape,
		start: number,
		opts: { pattern?: SweepPattern; loops?: number; step?: number } = {}
	): Array<{ time: number; stringIndex: number; fret: number; art?: Articulation['kind'] }> {
		if (!tab) return [];
		const step = opts.step ?? 240 / tab.bpm / gridStep;
		return sweepSequence(shape, opts.pattern ?? sweepPattern(), opts.loops ?? sweepLoops).map(
			(n, i) => ({
				time: start + i * step,
				stringIndex: n.stringIndex,
				fret: n.fret,
				art: n.art
			})
		);
	}

	// Notes of one arp pattern pass for `n` chord tones (indices low → high):
	// up 0 1 2 3, down 3 2 1 0, up-down 0 1 2 3 2 1 0, down-up 3 2 1 0 1 2 3.
	// The looping cycle drops the repeated turnaround note (0 1 2 3 2 1 | 0 …).
	function arpCycle(n: number, pattern: ArpPattern): { pass: number[]; cycle: number[] } {
		const up = Array.from({ length: n }, (_, i) => i);
		const down = [...up].reverse();
		if (n <= 1) return { pass: up, cycle: up };
		switch (pattern) {
			case 'up':
				return { pass: up, cycle: up };
			case 'down':
				return { pass: down, cycle: down };
			case 'updown':
				return { pass: [...up, ...down.slice(1)], cycle: [...up, ...down.slice(1, -1)] };
			case 'downup':
				return { pass: [...down, ...up.slice(1)], cycle: [...down, ...up.slice(1, -1)] };
		}
	}

	// Chord tones `spots` played one per grid step from `start`: one pass of
	// the pattern, or `arpLength` notes cycling it.
	// `opts` overrides the tool's pattern / length / grid step (used when
	// rebuilding a placed arpeggio at its own speed).
	function arpeggiate(
		spots: Array<{ stringIndex: number; fret: number }>,
		start: number,
		opts: { pattern?: ArpPattern; length?: number; step?: number } = {}
	): Array<{ time: number; stringIndex: number; fret: number }> {
		if (!tab || spots.length === 0) return [];
		const open = TUNINGS[tuningKey].openNotes;
		const tones = [...spots].sort(
			(a, b) => open[a.stringIndex] + a.fret - (open[b.stringIndex] + b.fret)
		);
		const { pass, cycle } = arpCycle(tones.length, opts.pattern ?? arpPattern);
		const length = opts.length ?? arpLength;
		const order = length > 0 ? Array.from({ length }, (_, i) => cycle[i % cycle.length]) : pass;
		const step = opts.step ?? 240 / tab.bpm / gridStep;
		return order.map((idx, i) => ({ time: start + i * step, ...tones[idx] }));
	}

	// The placed arpeggio under the pointer in the arp tool, if any.
	// Only when the pointer is on its first note — the one that grabs it.
	function hoveredArpRun(): TabNote[] | null {
		if (!isSequenceTool() || authorGesture || !hoverPos) return null;
		const hit = findAuthorNoteAt(hoverPos);
		return hit ? arpStartingAt(hit) : null;
	}

	// The arpeggio that `note` is the first note of, if any.
	function arpStartingAt(note: TabNote): TabNote[] | null {
		const run = arpRunAt(note);
		return run && run[0].id === note.id ? run : null;
	}

	// Every note an in-progress placement would put down, with its time: a
	// chord / shape all at the click time, an arpeggio spread over the grid.
	// Keys in the sweep tool. Chord keys as in the chord / arp tools (the top
	// row and Ctrl+←/→ pick the type, Ctrl+↑/↓ the strings, Shift + top row
	// the shape), plus Shift+↑/↓ pattern and Shift+←/→ loops. They act on the
	// sweep being placed, the placed sweep whose first note is under the
	// pointer (rebuilt in place), or the tool's settings.
	type SweepAction =
		ChordAction | { kind: 'pattern'; dir: 1 | -1 } | { kind: 'loops'; dir: 1 | -1 };

	function applySweepAction(action: SweepAction, bassString: number, bassFret: number) {
		switch (action.kind) {
			case 'type': {
				const i = CHORD_TYPES.findIndex((c) => c.id === chordTypeId);
				chordTypeId = CHORD_TYPES[clampIndex(i + action.dir, CHORD_TYPES.length)].id;
				break;
			}
			case 'typeAt':
				chordTypeId = CHORD_ROW[action.index] ?? chordTypeId;
				break;
			case 'strings': {
				const used = sweepShapeList(bassString, bassFret).strings || chordStrings;
				// Sweeps go down to 2 strings (legato-ish); chords stay at 3+.
				chordStrings = Math.max(2, Math.min(STRING_COUNT, used + action.dir));
				break;
			}
			case 'variation': {
				const n = sweepShapeList(bassString, bassFret).list.length;
				if (n) sweepVariation = wrapIndex(clampIndex(sweepVariation, n) + action.dir, n);
				break;
			}
			case 'variationAt': {
				const n = sweepShapeList(bassString, bassFret).list.length;
				if (n === 0 || action.index < n) sweepVariation = action.index;
				break;
			}
			case 'pattern': {
				const i = SWEEP_PATTERNS.findIndex((p) => p.id === sweepPatternId);
				sweepPatternId = SWEEP_PATTERNS[clampIndex(i + action.dir, SWEEP_PATTERNS.length)].id;
				break;
			}
			case 'loops':
				sweepLoops = Math.max(1, Math.min(16, sweepLoops + action.dir));
				break;
		}
	}

	function sweepAction(action: SweepAction) {
		if (!tab || currentTool !== 6) return;
		const run = hoveredArpRun();
		if (run) {
			rebuildSweep(run, action);
			return;
		}
		const g = authorGesture?.kind === 'place' ? authorGesture : null;
		const at = g
			? { stringIndex: g.stringIndex, fret: g.currentFret }
			: hoverPos && !authorGesture
				? { stringIndex: hoverPos.stringIndex, fret: hoverFret }
				: { stringIndex: STRING_COUNT - 1, fret: 0 };
		applySweepAction(action, at.stringIndex, at.fret);
		if (g) {
			// The new choice is picked at the current fret; further dragging
			// moves it from here.
			authorGesture = { ...g, anchorFret: g.currentFret };
			previewPlacePitch();
		} else {
			auditionHoverSweep();
		}
	}

	function auditionHoverSweep() {
		if (!hoverPos || authorGesture || currentTool !== 6) return;
		const shape = sweepShapeAt(hoverPos.stringIndex, hoverFret);
		if (!shape) return;
		const tuning = TUNINGS[tuningKey];
		auditionNotes(
			sweepNotes(shape, hoverPos.time).map((s) => ({
				id: 'preview',
				time: s.time,
				duration: 0.6,
				stringIndex: s.stringIndex,
				fret: s.fret,
				midi: tuning.openNotes[s.stringIndex] + s.fret,
				velocity: 0.8,
				channel: 0,
				articulations: s.art
					? [...placementArts(s.time), { kind: s.art } as Articulation]
					: placementArts(s.time)
			}))
		);
	}

	// What a placed sweep is: its shape (one tone per string — the lower fret
	// on a string that rolls two — looked up among every chord type's sweep
	// shapes, the tool's type first), and the pattern and loop count that
	// reproduce its notes exactly. `variation` is the shape's number in the
	// list for its first note, as the tool counts it (-1 if hand-edited).
	type IdentifiedSweep = {
		typeId: string;
		strings: number;
		shape: SweepShape;
		pattern: SweepPattern;
		loops: number;
		variation: number;
	};
	function identifySweep(run: TabNote[]): IdentifiedSweep | null {
		const tuning = TUNINGS[tuningKey];
		const byString = new Map<number, number[]>();
		for (const n of run)
			byString.set(n.stringIndex, [...(byString.get(n.stringIndex) ?? []), n.fret]);
		const tones: Voicing = [...byString.entries()]
			.sort((a, b) => b[0] - a[0])
			.map(([stringIndex, frets]) => ({ stringIndex, fret: Math.min(...frets) }));
		const bass = tones[0];
		const types = [typeById(chordTypeId), ...CHORD_TYPES.filter((c) => c.id !== chordTypeId)];
		const patterns = [sweepPattern(), ...SWEEP_PATTERNS.filter((p) => p.id !== sweepPatternId)];
		const matches = (shape: SweepShape, p: SweepPattern, loops: number) => {
			const seq = sweepSequence(shape, p, loops);
			return (
				seq.length === run.length &&
				seq.every((s, i) => s.stringIndex === run[i].stringIndex && s.fret === run[i].fret)
			);
		};
		let fallback: IdentifiedSweep | null = null;
		for (const type of types) {
			const { list } = sweepShapes(tuning, type, bass.stringIndex, bass.fret, tones.length);
			for (const shape of list.filter((s) => sameVoicing(s.tones, tones))) {
				for (const p of patterns) {
					// Without a bass roll a "starts 5h8" pattern is just "up".
					if (p.bassHammer && shape.bassExtraFret === null) continue;
					const len = sweepCycle(shape, p).length;
					if (run.length % len !== 0 || !matches(shape, p, run.length / len)) continue;
					const from = sweepShapesFrom(
						tuning,
						type,
						run[0].stringIndex,
						run[0].fret,
						tones.length,
						p
					).list;
					return {
						typeId: type.id,
						strings: tones.length,
						shape,
						pattern: p,
						loops: run.length / len,
						variation: from.findIndex((s) => sameSweepShape(s, shape))
					};
				}
				// Right shape, but the notes don't follow a pattern exactly.
				fallback ??= {
					typeId: type.id,
					strings: tones.length,
					shape,
					pattern: sweepPattern(),
					loops: Math.max(1, Math.round(run.length / sweepCycle(shape, sweepPattern()).length)),
					variation: -1
				};
			}
		}
		return fallback;
	}

	// A key over a placed sweep: start from the sweep's own shape, pattern
	// and loop count, apply the key, and rebuild it at its start time and
	// speed. Pattern / loop keys keep the shape; chord keys pick a shape for
	// the sweep's first note. The tool's settings follow.
	function rebuildSweep(run: TabNote[], action: SweepAction) {
		if (!tab) return;
		const tuning = TUNINGS[tuningKey];
		const known = identifySweep(run);
		if (known) {
			chordTypeId = known.typeId;
			chordStrings = known.strings;
			sweepPatternId = known.pattern.id;
			sweepLoops = Math.min(16, known.loops);
			sweepVariation = Math.max(0, known.variation);
		}
		let shape: SweepShape | null;
		if (action.kind === 'pattern' || action.kind === 'loops') {
			shape = known?.shape ?? sweepShapeAt(run[0].stringIndex, run[0].fret);
			if (!shape) return;
			applySweepAction(action, run[0].stringIndex, run[0].fret);
			// Skip patterns this shape can't play (no bass roll for 5h8).
			while (sweepPattern().bassHammer && shape.bassExtraFret === null) {
				const before = sweepPatternId;
				applySweepAction(action, run[0].stringIndex, run[0].fret);
				if (sweepPatternId === before) {
					if (known) sweepPatternId = known.pattern.id;
					return;
				}
			}
		} else {
			applySweepAction(action, run[0].stringIndex, run[0].fret);
			shape = sweepShapeAt(run[0].stringIndex, run[0].fret);
		}
		if (!shape) return;
		const step = run[1].time - run[0].time;
		const placed = sweepNotes(shape, run[0].time, { step });
		// Palm mute / let ring / ghost carry over from the sweep's first note.
		const keep = run[0].articulations.filter(
			(a) => a.kind === 'palmMute' || a.kind === 'letRing' || a.kind === 'ghost'
		);
		const runIds = new Set(run.map((n) => n.id));
		const notes: TabNote[] = placed.map((p) => ({
			id: newNoteId(),
			time: p.time,
			duration: step,
			stringIndex: p.stringIndex,
			fret: p.fret,
			midi: tuning.openNotes[p.stringIndex] + p.fret,
			velocity: 0.8,
			channel: 0,
			articulations: p.art ? [...keep, { kind: p.art } as Articulation] : [...keep]
		}));
		// A longer sweep can run into later notes on the same strings.
		const displaced = notes.flatMap((n) => notesDisplacedBy(n.time, [n.stringIndex], runIds));
		const extend = extendDurationTo(tab, Math.max(...notes.map((n) => n.time + n.duration)));
		commitEdit(
			batchCommand('Change sweep', [
				...(extend ? [extend] : []),
				...run.map((n) => cmdRemoveNote(n.id)),
				...displaced.map((n) => cmdRemoveNote(n.id)),
				...notes.map((n) => cmdAddNote(n))
			])
		);
		const ids = new Set(notes.map((n) => n.id));
		auditionNotes(tab.notes.filter((n) => ids.has(n.id)));
	}

	// "x x 14 12 13 12, roll 15p12" — the shape and the rolls its pattern uses.
	function sweepShapeText(shape: SweepShape, pattern: SweepPattern): string {
		const top = shape.tones[shape.tones.length - 1];
		const bass = shape.tones[0];
		const rolls: string[] = [];
		if (pattern.bassHammer && shape.bassExtraFret !== null)
			rolls.push(`${bass.fret}h${shape.bassExtraFret}`);
		if (pattern.top === 'pull') rolls.push(`${shape.extraFret}p${top.fret}`);
		if (pattern.top === 'full') rolls.push(`${top.fret} ${shape.extraFret}p${top.fret}`);
		const frets = voicingFrets(shape.tones, STRING_COUNT);
		return rolls.length ? `${frets}, roll ${rolls.join(' ')}` : frets;
	}

	// Bottom-right canvas label for the sweep tool.
	function sweepToolLabel(): string {
		if (!tab) return '';
		const tuning = TUNINGS[tuningKey];
		const run = hoveredArpRun();
		if (run) {
			const known = identifySweep(run);
			if (!known) return `sweep (${run.length} notes): not a known shape`;
			const name = sweepName(known.shape, typeById(known.typeId), tuning);
			return `${name} sweep · ${known.pattern.name} ×${known.loops}: ${sweepShapeText(known.shape, known.pattern)}`;
		}
		const type = typeById(chordTypeId);
		const rowIdx = CHORD_ROW.indexOf(type.id);
		const typeKey = rowIdx >= 0 ? ` [${topRowKeyLabels[rowIdx]}]` : '';
		const g = authorGesture?.kind === 'place' ? authorGesture : null;
		const start = g
			? { stringIndex: g.stringIndex, fret: g.currentFret }
			: hoverPos && !authorGesture
				? { stringIndex: hoverPos.stringIndex, fret: hoverFret }
				: null;
		const pattern = sweepPattern();
		const patternText = `${pattern.name} ×${sweepLoops}`;
		const typeName = type.suffix || 'major';
		if (!start) return `sweep: ${typeName}${typeKey} · ${patternText}`;
		const shape = g ? sweepPlaceShape(g) : sweepShapeAt(start.stringIndex, start.fret);
		const { strings, list } = sweepShapeList(start.stringIndex, start.fret);
		const where = patternStart(pattern) === 'bass' ? 'on its bass' : 'on its top note';
		if (!shape || list.length === 0)
			return `no ${typeName} sweep starting ${where} here · ${patternText}`;
		const idx = list.findIndex((s) => sameSweepShape(s, shape));
		return `${sweepName(shape, type, tuning)}${typeKey} · ${strings} strings · shape ${idx + 1}/${list.length}: ${sweepShapeText(shape, pattern)} · ${patternText}`;
	}

	// (Sweeps also carry their hammer-ons / pull-offs in `art`.)
	function placementNotes(
		g: Extract<AuthorGesture, { kind: 'place' }>
	): Array<{ time: number; stringIndex: number; fret: number; art?: Articulation['kind'] }> {
		if (currentTool === 6) {
			const shape = sweepPlaceShape(g);
			return shape
				? sweepNotes(shape, g.time)
				: [{ time: g.time, stringIndex: g.stringIndex, fret: g.currentFret }];
		}
		const spots = placeGestureSpots(g);
		if (currentTool === 5) return arpeggiate(spots, g.time);
		return spots.map((s) => ({ time: g.time, ...s }));
	}

	// The notes a placement puts down, and the existing notes they replace
	// (same time, same string). Shared by the commit and the live preview.
	function buildPlacement(g: Extract<AuthorGesture, { kind: 'place' }>): {
		notes: TabNote[];
		displaced: TabNote[];
	} {
		const tuning = TUNINGS[tuningKey];
		const placed = placementNotes(g);
		const times = [...new Set(placed.map((p) => p.time))];
		const displaced = times.flatMap((t) =>
			notesDisplacedBy(
				t,
				placed.filter((p) => p.time === t).map((p) => p.stringIndex)
			)
		);
		const gone = new Set(displaced.map((n) => n.id));
		// Power-chord velocities: gently root-heavy so the fundamental still
		// cuts through against the upper notes, but not so lopsided that the
		// root swamps the rest. Arpeggio notes are even.
		const n = placed.length;
		const velocities = isSequenceTool()
			? []
			: n === 3
				? [0.9, 0.8, 0.72]
				: n === 2
					? [0.9, 0.8]
					: [0.85];
		const step = 240 / (tab?.bpm ?? 120) / gridStep;
		const notes = placed.map((p, i) => {
			const arts = placementArts(p.time, gone);
			const pm = arts.some((a) => a.kind === 'palmMute');
			return {
				id: newNoteId(),
				time: p.time,
				// An arpeggio note lasts one grid step, up to the next note.
				duration: isSequenceTool() ? step : noteDefaultDuration(pm),
				stringIndex: p.stringIndex,
				fret: p.fret,
				midi: tuning.openNotes[p.stringIndex] + p.fret,
				velocity: velocities[i] ?? 0.8,
				channel: 0,
				articulations: p.art ? [...arts, { kind: p.art } as Articulation] : [...arts]
			};
		});
		return { notes, displaced };
	}

	// Where notes go for the currently-active tool. Single-note tool → one
	// spot at the clicked string/fret. Power-chord tools stack the selected
	// shape's members on the strings above the root. Root is the LOW string
	// (higher stringIndex). Unreachable notes are dropped so the preview
	// never runs off the fretboard.
	function toolPreviewSpots(
		rootStringIndex: number,
		rootFret: number
	): Array<{ stringIndex: number; fret: number }> {
		if (isChordTool()) {
			// No playable voicing from here (e.g. too near the top string):
			// just the root, so the preview still shows where you are.
			return (
				voicingFor(toolChordId(), rootStringIndex, rootFret) ?? [
					{ stringIndex: rootStringIndex, fret: rootFret }
				]
			);
		}
		if (!currentShape) return [{ stringIndex: rootStringIndex, fret: rootFret }];
		return shapeSpots(currentShape, TUNINGS[tuningKey], rootStringIndex, rootFret).map((s) => ({
			stringIndex: s.stringIndex,
			fret: s.fret
		}));
	}

	// ---- View-mode canvas interactions ---------------------------------------

	function onCanvasPointerDown(ev: PointerEvent) {
		if (mode === 'author') {
			onAuthorPointerDown(ev);
			return;
		}
		if (!tab) return;
		const pos = pointerToTabPos(ev);
		if (!pos) return;

		// Shift+click BETWEEN two notes on the same string → hammer or pull-off
		// (auto direction: fret up = hammer, fret down = pull, equal = hammer).
		if (ev.shiftKey) {
			const flanking = findFlankingNotes(pos);
			if (!flanking) {
				ev.preventDefault();
				return;
			}
			const { prev, next } = flanking;
			const desired: 'hammer' | 'pull' = next.fret < prev.fret ? 'pull' : 'hammer';
			toggleAnnotation(overrideKey(next.time, next.midi, next.channel), desired);
			ev.preventDefault();
			return;
		}

		// Alt+click on a note → toggle tap.
		if (ev.altKey) {
			const hit = findNearestNote(pos);
			if (!hit) {
				ev.preventDefault();
				return;
			}
			toggleAnnotation(overrideKey(hit.time, hit.midi, hit.channel), 'tap');
			ev.preventDefault();
			return;
		}

		const hit = findNearestNote(pos);
		if (!hit) return;
		dragging = { note: hit };
		canvas.setPointerCapture(ev.pointerId);
	}

	function onCanvasPointerMove(ev: PointerEvent) {
		if (mode === 'author') {
			onAuthorPointerMove(ev);
			return;
		}
		if (!dragging) return;
		// Preview would go here — for now we just wait for release.
		void ev;
	}

	function onCanvasPointerUp(ev: PointerEvent) {
		if (mode === 'author') {
			onAuthorPointerUp(ev);
			return;
		}
		if (!dragging) return;
		try {
			canvas.releasePointerCapture(ev.pointerId);
		} catch {
			// no-op
		}
		const pos = pointerToTabPos(ev);
		const note = dragging.note;
		dragging = null;
		if (!pos || !tab) return;
		if (pos.stringIndex === note.stringIndex) {
			// Click without a real drag — log info to help with debugging.
			const secondsPerBeat = tab.secondsPerBar / tab.timeSignature[0];
			const bar = Math.floor(note.time / tab.secondsPerBar) + 1;
			const beat = Math.floor((note.time % tab.secondsPerBar) / secondsPerBeat) + 1;
			console.log(`bar ${bar} beat ${beat}`, {
				time: note.time.toFixed(3),
				midi: note.midi,
				fret: note.fret,
				string: note.stringIndex,
				channel: note.channel,
				velocity: note.velocity.toFixed(2),
				articulations: note.articulations.map((a) => a.kind).join(', ') || '—',
				override: overrides[overrideKey(note.time, note.midi, note.channel)] ?? '—'
			});
			return;
		}

		const tuning = TUNINGS[tuningKey];
		const newFret = note.midi - tuning.openNotes[pos.stringIndex];
		if (newFret < 0 || newFret > MAX_FRET) return; // unreachable on that string

		overrides = {
			...overrides,
			[overrideKey(note.time, note.midi, note.channel)]: pos.stringIndex
		};
	}

	function clearOverrides() {
		overrides = {};
	}

	function seekAbs(t: number) {
		if (!tab) return;
		const next = Math.max(0, Math.min(effectiveDurationSec, t));
		currentTime = next;
		lastSeekTime = next;
		if (playing && audioOn) synthRestart(next);
	}

	function timelineTimeFromEvent(e: PointerEvent, snap: boolean): number | null {
		if (!tab) return null;
		const rect = timelineCanvas.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const frac = Math.max(0, Math.min(1, x / rect.width));
		let t = frac * effectiveDurationSec;
		if (snap) {
			const secondsPerBeat = tab.secondsPerBar / tab.timeSignature[0];
			const beat = Math.round(t / secondsPerBeat);
			t = beat * secondsPerBeat;
			t = Math.max(0, Math.min(effectiveDurationSec, t));
		}
		return t;
	}

	// Seek from the timeline. In author mode the bar there also becomes the
	// focus, so Space plays that bar (not the one focused before).
	function seekFromTimeline(t: number) {
		seekAbs(t);
		if (mode !== 'author' || !tab) return;
		const lastBar = Math.max(0, Math.ceil(effectiveDurationSec / tab.secondsPerBar) - 1);
		const barIdx = Math.min(lastBar, Math.floor(currentTime / tab.secondsPerBar + 1e-6));
		if (authorFocus.barIdx !== barIdx || authorFocus.beatIdx !== 0) {
			authorFocus = { barIdx, beatIdx: 0 };
		}
	}

	function onTimelinePointerDown(e: PointerEvent) {
		if (!tab) return;
		timelineCanvas.setPointerCapture(e.pointerId);
		timelineDragging = true;
		const t = timelineTimeFromEvent(e, !e.shiftKey);
		if (t !== null) seekFromTimeline(t);
	}
	function onTimelinePointerMove(e: PointerEvent) {
		if (!timelineDragging) return;
		const t = timelineTimeFromEvent(e, !e.shiftKey);
		if (t !== null) seekFromTimeline(t);
	}
	function onTimelinePointerUp(e: PointerEvent) {
		timelineDragging = false;
		try {
			timelineCanvas.releasePointerCapture(e.pointerId);
		} catch {
			// no-op
		}
	}

	function drawTimeline(): void {
		if (!timelineCanvas) return;
		const tctx = timelineCanvas.getContext('2d');
		if (!tctx) return;
		// HiDPI-aware resize + transform so lines/text stay sharp when the CSS
		// container scales the canvas.
		const dpr = window.devicePixelRatio || 1;
		const cssW = timelineCanvas.clientWidth || timelineCanvas.width / dpr;
		const cssH = timelineCanvas.clientHeight || timelineCanvas.height / dpr;
		const targetW = Math.round(cssW * dpr);
		const targetH = Math.round(cssH * dpr);
		if (timelineCanvas.width !== targetW || timelineCanvas.height !== targetH) {
			timelineCanvas.width = targetW;
			timelineCanvas.height = targetH;
		}
		tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		const w = cssW;
		const h = cssH;
		tctx.fillStyle = '#0b0f14';
		tctx.fillRect(0, 0, w, h);
		if (!tab || effectiveDurationSec <= 0) return;
		const tabRef = tab;
		const durForDraw = effectiveDurationSec;
		const totalBars = Math.max(1, Math.ceil(durForDraw / tabRef.secondsPerBar));
		const xForTime = (t: number) => (t / durForDraw) * w;

		// Filled progress up to currentTime
		tctx.fillStyle = '#1c2734';
		tctx.fillRect(0, 0, xForTime(currentTime), h);

		// Beat lines (thin, subtle)
		const beatsPerBar = tabRef.timeSignature[0];
		const secondsPerBeat = tabRef.secondsPerBar / beatsPerBar;
		tctx.strokeStyle = '#232c36';
		tctx.lineWidth = 1;
		const totalBeats = Math.ceil(durForDraw / secondsPerBeat);
		for (let b = 0; b <= totalBeats; b++) {
			const x = Math.round(xForTime(b * secondsPerBeat)) + 0.5;
			tctx.beginPath();
			tctx.moveTo(x, h * 0.55);
			tctx.lineTo(x, h);
			tctx.stroke();
		}

		// Bar lines (bolder) + bar numbers
		tctx.strokeStyle = '#3a4553';
		tctx.lineWidth = 1.25;
		tctx.fillStyle = '#8a99ad';
		tctx.font = '600 11px ui-monospace, Menlo, Consolas, monospace';
		tctx.textAlign = 'left';
		tctx.textBaseline = 'top';
		// Skip drawing every label if bars would collide; require ~28px between labels
		const minLabelPx = 28;
		const barPx = w / totalBars;
		const labelEvery = Math.max(1, Math.ceil(minLabelPx / barPx));
		for (let b = 0; b <= totalBars; b++) {
			const x = Math.round(xForTime(b * tabRef.secondsPerBar)) + 0.5;
			tctx.beginPath();
			tctx.moveTo(x, 0);
			tctx.lineTo(x, h);
			tctx.stroke();
			if (b < totalBars && b % labelEvery === 0) {
				tctx.fillText(String(b + 1), x + 3, 3);
			}
		}

		// Playhead handle
		const px = xForTime(currentTime);
		const handleW = 10;
		tctx.fillStyle = '#ffcc55';
		tctx.fillRect(Math.round(px - handleW / 2), 0, handleW, h);
		tctx.strokeStyle = '#ff5577';
		tctx.lineWidth = 2;
		tctx.beginPath();
		tctx.moveTo(Math.round(px) + 0.5, 0);
		tctx.lineTo(Math.round(px) + 0.5, h);
		tctx.stroke();
	}

	// Restore persisted settings + last-opened file + last-used sync port on
	// mount. All best-effort — failures are silent.
	onMount(async () => {
		try {
			const b = (k: string, def: boolean) => {
				const v = localStorage.getItem(k);
				return v === null ? def : v === '1';
			};
			const n = (k: string, def: number) => {
				const v = localStorage.getItem(k);
				const p = v === null ? NaN : Number(v);
				return Number.isFinite(p) ? p : def;
			};
			metronomeOn = b('tabutabu.metronomeOn', metronomeOn);
			metronomeVol = n('tabutabu.metronomeVol', metronomeVol);
			syncOffsetMs = n('tabutabu.syncOffsetMs', syncOffsetMs);
			keepLeadingSilence = b('tabutabu.keepLeadingSilence', keepLeadingSilence);
			preservePositionOnStart = b('tabutabu.preservePositionOnStart', preservePositionOnStart);
			syncDebug = b('tabutabu.syncDebug', syncDebug);
			videoOffsetSec = n('tabutabu.videoOffsetSec', videoOffsetSec);
			videoAudioOn = b('tabutabu.videoAudioOn', videoAudioOn);
			videoVolume = Math.max(0, Math.min(1, n('tabutabu.videoVolume', videoVolume)));
			const tpos = localStorage.getItem('tabutabu.tabPositionOnVideo');
			if (
				tpos === 'bottom' ||
				tpos === 'top' ||
				tpos === 'extend-below' ||
				tpos === 'extend-above' ||
				tpos === 'crop-top-bottom'
			)
				tabPositionOnVideo = tpos;
			tabSizePercent = n('tabutabu.tabSizePercent', tabSizePercent);
			tabPaddingPercent = n('tabutabu.tabPaddingPercent', tabPaddingPercent);
			exportFps = n('tabutabu.exportFps', exportFps);
			const savedEncoder = localStorage.getItem('tabutabu.exportEncoder');
			if (
				savedEncoder === 'h264_nvenc' ||
				savedEncoder === 'hevc_nvenc' ||
				savedEncoder === 'av1_nvenc' ||
				savedEncoder === 'libx264' ||
				savedEncoder === 'libx265'
			) {
				exportEncoder = savedEncoder;
			}
			const ps = localStorage.getItem('tabutabu.playheadStyle');
			if (ps === 'line' || ps === 'beat' || ps === 'bar') playheadStyle = ps;
			const th = localStorage.getItem('tabutabu.theme');
			if (th === 'dark' || th === 'light') theme = th;
			stringFlashEnabled = b('tabutabu.stringFlashEnabled', stringFlashEnabled);
			const tk = localStorage.getItem('tabutabu.tuningKey');
			if (tk && tk in TUNINGS) tuningKey = tk as keyof typeof TUNINGS;
			// Restore the active author tool.
			const savedTool = Number(localStorage.getItem('tabutabu.currentTool'));
			if ([0, 1, 2, 3, 4, 5, 6].includes(savedTool) && localStorage.getItem('tabutabu.currentTool'))
				currentTool = savedTool as Tool;
			// Restore per-tool palm-mute variants.
			try {
				const raw = localStorage.getItem('tabutabu.toolVariants');
				if (raw) {
					const parsed = JSON.parse(raw) as Record<string, string>;
					const restored: Record<Tool, 'normal' | 'palmMute'> = {
						0: 'normal',
						1: 'normal',
						2: 'normal',
						3: 'normal',
						4: 'normal',
						5: 'normal',
						6: 'normal'
					};
					for (const k of Object.keys(restored) as unknown as Tool[]) {
						const v = parsed[String(k)];
						if (v === 'palmMute') restored[k] = 'palmMute';
					}
					toolVariants = restored;
				}
			} catch {
				// ignore malformed JSON
			}
			// Restore the power-chord tools' selected shapes (unknown ids
			// are dropped so a renamed shape falls back to the default).
			try {
				const raw = localStorage.getItem('tabutabu.toolShapes');
				if (raw) {
					const parsed = JSON.parse(raw) as Record<string, string>;
					const valid = (tool: 2 | 3) =>
						shapesForTool(tool).some((s) => s.id === parsed[tool]) ? parsed[tool] : undefined;
					toolShapes = {
						2: valid(2) ?? toolShapes[2],
						3: valid(3) ?? toolShapes[3]
					};
				}
			} catch {
				// ignore malformed JSON
			}
			const ct = localStorage.getItem('tabutabu.chordType');
			if (ct && CHORD_TYPES.some((c) => c.id === ct)) chordTypeId = ct;
			const cv = Number(localStorage.getItem('tabutabu.chordVoicing'));
			if (Number.isInteger(cv) && cv >= 0) chordVoicingIdx = cv;
			const cs = Number(localStorage.getItem('tabutabu.chordStrings'));
			if (cs >= 2 && cs <= STRING_COUNT) chordStrings = cs;
			const ap = localStorage.getItem('tabutabu.arpPattern');
			if (ap === 'up' || ap === 'updown' || ap === 'down' || ap === 'downup') arpPattern = ap;
			const al = Number(localStorage.getItem('tabutabu.arpLength'));
			if (Number.isInteger(al) && al >= 0 && al <= 64) arpLength = al;
			const sv = Number(localStorage.getItem('tabutabu.sweepVariation'));
			if (Number.isInteger(sv) && sv >= 0) sweepVariation = sv;
			const sp = localStorage.getItem('tabutabu.sweepPattern');
			if (sp && SWEEP_PATTERNS.some((p) => p.id === sp)) sweepPatternId = sp;
			const sl = Number(localStorage.getItem('tabutabu.sweepLoops'));
			if (Number.isInteger(sl) && sl >= 1 && sl <= 16) sweepLoops = sl;
			reuseLastFret = localStorage.getItem('tabutabu.reuseLastFret') !== '0';
			shortcutsOpen = localStorage.getItem('tabutabu.shortcutsOpen') !== '0';
			const rs = Number(localStorage.getItem('tabutabu.refScale'));
			if (rs >= 0.25 && rs <= 1) refScale = rs;
			if (localStorage.getItem('tabutabu.refView') === 'spectrogram') refView = 'spectrogram';
			const savedSource = localStorage.getItem('tabutabu.spectroChannel');
			if (savedSource === 'sides' || (savedSource && isStem(savedSource))) {
				spectroChannel = savedSource;
			}
			const savedStyle = localStorage.getItem('tabutabu.spectroStyle');
			if (savedStyle === 'spectrum' || savedStyle === 'plain') spectroStyle = savedStyle;
			const savedListen = localStorage.getItem('tabutabu.listenChannel');
			if (savedListen === 'left' || savedListen === 'right') listenChannel = savedListen;
			// Grid (incl. triplets). Unknown values fall back to the default.
			const gs = Number(localStorage.getItem('tabutabu.gridStep'));
			if ((GRID_STEPS as readonly number[]).includes(gs)) gridStep = gs as GridStep;
		} catch {
			// ignore
		}

		// If the last session was in author mode, restore the author tab
		// instead of auto-loading the previously-saved MIDI file — a fresh
		// author session shouldn't get clobbered by an old file just because
		// the page reloaded. Also restore the playback focus (bar / beat) so
		// the playhead reappears where the user left it.
		//
		// IMPORTANT: read every localStorage key BEFORE the first `await` in
		// this block. Between an `await` and its continuation, Svelte's
		// persistence effects fire — with the initial default state — and
		// overwrite localStorage. Reading these keys after an await would
		// return the just-written defaults (bar 0, beat 0).
		try {
			const savedMode = localStorage.getItem('tabutabu.mode');
			const savedBarRaw = localStorage.getItem('tabutabu.authorFocusBar');
			const savedBeatRaw = localStorage.getItem('tabutabu.authorFocusBeat');
			const authorTab = (await idbGet('authorTab')) as Tab | undefined;
			if (savedMode === 'author' && authorTab) {
				mode = 'author';
				tab = authorTab;
				history = makeHistory();
				fileName = null;
				const beats = authorTab.timeSignature[0];
				const savedBar = Number(savedBarRaw);
				const savedBeat = Number(savedBeatRaw);
				const barIdx = Number.isFinite(savedBar) ? Math.max(0, Math.floor(savedBar)) : 0;
				const beatIdx = Number.isFinite(savedBeat)
					? Math.max(0, Math.min(beats, Math.floor(savedBeat)))
					: 0;
				authorFocus = { barIdx, beatIdx };
				const secondsPerBeat = authorTab.secondsPerBar / beats;
				currentTime =
					beatIdx === 0
						? barIdx * authorTab.secondsPerBar
						: barIdx * authorTab.secondsPerBar + (beatIdx - 1) * secondsPerBeat;
			} else {
				const saved = (await idbGet('lastFile')) as
					{ name: string; buffer: ArrayBuffer; isDawproject: boolean } | undefined;
				if (saved?.buffer) {
					await loadFileFromBuffer(saved.buffer, saved.name, false);
				}
			}
		} catch {
			// ignore
		}

		// A share link (#tab= / #gist=) opens on top of whatever was just
		// restored, asking first if that would replace a tab being edited.
		// Pasting another link into the address bar only changes the hash,
		// so listen for that too.
		await openFromHash();
		window.addEventListener('hashchange', () => void openFromHash());

		try {
			const savedVideo = (await idbGet('lastVideo')) as
				{ name: string; buffer: ArrayBuffer; type: string } | undefined;
			if (savedVideo?.buffer) {
				const blob = new Blob([savedVideo.buffer], { type: savedVideo.type });
				videoUrl = URL.createObjectURL(blob);
				videoFileName = savedVideo.name;
				setReferenceAudio(savedVideo.buffer, savedVideo.type, savedVideo.name);
			}
		} catch {
			// ignore
		}

		try {
			const savedPort = localStorage.getItem('tabutabu.syncPort');
			if (savedPort) {
				syncSelectedPort = savedPort;
				await refreshSyncPorts();
				const still = syncPorts.some((p) => p.id === savedPort);
				if (still) {
					syncSelectedPort = savedPort;
					await syncConnect();
				}
			}
		} catch {
			// ignore
		}

		// Ask the dev server which ffmpeg encoders it has. If the saved encoder
		// isn't available, fall back to the first one that is (preferring
		// hardware NVENC over software x264/x265).
		try {
			const res = await fetch('/api/export');
			if (res.ok) {
				const data = (await res.json()) as { ok: boolean; encoders: string[] };
				availableEncoders = data.encoders ?? [];
				if (!availableEncoders.includes(exportEncoder)) {
					const preferred = [
						'h264_nvenc',
						'hevc_nvenc',
						'av1_nvenc',
						'libx264',
						'libx265'
					] as const;
					const pick = preferred.find((e) => availableEncoders.includes(e));
					if (pick) exportEncoder = pick;
				}
			}
		} catch {
			// ffmpeg not on PATH — leave encoder as saved and let the request fail with a clear error.
		}
	});

	// Persist settings on change. Each effect writes one key, so a single
	// toggle only touches its own storage entry.
	const put = (k: string, v: string) => {
		try {
			localStorage.setItem(k, v);
		} catch {
			// storage full or blocked
		}
	};
	$effect(() => put('tabutabu.metronomeOn', metronomeOn ? '1' : '0'));
	$effect(() => put('tabutabu.metronomeVol', String(metronomeVol)));
	$effect(() => put('tabutabu.syncOffsetMs', String(syncOffsetMs)));
	$effect(() => put('tabutabu.keepLeadingSilence', keepLeadingSilence ? '1' : '0'));
	$effect(() => put('tabutabu.preservePositionOnStart', preservePositionOnStart ? '1' : '0'));
	$effect(() => put('tabutabu.syncDebug', syncDebug ? '1' : '0'));
	$effect(() => put('tabutabu.videoOffsetSec', String(videoOffsetSec)));
	$effect(() => put('tabutabu.videoAudioOn', videoAudioOn ? '1' : '0'));
	$effect(() => put('tabutabu.tabPositionOnVideo', tabPositionOnVideo));
	$effect(() => put('tabutabu.tabSizePercent', String(tabSizePercent)));
	$effect(() => put('tabutabu.tabPaddingPercent', String(tabPaddingPercent)));
	$effect(() => put('tabutabu.exportFps', String(exportFps)));
	$effect(() => put('tabutabu.exportEncoder', exportEncoder));
	$effect(() => put('tabutabu.mode', mode));
	$effect(() => put('tabutabu.currentTool', String(currentTool)));
	$effect(() => put('tabutabu.toolVariants', JSON.stringify(toolVariants)));
	$effect(() => put('tabutabu.toolShapes', JSON.stringify(toolShapes)));
	$effect(() => put('tabutabu.chordType', chordTypeId));
	$effect(() => put('tabutabu.chordVoicing', String(chordVoicingIdx)));
	$effect(() => put('tabutabu.chordStrings', String(chordStrings)));
	$effect(() => put('tabutabu.arpPattern', arpPattern));
	$effect(() => put('tabutabu.arpLength', String(arpLength)));
	$effect(() => put('tabutabu.sweepVariation', String(sweepVariation)));
	$effect(() => put('tabutabu.sweepPattern', sweepPatternId));
	$effect(() => put('tabutabu.sweepLoops', String(sweepLoops)));
	$effect(() => put('tabutabu.reuseLastFret', reuseLastFret ? '1' : '0'));
	$effect(() => put('tabutabu.gridStep', String(gridStep)));
	$effect(() => put('tabutabu.shortcutsOpen', shortcutsOpen ? '1' : '0'));
	$effect(() => put('tabutabu.refScale', String(refScale)));
	$effect(() => put('tabutabu.refView', refView));
	$effect(() => put('tabutabu.spectroChannel', spectroChannel));
	$effect(() => put('tabutabu.listenChannel', listenChannel));
	$effect(() => put('tabutabu.spectroStyle', spectroStyle));
	$effect(() => put('tabutabu.videoVolume', String(videoVolume)));
	// Persist author-mode playback focus so the playhead / focus band don't
	// reset to bar 1 every time the page reloads.
	$effect(() => {
		void authorFocus;
		put('tabutabu.authorFocusBar', String(authorFocus.barIdx));
		put('tabutabu.authorFocusBeat', String(authorFocus.beatIdx));
	});
	// Autosave the author-mode tab to IndexedDB so a refresh doesn't clobber
	// a fresh session with the previously-loaded MIDI file.
	$effect(() => {
		void tab;
		if (mode !== 'author' || !tab) return;
		void idbSet('authorTab', $state.snapshot(tab)).catch(() => {});
	});
	$effect(() => put('tabutabu.playheadStyle', playheadStyle));
	$effect(() => put('tabutabu.theme', theme));
	$effect(() => put('tabutabu.stringFlashEnabled', stringFlashEnabled ? '1' : '0'));
	$effect(() => put('tabutabu.tuningKey', tuningKey));
	// Persist per-file string overrides and hammer/pull annotations. Skipped
	// when there's no file loaded, and while a file is actively being loaded
	// (so we don't overwrite the saved data with the transient empty state).
	$effect(() => {
		void overrides;
		if (!fileName || suppressPerFilePersist) return;
		const snap = { ...overrides };
		void idbSet(`overrides:${fileName}`, snap).catch(() => {});
	});
	$effect(() => {
		void annotations;
		if (!fileName || suppressPerFilePersist) return;
		const snap = { ...annotations };
		void idbSet(`annotations:${fileName}`, snap).catch(() => {});
	});

	function clearSavedFile() {
		void idbDel('lastFile');
	}

	// Global keyboard shortcuts. Registered on `keydown` with capture so a focused
	// range slider or button can't swallow space/arrows before we handle them —
	// which is what would otherwise trigger the control instead of play/pause.
	onMount(() => {
		const onKey = (e: KeyboardEvent) => {
			// Never intercept when the user is typing into an actual text field.
			const el = e.target as HTMLElement | null;
			const tag = el?.tagName;
			const type = (el as HTMLInputElement | null)?.type;
			const isTextField =
				(tag === 'INPUT' &&
					type &&
					!['range', 'checkbox', 'radio', 'file', 'button'].includes(type)) ||
				tag === 'TEXTAREA' ||
				el?.isContentEditable;
			if (isTextField) return;

			// Esc closes an open menu / overlay; ? toggles the shortcut sheet.
			if (e.key === 'Escape' && (openMenu || showFileDetails || showExportResult)) {
				e.preventDefault();
				openMenu = null;
				showFileDetails = false;
				showExportResult = false;
				return;
			}
			if (e.key === '?') {
				e.preventDefault();
				shortcutsOpen = !shortcutsOpen;
				return;
			}

			// Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y — undo/redo. Works whenever a
			// tab is loaded; no-op if the history stack is empty. Not
			// gated to author mode so the shortcut behaves the same
			// everywhere.
			if ((e.ctrlKey || e.metaKey) && !e.altKey) {
				// Commit a held B/S/V first so undo/redo never races the
				// live (uncommitted) articulation.
				if (artHold) endArtHold();
				// Letters match the typed character (e.key), not the physical
				// key position, so shortcuts follow the user's keyboard layout.
				const ck = e.key.toLowerCase();
				if (ck === 'z' && !e.shiftKey) {
					e.preventDefault();
					handleUndo();
					return;
				}
				if ((ck === 'z' && e.shiftKey) || ck === 'y') {
					e.preventDefault();
					handleRedo();
					return;
				}
				// Ctrl+←/→ (power-chord tools) — previous / next shape.
				if (
					(e.code === 'ArrowLeft' || e.code === 'ArrowRight') &&
					mode === 'author' &&
					(currentTool === 2 || currentTool === 3)
				) {
					e.preventDefault();
					cycleShape(e.code === 'ArrowRight' ? 1 : -1);
					return;
				}
				// Chord / arp / sweep tools: Ctrl+←/→ chord type, Ctrl+↑/↓
				// string count.
				if (
					mode === 'author' &&
					(isChordTool() || currentTool === 6) &&
					e.code.startsWith('Arrow')
				) {
					e.preventDefault();
					const act = currentTool === 6 ? sweepAction : chordAction;
					if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
						act({ kind: 'type', dir: e.code === 'ArrowRight' ? 1 : -1 });
					} else {
						act({ kind: 'strings', dir: e.code === 'ArrowUp' ? 1 : -1 });
					}
					return;
				}
				// Ctrl+Space (author mode) — play through the whole song
				// from the current playhead, ignoring the bar/beat focus.
				if (e.code === 'Space' && mode === 'author') {
					e.preventDefault();
					authorPlayThrough();
					return;
				}
				return;
			}
			if (e.altKey) return;

			// Author-mode-only keys.
			if (mode === 'author') {
				// Tool selector (1-6 and 0). Pressing the same digit that's
				// already active toggles the palm-mute variant.
				// Typed digit first (layout-aware, includes the numpad); fall
				// back to the physical number row for layouts like AZERTY where
				// the unshifted number row types symbols.
				const digitChar = /^[0-6]$/.test(e.key)
					? e.key
					: /^Digit[0-6]$/.test(e.code)
						? e.code.slice(5)
						: null;
				if (digitChar !== null) {
					e.preventDefault();
					const digit = Number(digitChar) as Tool;
					if (e.shiftKey) {
						// Shift+number: select the tool with its default settings.
						resetTool(digit);
						currentTool = digit;
					} else if (currentTool === digit) {
						// Same-tool retap → toggle THIS tool's variant.
						const cur = toolVariants[digit] ?? 'normal';
						toolVariants = {
							...toolVariants,
							[digit]: cur === 'palmMute' ? 'normal' : 'palmMute'
						};
					} else {
						// Switch tool. The other tool's variant is preserved.
						currentTool = digit;
					}
					return;
				}
				// The key left of 1 (Backquote position: § on Nordic layouts, ` on
				// US) toggles "reuse fret": new notes start on the last fret used
				// on that string, or on the tool's default (0, or 12 for sweeps).
				if (e.code === 'Backquote') {
					e.preventDefault();
					if (!e.repeat) reuseLastFret = !reuseLastFret;
					return;
				}
				// Chord / arp / sweep tools: the two keys left of right Shift
				// (physical . and /) step to the previous / next variation —
				// easier to reach than Shift + the top row.
				if (
					(e.code === 'Period' || e.code === 'Slash') &&
					(isChordTool() || currentTool === 6) &&
					!artHold
				) {
					e.preventDefault();
					const act = currentTool === 6 ? sweepAction : chordAction;
					act({ kind: 'variation', dir: e.code === 'Slash' ? 1 : -1 });
					return;
				}
				// Chord tool: the top letter row picks a chord type (Shift: a
				// variation). Physical positions (e.code), not letters, so the
				// row is the same keys on any layout. Takes precedence over
				// any hover keys on that row (R let ring / T tap on QWERTY).
				const rowIdx = TOP_ROW_CODES.indexOf(e.code);
				if ((isChordTool() || currentTool === 6) && rowIdx >= 0 && !artHold) {
					e.preventDefault();
					if (!e.repeat) {
						const act = currentTool === 6 ? sweepAction : chordAction;
						act(
							e.shiftKey
								? { kind: 'variationAt', index: rowIdx }
								: { kind: 'typeAt', index: rowIdx }
						);
					}
					return;
				}
				// Hover-key articulations on the note under the cursor. Key
				// repeat is swallowed so holding B/S/V doesn't re-toggle.
				const k = e.key.toLowerCase();
				if (pmPaint) {
					if (k === 'm' || k === 'r' || e.code === pmPaint.code) e.preventDefault();
					if (e.code === pmPaint.code) return;
				}
				if (
					(k === 'm' || k === 'r') &&
					hoverPos &&
					!authorGesture &&
					!artHold &&
					!pmPaint &&
					tab &&
					!e.repeat
				) {
					const hit = findColumnNoteAt(hoverPos);
					if (hit) {
						e.preventDefault();
						startPmPaint(k, hit, e.code);
						return;
					}
				}
				if (/^[bghmnrstv]$/.test(k) && hoverPos && !authorGesture && tab) {
					if (artHold || e.repeat) {
						e.preventDefault();
						return;
					}
					const hit = findAuthorNoteAt(hoverPos);
					if (hit) {
						e.preventDefault();
						if (k === 'b' || k === 's' || k === 'v' || k === 'n') {
							beginArtHold(k, hit, e.code);
						} else {
							toggleArticulationKey(k, hit);
						}
						return;
					}
				}
				// Grid subdivision — PgUp finer, PgDn coarser, staying within
				// straight or triplet grids (the Triplets button switches).
				if (e.code === 'PageUp' || e.code === 'PageDown') {
					e.preventDefault();
					// Shift+PgDn: triplets on / off.
					if (e.code === 'PageDown' && e.shiftKey) {
						toggleTriplets();
						return;
					}
					const family = GRID_STEPS.filter((g) => (g % 3 === 0) === tripletGrid);
					const idx = family.indexOf(gridStep);
					if (e.code === 'PageUp' && idx < family.length - 1) {
						gridStep = family[idx + 1];
					} else if (e.code === 'PageDown' && idx > 0) {
						gridStep = family[idx - 1];
					}
					return;
				}
			}

			if (e.code === 'Space' && e.shiftKey && mode === 'author') {
				e.preventDefault();
				void authorPlayThroughStem();
				return;
			}
			if (e.code === 'Space') {
				e.preventDefault();
				if (mode === 'author') authorTogglePlay();
				else togglePlay();
			} else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
				if (!tab) return;
				e.preventDefault();
				const dir: 1 | -1 = e.code === 'ArrowRight' ? 1 : -1;
				if (mode === 'author' && currentTool === 4 && e.shiftKey) {
					// Chord tool: Shift+←/→ steps the chord's variation.
					chordAction({ kind: 'variation', dir });
					return;
				}
				if (mode === 'author' && currentTool === 5 && e.shiftKey) {
					// Arp tool: Shift+←/→ one note fewer / more.
					arpAction({ kind: 'length', dir });
					return;
				}
				if (mode === 'author' && currentTool === 6 && e.shiftKey) {
					// Sweep tool: Shift+←/→ one loop fewer / more.
					sweepAction({ kind: 'loops', dir });
					return;
				}
				if (mode === 'author') {
					// Arrows always walk the play focus in author mode —
					// moving notes with the keyboard was too easy to trigger
					// by accident; shift+drag handles that instead.
					authorAdvanceFocus(dir);
					return;
				}
				const beatSec = tab.secondsPerBar / tab.timeSignature[0];
				const step = e.shiftKey ? beatSec * tab.timeSignature[0] : beatSec;
				seekBy(dir * step);
			} else if (mode === 'author' && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
				if (!tab) return;
				e.preventDefault();
				if (currentTool === 5 && e.shiftKey) {
					// Arp tool: Shift+↑ ascending / Shift+↓ descending.
					arpAction({ kind: e.code === 'ArrowUp' ? 'up' : 'down' });
					return;
				}
				if (currentTool === 6 && e.shiftKey) {
					// Sweep tool: Shift+↓ next pattern, Shift+↑ previous.
					sweepAction({ kind: 'pattern', dir: e.code === 'ArrowDown' ? 1 : -1 });
					return;
				}
				// Down = next bar (whole-bar focus), Up = previous bar.
				const delta = e.code === 'ArrowDown' ? 1 : -1;
				const nextBar = Math.max(0, authorFocus.barIdx + delta);
				authorFocus = { barIdx: nextBar, beatIdx: 0 };
				syncPlayheadToFocus();
			}
		};
		// Releasing a held articulation key (or losing focus while holding
		// it) commits the adjusted value.
		const onKeyUp = (e: KeyboardEvent) => {
			// Matched on the physical key recorded at press time, so the
			// release is caught even if Shift changes the typed character.
			if (artHold && e.code === artHold.code) endArtHold();
			if (pmPaint && e.code === pmPaint.code) endPmPaint();
		};
		const onBlur = () => {
			if (artHold) endArtHold();
			if (pmPaint) endPmPaint();
		};
		window.addEventListener('keydown', onKey, { capture: true });
		window.addEventListener('keyup', onKeyUp, { capture: true });
		window.addEventListener('blur', onBlur);
		return () => {
			window.removeEventListener('keydown', onKey, { capture: true });
			window.removeEventListener('keyup', onKeyUp, { capture: true });
			window.removeEventListener('blur', onBlur);
		};
	});

	// rAF loop drives both `currentTime` advancement and canvas repaints.
	onMount(() => {
		let last = performance.now();
		let raf = 0;
		// The drawing context is looked up each frame (cheap: the same object
		// for the same canvas) so a re-created canvas element — e.g. after a
		// hot reload — is drawn into instead of a detached old one.

		const config = { ...DEFAULT_RENDER_CONFIG };

		// Resize a canvas so its internal pixel buffer matches the display size
		// times the device pixel ratio. Prevents the "blurry when moving" look
		// caused by CSS scaling the canvas from a fixed 1280×260 buffer to the
		// container width. Returns the CSS width/height in logical pixels for
		// the caller to use as render config dimensions.
		function fitCanvasToDisplay(c: HTMLCanvasElement): { w: number; h: number; dpr: number } {
			const dpr = window.devicePixelRatio || 1;
			const cssW = c.clientWidth || c.width / dpr;
			const cssH = c.clientHeight || c.height / dpr;
			const targetW = Math.round(cssW * dpr);
			const targetH = Math.round(cssH * dpr);
			if (c.width !== targetW || c.height !== targetH) {
				c.width = targetW;
				c.height = targetH;
			}
			return { w: cssW, h: cssH, dpr };
		}

		const loop = (now: number) => {
			const dt = (now - last) / 1000;
			last = now;
			if (playing && tab) {
				const songT = audioOn ? synth.currentSongTime() : null;
				if (songT !== null) {
					currentTime = songT;
					lastSeekTime = songT;
				} else {
					currentTime += dt;
				}
				// End-of-tab stop. Skipped while an author-mode focus
				// preview is active: the focus range has its own stop below,
				// and the focus may legitimately sit past the tab's current
				// end (e.g. you navigated into empty bars to start writing).
				if (authorPlayStopAt === null && currentTime >= effectiveDurationSec) {
					currentTime = effectiveDurationSec;
					playing = false;
					synth.stop();
				}
				// Author mode: auto-stop at the bar/beat boundary when the
				// user hit space for a preview. Snap the playhead BACK to
				// the start of the focused range so the visible page doesn't
				// shift to the next bar just because playback ran to its end.
				if (authorPlayStopAt !== null && currentTime >= authorPlayStopAt) {
					playing = false;
					synth.stop();
					if (videoElement) {
						videoElement.pause();
						lastVideoPlayCommand = 'pause';
					}
					const { start } = authorFocusRange();
					currentTime = start;
					authorPlayStopAt = null;
				}
			}
			const ctx = canvas?.getContext('2d');
			if (!ctx) {
				raf = requestAnimationFrame(loop);
				return;
			}
			const { w: cssW, h: cssH, dpr } = fitCanvasToDisplay(canvas);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			config.width = cssW;
			config.height = cssH;
			config.mode = renderMode;
			config.playheadStyle = playheadStyle;
			config.theme = theme;
			config.stringFlashEnabled = stringFlashEnabled;
			config.pixelsPerSecond = pixelsPerSecond;
			config.barsPerPage = barsPerPage;
			config.peekBeats = peekBeats;
			config.showNoteLengths = showNoteLengths;
			if (tab) {
				// During an author-mode drag, draw the tab with the drag applied.
				const shown = (mode === 'author' && gesturePreviewTab()) || tab;
				renderTabFrame(ctx, shown, TUNINGS[tuningKey], currentTime, config);
				if (mode === 'author') {
					drawAuthorOverlay(ctx, cssW, cssH, config);
					if (showSpectrogram && spectroCanvas) drawSpectrogramView(spectroCanvas);
				}
			} else {
				ctx.fillStyle = '#0b0f14';
				ctx.fillRect(0, 0, cssW, cssH);
			}
			drawTimeline();
			syncVideo();
			syncStem();
			drawComposite();
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	});
</script>

<div class="app" class:author={mode === 'author'}>
	<!-- Menu bar: every setting lives in a dropdown, so the page itself is just
	the reference video and the tab. -->
	<header class="menubar">
		<span class="brand">Tabutabu</span>
		<nav class="menus">
			<div class="menu">
				<button class:open={openMenu === 'file'} onclick={() => toggleMenu('file')}>File</button>
				{#if openMenu === 'file'}
					<div class="menu-panel">
						<label class="menu-item file-pick">
							<span class="i-lucide-file-music"></span>
							<span>Open MIDI / .dawproject…</span>
							<input
								type="file"
								accept=".mid,.midi,.dawproject,audio/midi"
								onchange={(e) => {
									openMenu = null;
									onFile(e);
								}}
							/>
						</label>
						{#if fileName}
							<button
								class="menu-item"
								title="Clear the auto-loaded file from browser storage"
								onclick={() => {
									clearSavedFile();
									fileName = null;
									tab = null;
									midiBuffer = null;
									openMenu = null;
								}}
							>
								<span class="i-lucide-x"></span><span>Forget saved file</span>
							</button>
							{#if Object.keys(overrides).length > 0}
								<button
									class="menu-item"
									title="Remove all drag-reassigned string overrides for this file"
									onclick={() => {
										clearOverrides();
										openMenu = null;
									}}
								>
									<span class="i-lucide-x"></span>
									<span>Clear {Object.keys(overrides).length} string overrides</span>
								</button>
							{/if}
						{/if}
						<div class="menu-sep"></div>
						<label
							class="menu-item file-pick"
							title="A video or audio file to sync the tab against (mp4, webm, mp3, wav…)"
						>
							<span class="i-lucide-file-video"></span>
							<span>Open reference video / audio…</span>
							<input
								type="file"
								accept="video/*,audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac"
								onchange={(e) => {
									openMenu = null;
									onVideoFile(e);
								}}
							/>
						</label>
						{#if videoFileName}
							<button
								class="menu-item"
								onclick={() => {
									clearVideo();
									openMenu = null;
								}}
							>
								<span class="i-lucide-x"></span><span>Close reference ({videoFileName})</span>
							</button>
						{/if}
						<div class="menu-sep"></div>
						<button
							class="menu-item"
							title="Discard the current tab and start a new authoring session (BPM / time-sig / tuning / bars)"
							onclick={() => {
								openMenu = null;
								mode = 'author';
								openNewTabDialog();
							}}
						>
							<span class="i-lucide-file-plus"></span><span>New tab…</span>
						</button>
						<button
							class="menu-item"
							disabled={!tab}
							title="Copy a link containing this whole tab. For a shorter link: paste it into a public GitHub gist and share …/#gist=<gist id>."
							onclick={() => {
								openMenu = null;
								copyShareLink();
							}}
						>
							<span class="i-lucide-link"></span><span>Copy share link</span>
						</button>
					</div>
				{/if}
			</div>

			<div class="menu">
				<button class:open={openMenu === 'view'} onclick={() => toggleMenu('view')}>View</button>
				{#if openMenu === 'view'}
					<div class="menu-panel form">
						<label>
							<span>Layout</span>
							<select bind:value={renderMode}>
								<option value="page">Page (playhead moves)</option>
								<option value="scroll">Scroll (tab moves)</option>
							</select>
						</label>
						<label>
							<span>Bars / {renderMode === 'page' ? 'page' : 'view'}</span>
							<input type="range" min="1" max="8" step="1" bind:value={barsPerPage} />
							<span class="mono">{barsPerPage}</span>
						</label>
						<label>
							<span>Peek (beats)</span>
							<input type="range" min="0" max="4" step="0.5" bind:value={peekBeats} />
							<span class="mono">{peekBeats}</span>
						</label>
						<label
							title="How to visualise the current position. Beat/Bar look cleaner in screen recordings because they only step on beat/bar boundaries."
						>
							<span>Playhead</span>
							<select bind:value={playheadStyle}>
								<option value="line">Line (smooth)</option>
								<option value="beat">Beat column (stepped)</option>
								<option value="bar">Bar column (stepped)</option>
							</select>
						</label>
						<label>
							<span>Theme</span>
							<select bind:value={theme}>
								<option value="dark">Dark</option>
								<option value="light">Light (white bg / black text)</option>
							</select>
						</label>
						<label
							class="check"
							title="Flash the whole string line when a note plays. Off by default because it can pull the eye away from the fret numbers."
						>
							<input type="checkbox" bind:checked={stringFlashEnabled} />
							<span>String flash</span>
						</label>
						<label class="check">
							<input type="checkbox" bind:checked={showNoteLengths} />
							<span>Show note lengths</span>
						</label>
						<label
							title="Author mode: reference video width as a share of the tab width. Smaller moves the tab up toward the middle."
						>
							<span>Reference size</span>
							<input type="range" min="0.25" max="1" step="0.05" bind:value={refScale} />
							<span class="mono">{Math.round(refScale * 100)}%</span>
						</label>
					</div>
				{/if}
			</div>

			<div class="menu">
				<button class:open={openMenu === 'tab'} onclick={() => toggleMenu('tab')}>Tab</button>
				{#if openMenu === 'tab'}
					<div class="menu-panel form">
						<label>
							<span>Tuning</span>
							<select bind:value={tuningKey}>
								{#each Object.entries(TUNINGS) as [key, t] (key)}
									<option value={key}>{t.name}</option>
								{/each}
							</select>
						</label>
						<label
							class="check"
							title="Off by default; enable only for non-MPE MIDI where you're using channels 1–6 to pin strings."
						>
							<input type="checkbox" bind:checked={honorChannelStrings} />
							<span>MIDI channel → string (1 = low E, 6 = high E)</span>
						</label>
						<div class="menu-sep"></div>
						<button
							class="menu-item"
							disabled={!tab}
							onclick={() => {
								openMenu = null;
								showFileDetails = true;
							}}
						>
							<span class="i-lucide-info"></span><span>File details…</span>
						</button>
					</div>
				{/if}
			</div>

			<div class="menu">
				<button class:open={openMenu === 'sync'} onclick={() => toggleMenu('sync')}>
					Sync
					{#if syncConnected}<span class="dot on" title="listening"></span>{/if}
				</button>
				{#if openMenu === 'sync'}
					<div class="menu-panel form">
						<p class="menu-note">
							Follow a DAW's MIDI clock (Start / Stop / Continue / Song Position). The tab still
							comes from the file; this only drives play / pause / seek.
						</p>
						<label>
							<span>MIDI in</span>
							<select bind:value={syncSelectedPort} disabled={syncConnected}>
								{#each syncPorts as p (p.id)}
									<option value={p.id}
										>{p.name}{p.manufacturer ? ` — ${p.manufacturer}` : ''}</option
									>
								{/each}
								{#if syncPorts.length === 0}
									<option value="">(no ports — install loopMIDI / IAC)</option>
								{/if}
							</select>
						</label>
						<div class="menu-row">
							<button onclick={refreshSyncPorts} disabled={syncConnected}>Refresh</button>
							{#if !syncConnected}
								<button onclick={syncConnect} disabled={!syncSelectedPort}>Connect</button>
							{:else}
								<button onclick={syncDisconnect}>Disconnect</button>
							{/if}
							<span class="hint">
								{#if syncError}
									<span class="err">{syncError}</span>
								{:else if syncConnected}
									● listening
								{:else}
									○ idle
								{/if}
							</span>
						</div>
						<label
							title="Positive value shifts the playhead forward on every Start/Seek. Compensates for loopMIDI + browser event-delivery latency (typically 10–30 ms)."
						>
							<span>Offset (ms)</span>
							<input
								type="number"
								min="-500"
								max="500"
								step="1"
								bind:value={syncOffsetMs}
								style="width:70px"
							/>
						</label>
						<label
							class="check"
							title="Preserve leading silence in the file so song time 0 = DAW bar 1 beat 1."
						>
							<input type="checkbox" bind:checked={keepLeadingSilence} />
							<span>Keep leading silence</span>
						</label>
						<label
							class="check"
							title="Treat MIDI Start as 'resume from current position' instead of 'reset to 0'."
						>
							<input type="checkbox" bind:checked={preservePositionOnStart} />
							<span>Preserve position on Start</span>
						</label>
						<label
							class="check"
							title="Log Start / Stop / Continue / SPP messages to the DevTools console."
						>
							<input type="checkbox" bind:checked={syncDebug} />
							<span>Log MIDI sync</span>
						</label>
					</div>
				{/if}
			</div>

			<div class="menu">
				<button class:open={openMenu === 'export'} onclick={() => toggleMenu('export')}>
					Export
				</button>
				{#if openMenu === 'export'}
					<div class="menu-panel form">
						{#if !videoUrl}
							<p class="menu-note">Open a reference video first (File → Open reference).</p>
						{/if}
						<label>
							<span>Tab position</span>
							<select bind:value={tabPositionOnVideo} disabled={isExporting || !videoUrl}>
								<option value="bottom">Bottom (overlay)</option>
								<option value="top">Top (overlay)</option>
								<option value="extend-below">Extend video (tab below)</option>
								<option value="extend-above">Extend video (tab above)</option>
								<option value="crop-top-bottom">Crop top → tab bottom (keeps source aspect)</option>
							</select>
						</label>
						<label>
							<span>Tab size</span>
							<input
								type="range"
								min="30"
								max="100"
								step="1"
								bind:value={tabSizePercent}
								disabled={isExporting || !videoUrl}
							/>
							<span class="mono">{tabSizePercent}%</span>
						</label>
						<label>
							<span>Padding</span>
							<input
								type="range"
								min="0"
								max="10"
								step="0.5"
								bind:value={tabPaddingPercent}
								disabled={isExporting || !videoUrl}
							/>
							<span class="mono">{tabPaddingPercent}%</span>
						</label>
						<label
							title="Which local ffmpeg encoder to use. NVENC variants run on the GPU — much faster on NVIDIA cards."
						>
							<span>Encoder</span>
							<select bind:value={exportEncoder} disabled={isExporting || !videoUrl}>
								{#if availableEncoders.length === 0}
									<option value="h264_nvenc">h264_nvenc</option>
									<option value="hevc_nvenc">hevc_nvenc</option>
									<option value="av1_nvenc">av1_nvenc</option>
									<option value="libx264">libx264 (CPU)</option>
									<option value="libx265">libx265 (CPU)</option>
								{:else}
									{#each availableEncoders as enc (enc)}
										<option value={enc}>{enc}{enc.endsWith('_nvenc') ? ' (GPU)' : ' (CPU)'}</option>
									{/each}
								{/if}
							</select>
						</label>
						<div class="menu-row">
							{#if !isExporting}
								<button class="primary" onclick={startExport} disabled={!tab || !videoUrl}>
									<span class="i-lucide-download"></span> Export video
								</button>
							{:else if exportStage === 'encoding'}
								<button disabled>Uploading job…</button>
							{:else if exportStage === 'finalizing'}
								<button disabled>Rendering + encoding on server…</button>
							{/if}
							{#if exportResultUrl}
								<button
									onclick={() => {
										openMenu = null;
										showExportResult = true;
									}}>Last export…</button
								>
							{/if}
						</div>
						{#if exportError}
							<span class="err">{exportError}</span>
						{/if}
					</div>
				{/if}
			</div>

			<div class="menu">
				<button class:open={openMenu === 'help'} onclick={() => toggleMenu('help')}>Help</button>
				{#if openMenu === 'help'}
					<div class="menu-panel">
						<button
							class="menu-item"
							onclick={() => {
								openMenu = null;
								shortcutsOpen = true;
							}}
						>
							<span class="i-lucide-keyboard"></span><span>Keyboard shortcuts</span>
							<span class="menu-key">?</span>
						</button>
					</div>
				{/if}
			</div>
		</nav>
		<span class="grow"></span>
		{#if isExporting}
			<span class="status-chip" title="Export in progress">
				<span class="i-lucide-download"></span> exporting…
			</span>
		{/if}
		<div class="mode-toggle">
			<button
				class:on={mode === 'view'}
				onclick={() => (mode = 'view')}
				title="Read a MIDI / .dawproject file and render it as a tab"
			>
				View
			</button>
			<button
				class:on={mode === 'author'}
				onclick={enterAuthorMode}
				title="Compose a tab from scratch on top of a reference video / audio file"
			>
				Author
			</button>
		</div>
	</header>

	{#if mode === 'author'}
		<!-- One compact row: tools, grid, editing helpers. -->
		<div class="toolbar">
			<div class="tool-group">
				{#each [1, 2, 3, 4, 5, 6, 0] as n (n)}
					{@const t = { n }}
					<button
						class="icon-btn tool-btn"
						class:on={currentTool === t.n}
						class:pm={(toolVariants[t.n as Tool] ?? 'normal') === 'palmMute'}
						onclick={(ev) => {
							const tn = t.n as Tool;
							if (ev.shiftKey) {
								resetTool(tn);
								currentTool = tn;
							} else if (currentTool === tn) {
								const cur = toolVariants[tn] ?? 'normal';
								toolVariants = {
									...toolVariants,
									[tn]: cur === 'palmMute' ? 'normal' : 'palmMute'
								};
							} else {
								currentTool = tn;
							}
						}}
						title={`${t.n} · ${TOOL_NAMES[t.n as Tool]}${currentTool === t.n ? ' (press again for palm mute)' : ''} · Shift+${t.n} / Shift+click: reset to defaults`}
					>
						<!-- Icon classes written out literally: UnoCSS only generates what
						it can see in the markup. -->
						{#if n === 1}<span class="i-lucide-music-2"></span>
						{:else if n === 2}<span class="i-lucide-rows-3"></span>
						{:else if n === 3}<span class="i-lucide-rows-2"></span>
						{:else if n === 4}<span class="i-lucide-layers"></span>
						{:else if n === 5}<span class="i-lucide-signal"></span>
						{:else if n === 6}<span class="i-lucide-activity"></span>
						{:else}<span class="i-lucide-mouse-pointer-2"></span>
						{/if}
						<span class="tool-key">{t.n}</span>
					</button>
				{/each}
			</div>
			<span class="tb-sep"></span>
			<label class="tb-grid" title="Grid subdivision. PgUp = finer, PgDn = coarser.">
				<span class="i-lucide-grid-3x3"></span>
				<select bind:value={gridStep}>
					{#each GRID_STEPS as g (g)}
						<option value={g}>{gridLabel(g)}</option>
					{/each}
				</select>
			</label>
			<button
				class="icon-btn text"
				class:on={tripletGrid}
				onclick={toggleTriplets}
				title="Triplets (Shift+PgDn): switch the grid to its triplet version and back (1/16 ↔ 16th triplets, 6 per beat)"
			>
				3
			</button>
			<button
				class="icon-btn"
				class:on={reuseLastFret}
				onclick={() => (reuseLastFret = !reuseLastFret)}
				title={`Reuse fret (${backquoteKeyLabel}): new notes start on the last fret used on that string. Off: fret 0 (12 for sweeps).`}
			>
				<span class="i-lucide-repeat"></span>
			</button>
			<span class="tb-sep"></span>
			<button
				class="icon-btn"
				onclick={handleUndo}
				disabled={!canUndo(history)}
				title="Undo (Ctrl+Z)"
			>
				<span class="i-lucide-undo-2"></span>
			</button>
			<button
				class="icon-btn"
				onclick={handleRedo}
				disabled={!canRedo(history)}
				title="Redo (Ctrl+Y)"
			>
				<span class="i-lucide-redo-2"></span>
			</button>
			<span class="grow"></span>
			{#if shareStatus}<span class="hint">{shareStatus}</span>{/if}
			<button
				class="icon-btn"
				onclick={copyShareLink}
				disabled={!tab}
				title="Copy share link (whole tab in the URL; for a shorter link, paste it into a public GitHub gist and share …/#gist=<id>)"
			>
				<span class="i-lucide-link"></span>
			</button>
			<button
				class="icon-btn"
				onclick={() => (shortcutsOpen = !shortcutsOpen)}
				title="Keyboard shortcuts (?)"
			>
				<span class="i-lucide-keyboard"></span>
			</button>
		</div>
	{/if}

	<div class="workspace">
		{#if mode === 'author'}
			<!-- The current tool and its keys. Everything else is in the menus
			and the shortcut sheet (?). -->
			<aside class="side-panel">
				<h4>
					<span class="key">{currentTool}</span>
					{TOOL_NAMES[currentTool]}
					{#if (toolVariants[currentTool] ?? 'normal') === 'palmMute'}
						<span class="pm-badge" title="Palm-mute variant (press the tool key again to toggle)"
							>PM</span
						>
					{/if}
				</h4>
				<!-- One key per row: key on the left, what it does on the right. -->
				<dl class="keys">
					{#if currentTool === 1}
						<dt>Click</dt>
						<dd>place a note</dd>
						<dt>Drag ←/→</dt>
						<dd>fret</dd>
						<dt>Drag ↑/↓</dt>
						<dd>octave</dd>
						<dt>Drag a note</dt>
						<dd>change its fret</dd>
					{:else if currentTool === 2 || currentTool === 3}
						<dt>Click</dt>
						<dd>place a {currentTool === 2 ? '3' : '2'}-string power chord</dd>
						<dt>Drag ←/→</dt>
						<dd>fret</dd>
						<dt>Drag ↑/↓</dt>
						<dd>octave</dd>
						<dt>Ctrl+←/→</dt>
						<dd>shape (over a chord's lowest note: reshape it)</dd>
						<dt>Drag lowest</dt>
						<dd>move the chord</dd>
						<dt>Drag other</dt>
						<dd>edit just that note</dd>
					{:else if currentTool === 4}
						<dt>Click</dt>
						<dd>place a chord, bass = that note</dd>
						<dt>Drag ←/→</dt>
						<dd>bass fret</dd>
						<dt>Drag ↑/↓</dt>
						<dd>octave</dd>
						<dt>Ctrl+←/→</dt>
						<dd>chord type</dd>
						<dt>Ctrl+↑/↓</dt>
						<dd>more / fewer strings</dd>
						<dt>{variationKeyLabels[0]} and {variationKeyLabels[1]}</dt>
						<dd>previous / next variation</dd>
						<dt>Shift+←/→</dt>
						<dd>previous / next variation</dd>
						<dt>Shift+row</dt>
						<dd>variation 1–12</dd>
						<dt>Bass note</dt>
						<dd>keys change the chord, drag moves it</dd>
					{:else if currentTool === 5}
						<dt>Click</dt>
						<dd>place an arpeggio, bass = that note</dd>
						<dt>Drag ←/→</dt>
						<dd>bass fret</dd>
						<dt>Drag ↑/↓</dt>
						<dd>octave</dd>
						<dt>Shift+↑</dt>
						<dd>ascending (again: up-down)</dd>
						<dt>Shift+↓</dt>
						<dd>descending (again: down-up)</dd>
						<dt>Shift+←/→</dt>
						<dd>fewer / more notes (loops)</dd>
						<dt>Ctrl+←/→</dt>
						<dd>chord type</dd>
						<dt>Ctrl+↑/↓</dt>
						<dd>more / fewer strings</dd>
						<dt>{variationKeyLabels[0]} and {variationKeyLabels[1]}</dt>
						<dd>previous / next variation</dd>
						<dt>Shift+row</dt>
						<dd>variation by number</dd>
						<dt>First note</dt>
						<dd>drag moves it, keys change it</dd>
						<dt>Other note</dt>
						<dd>click places a new arpeggio</dd>
					{:else if currentTool === 6}
						<dt>Click</dt>
						<dd>first note of the sweep (bass, or top note for patterns from the top)</dd>
						<dt>Drag ←/→</dt>
						<dd>fret</dd>
						<dt>Drag ↑/↓</dt>
						<dd>octave</dd>
						<dt>Shift+↑/↓</dt>
						<dd>pattern</dd>
						<dt>Shift+←/→</dt>
						<dd>fewer / more loops</dd>
						<dt>Ctrl+←/→</dt>
						<dd>chord type</dd>
						<dt>Ctrl+↑/↓</dt>
						<dd>more / fewer strings (2–6)</dd>
						<dt>{variationKeyLabels[0]} and {variationKeyLabels[1]}</dt>
						<dd>previous / next shape</dd>
						<dt>Shift+row</dt>
						<dd>shape by number (incl. C/E-style inversions)</dd>
						<dt>First note</dt>
						<dd>drag moves it, keys change it</dd>
						<dt>Other note</dt>
						<dd>click places a new sweep</dd>
					{:else if currentTool === 0}
						<dt>—</dt>
						<dd>selection tool not yet implemented</dd>
					{/if}
				</dl>
				{#if currentTool === 4 || currentTool === 5 || currentTool === 6}
					<!-- The top letter row: chord types. -->
					<h5>Top row: chord type</h5>
					<dl class="keys row-keys">
						{#each CHORD_ROW as id, i (id)}
							<dt>{topRowKeyLabels[i]}</dt>
							<dd>{CHORD_TYPES.find((c) => c.id === id)?.suffix || 'major'}</dd>
						{/each}
					</dl>
				{/if}
			</aside>
		{/if}

		<main
			class="stage"
			class:has-video={!!videoUrl}
			style:--ref-scale={mode === 'author' ? refScale : 1}
		>
			{#if videoUrl}
				<!-- View mode: composite canvas draws video + tab overlay together
				(WYSIWYG for the exported video). Author mode: hidden — the raw
				<video> below is shown instead so the user can still see the source
				while composing on the tab editor. -->
				<canvas
					bind:this={compositeCanvas}
					class="perf-video"
					style:display={mode === 'author' ? 'none' : ''}
				></canvas>
				<!-- svelte-ignore a11y_media_has_caption -->
				<video
					bind:this={videoElement}
					src={videoUrl}
					muted={!videoAudioOn || stemPlaying}
					playsinline
					preload="auto"
					class="ref-video"
					class:offstage={mode !== 'author' || showSpectrogram}
				></video>
				{#if showSpectrogram}
					<!-- Same width as the tab and lined up with its bars; height follows
					the reference size like the video's would. -->
					<div class="spectro-wrap">
						<canvas
							bind:this={spectroCanvas}
							class="spectro"
							style:aspect-ratio={`16 / ${9 * refScale}`}
							title={isStem(effectiveSource)
								? `Press and hold to hear the ${effectiveSource} alone from here (Shift: only this pitch band of it)`
								: 'Press and hold to hear only this pitch band of the reference (Shift: with its harmonics); drag up/down to change it'}
							onpointerenter={() => {
								probeSource()
									.then((src) => (src ? probe.load(src.key, src.buffer) : undefined))
									.catch(() => {});
							}}
							onpointermove={onSpectroMove}
							onpointerleave={() => (hoverMidi = null)}
							onpointerdown={onSpectroDown}
							onpointerup={stopProbe}
							onpointercancel={stopProbe}
							onlostpointercapture={stopProbe}
						></canvas>
						<div class="spectro-switches">
							<div class="spectro-channel" role="group" aria-label="Spectrogram picture">
								<button
									class:on={spectroStyle === 'notes'}
									onclick={() => (spectroStyle = 'notes')}
									title="Only the notes that best explain the sound, like a piano roll (rhythm parts)"
								>
									Notes
								</button>
								<button
									class:on={spectroStyle === 'spectrum'}
									onclick={() => (spectroStyle = 'spectrum')}
									title="Every pitch that stands out, harmonics included (solos, bends, vibrato)"
								>
									Spectrum
								</button>
								<button
									class:on={spectroStyle === 'plain'}
									onclick={() => (spectroStyle = 'plain')}
									title="How loud each pitch is, on one scale for the whole song — nothing picked or enhanced"
								>
									Plain
								</button>
							</div>
							<div class="spectro-channel" role="group" aria-label="Spectrogram source">
								<button
									class:on={spectroChannel === 'mix'}
									onclick={() => setSpectroChannel('mix')}
									title="Analyse the whole mix (solos, and anything in the centre)"
								>
									Mix
								</button>
								<button
									class:on={spectroChannel === 'sides'}
									onclick={() => setSpectroChannel('sides')}
									title="Analyse only what is panned to the sides (left minus right): hard-panned rhythm guitars without the bass, drums and vocals in the centre"
								>
									Sides
								</button>
								{#if stems?.status === 'done'}
									{#each STEM_SOURCES as stem (stem)}
										<button
											class:on={spectroChannel === stem}
											onclick={() => setSpectroChannel(stem)}
											title={`Only the ${stem}, split out of the song`}
										>
											{stem[0].toUpperCase() + stem.slice(1)}
										</button>
									{/each}
								{:else if stemsAvailable}
									<button
										class="split"
										disabled={stems?.status === 'running'}
										onclick={splitStems}
										title={stems?.status === 'error'
											? `Splitting failed: ${stems.error}`
											: `Split the song into instruments (guitar, bass, drums, …) on the ${stemsAvailable.device === 'cuda' ? 'GPU' : 'CPU — this takes a few minutes'}`}
									>
										{stems?.status === 'running'
											? `Splitting ${Math.round(stems.progress * 100)}%`
											: stems?.status === 'error'
												? 'Split failed'
												: 'Split'}
									</button>
								{/if}
							</div>
							<div class="spectro-channel" role="group" aria-label="Channel">
								<button
									class:on={listenChannel === 'left'}
									onclick={() => (listenChannel = 'left')}
									title="Left channel only, in mono — hear and see just what's on the left (e.g. one of two guitars)"
								>
									L
								</button>
								<button
									class:on={listenChannel === 'both'}
									onclick={() => (listenChannel = 'both')}
									title="Both channels, as recorded"
								>
									LR
								</button>
								<button
									class:on={listenChannel === 'right'}
									onclick={() => (listenChannel = 'right')}
									title="Right channel only, in mono — hear and see just what's on the right"
								>
									R
								</button>
							</div>
						</div>
					</div>
				{/if}
			{/if}

			<canvas
				bind:this={canvas}
				width="1280"
				height="260"
				class="tab-canvas"
				title={mode === 'author'
					? ''
					: 'Drag notes up/down to reassign string · shift+click BETWEEN notes to toggle hammer/pull (auto-picked from fret direction) · alt+click a note to toggle tap'}
				onpointerdown={onCanvasPointerDown}
				onmousedown={(e) => {
					// Middle-drag erases in author mode; stop the browser's autoscroll.
					if (e.button === 1 && mode === 'author') e.preventDefault();
				}}
				onpointermove={onCanvasPointerMove}
				onpointerup={onCanvasPointerUp}
				onpointercancel={onCanvasPointerUp}
				onpointerleave={onAuthorPointerLeave}
			></canvas>

			<canvas
				class="timeline"
				bind:this={timelineCanvas}
				width="1280"
				height="34"
				title="Drag to seek (snaps to beats — hold Shift for free scrub)"
				onpointerdown={onTimelinePointerDown}
				onpointermove={onTimelinePointerMove}
				onpointerup={onTimelinePointerUp}
				onpointercancel={onTimelinePointerUp}
			></canvas>

			<!-- Transport: playback, position, synth / metronome, and the
			reference controls used while syncing (audio, offset, tempo). -->
			<div class="transport">
				<button
					class="icon-btn"
					onclick={togglePlay}
					disabled={!tab}
					title={playing ? 'Pause (Space)' : 'Play (Space)'}
				>
					{#if playing}<span class="i-lucide-pause"></span>{:else}<span class="i-lucide-play"
						></span>{/if}
				</button>
				<button class="icon-btn" onclick={reset} disabled={!tab} title="Back to the start">
					<span class="i-lucide-skip-back"></span>
				</button>
				<span class="mono position">
					{#if tab}
						{Math.floor(currentTime / tab.secondsPerBar) + 1}.{Math.floor(
							(currentTime % tab.secondsPerBar) / (tab.secondsPerBar / tab.timeSignature[0])
						) + 1}
						<span class="dim"
							>/ {Math.max(1, Math.ceil(effectiveDurationSec / tab.secondsPerBar))} bars</span
						>
					{:else}
						—
					{/if}
				</span>
				<span class="tb-sep"></span>
				<button
					class="icon-btn"
					class:on={audioOn}
					title="Synth preview on / off"
					onclick={() => {
						audioOn = !audioOn;
						if (!audioOn && playing) synth.stop();
						else if (audioOn && playing && tab) synthRestart(currentTime);
					}}
				>
					<span class="i-lucide-volume-2"></span>
				</button>
				<input
					class="slim"
					type="range"
					min="0"
					max="1"
					step="0.01"
					bind:value={volume}
					title="Synth volume"
				/>
				<button
					class="icon-btn"
					class:on={metronomeOn}
					onclick={() => (metronomeOn = !metronomeOn)}
					title="Metronome: a click on each beat, higher on the downbeat"
				>
					<span class="i-lucide-metronome"></span>
				</button>
				{#if metronomeOn}
					<input
						class="slim"
						type="range"
						min="0"
						max="1"
						step="0.01"
						bind:value={metronomeVol}
						title="Click volume"
					/>
				{/if}
				{#if videoUrl}
					<span class="tb-sep"></span>
					{#if mode === 'author'}
						<button
							class="icon-btn"
							onclick={cycleRefScale}
							title={`Reference size: ${Math.round(refScale * 100)}% of the tab width (click to cycle 100 / 75 / 55 / 40%; also in View)`}
						>
							<span class="i-lucide-scaling"></span>
							<span class="scale-pct">{Math.round(refScale * 100)}%</span>
						</button>
					{/if}
					{#if mode === 'author' && !referenceIsAudio}
						<button
							class="icon-btn"
							class:on={refView === 'spectrogram'}
							onclick={() => (refView = refView === 'spectrogram' ? 'video' : 'spectrogram')}
							title={refView === 'spectrogram'
								? 'Showing the spectrogram — click for the video'
								: 'Show a spectrogram of the reference audio, lined up with the tab'}
						>
							<span class="i-lucide-audio-waveform"></span>
						</button>
					{/if}
					<button
						class="icon-btn"
						class:on={videoAudioOn}
						onclick={() => (videoAudioOn = !videoAudioOn)}
						title="Reference audio on / off"
					>
						<span class="i-lucide-file-video"></span>
					</button>
					<input
						class="slim"
						type="range"
						min="0"
						max="1"
						step="0.01"
						bind:value={videoVolume}
						disabled={!videoAudioOn}
						title="Reference volume"
					/>
					<span
						class="offset"
						title="Reference offset: video time when tab time = 0. Increase if the video is ahead of the tab."
					>
						<button class="nudge" onclick={() => nudgeOffset(-1)}>−1s</button>
						<button class="nudge" onclick={() => nudgeOffset(-0.1)}>−.1</button>
						<button class="nudge" onclick={() => nudgeOffset(-0.01)}>−.01</button>
						<input type="number" step="0.01" bind:value={videoOffsetSec} />
						<button class="nudge" onclick={() => nudgeOffset(0.01)}>+.01</button>
						<button class="nudge" onclick={() => nudgeOffset(0.1)}>+.1</button>
						<button class="nudge" onclick={() => nudgeOffset(1)}>+1s</button>
					</span>
					{#if tab}
						<span
							class="tempo"
							title="Tap in rhythm with the reference audio to estimate its BPM, then apply."
						>
							<input
								class="bpm-input"
								type="number"
								min="20"
								max="400"
								step="any"
								value={+tab.bpm.toFixed(3)}
								onchange={(e) => {
									setTempo(Number(e.currentTarget.value));
									e.currentTarget.value = String(+(tab?.bpm ?? 0).toFixed(3));
								}}
								title="Tempo in BPM — type a value (decimals are fine) and press Enter. Notes keep their place in the bar."
							/>
							<span class="mono">bpm</span>
							<button onclick={tapTempo}>Tap</button>
							{#if tapTimes.length > 0}
								<span class="hint">{tapBpm !== null ? `~${tapBpm}` : tapTimes.length}</span>
							{/if}
							{#if tapBpm !== null}
								<button onclick={applyTapBpm}>Apply</button>
							{/if}
							{#if tapTimes.length > 0}
								<button class="link" onclick={resetTaps}>reset</button>
							{/if}
						</span>
					{/if}
				{/if}
			</div>

			<!-- Status line: what's loaded. Details (articulation counts, raw
			MIDI inspector) are under Tab → File details. -->
			<p class="status">
				{#if parseError}
					<span class="err">Failed to parse MIDI: {parseError}</span>
				{:else if tab}
					{#if fileName}<span class="mono">{fileName}</span> ·
					{/if}
					{tab.notes.length} notes · {tab.bpm.toFixed(1)} bpm · {TUNINGS[tuningKey].name}
					{#if tab.trimmedLeadingSec > 0}
						· trimmed {tab.trimmedLeadingSec.toFixed(2)}s of leading silence
					{/if}
					{#if videoFileName}· reference: <span class="mono">{videoFileName}</span>{/if}
				{:else}
					Open a MIDI file (File → Open) or start a new tab (Author).
				{/if}
			</p>
		</main>
		<!-- Full shortcut reference, always at hand; collapses to a thin strip
		(? or the toolbar keyboard button). -->
		<aside class="shortcut-panel" class:collapsed={!shortcutsOpen}>
			<button
				class="collapse-btn"
				onclick={() => (shortcutsOpen = !shortcutsOpen)}
				title={shortcutsOpen ? 'Hide shortcuts (?)' : 'Show shortcuts (?)'}
			>
				<span class="i-lucide-keyboard"></span>
				{#if shortcutsOpen}<span>Shortcuts</span><span class="grow"></span><span
						class="i-lucide-chevron-right"
					></span>{/if}
			</button>
			{#if shortcutsOpen}
				<section>
					<h5>Playback</h5>
					<dl class="keys">
						<dt>Space</dt>
						<dd>play the focused bar / beat</dd>
						<dt>Ctrl+Space</dt>
						<dd>play through</dd>
						{#if mode === 'author' && stems?.status === 'done'}
							<dt>Shift+Space</dt>
							<dd>… hearing the selected stem</dd>
						{/if}
						<dt>← / →</dt>
						<dd>previous / next beat</dd>
						<dt>↑ / ↓</dt>
						<dd>previous / next bar</dd>
					</dl>
				</section>
				{#if mode === 'author'}
					<section>
						<h5>Grid & tools</h5>
						<dl class="keys">
							<dt>1–6, 0</dt>
							<dd>tools (again: palm mute)</dd>
							<dt>Shift+1–6</dt>
							<dd>reset a tool</dd>
							<dt>PgUp / PgDn</dt>
							<dd>finer / coarser grid</dd>
							<dt>Shift+PgDn</dt>
							<dd>triplets on / off</dd>
							<dt>{backquoteKeyLabel}</dt>
							<dd>reuse last fret on / off</dd>
						</dl>
					</section>
					<section>
						<h5>Hover a note</h5>
						<dl class="keys">
							<dt>M</dt>
							<dd>palm mute (whole moment)</dd>
							<dt>R</dt>
							<dd>let ring (whole moment)</dd>
							<dt>G</dt>
							<dd>ghost</dd>
							<dt>H</dt>
							<dd>hammer-on / pull-off</dd>
							<dt>T</dt>
							<dd>tap</dd>
							<dt>B hold</dt>
							<dd>bend: ←/→ amount, ↓ release</dd>
							<dt>S hold</dt>
							<dd>slide: ←/→ start fret</dd>
							<dt>V hold</dt>
							<dd>vibrato: → length</dd>
							<dt>N hold</dt>
							<dd>harmonic: ←/→ interval</dd>
						</dl>
					</section>
					<section>
						<h5>Editing</h5>
						<dl class="keys">
							<dt>Shift+drag</dt>
							<dd>move a note</dd>
							<dt>Alt+drag</dt>
							<dd>change fingering</dd>
							<dt>Ctrl+drag</dt>
							<dd>copy</dd>
							<dt>Middle</dt>
							<dd>click / drag to erase</dd>
							<dt>Ctrl+Z / Y</dt>
							<dd>undo / redo</dd>
						</dl>
					</section>
					{#if videoUrl}
						<section>
							<h5>Spectrogram</h5>
							<dl class="keys">
								{#if stems?.status === 'done' && isStem(spectroChannel)}
									<dt>Hold click</dt>
									<dd>hear the {spectroChannel} alone</dd>
									<dt>Shift+hold</dt>
									<dd>… only that pitch band</dd>
								{:else}
									<dt>Hold click</dt>
									<dd>hear only that pitch band</dd>
									<dt>Shift+hold</dt>
									<dd>… plus its harmonics</dd>
								{/if}
								<dt>… drag ↑/↓</dt>
								<dd>move the band</dd>
							</dl>
						</section>
					{/if}
				{/if}
			{/if}
		</aside>
	</div>

	{#if showNewTabDialog}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="dialog-backdrop" onclick={() => (showNewTabDialog = false)}>
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<!-- svelte-ignore a11y_interactive_supports_focus -->
			<div class="dialog" onclick={(e) => e.stopPropagation()} role="dialog">
				<h2>New tab</h2>
				<label>
					<span>BPM</span>
					<input type="number" min="20" max="400" step="1" bind:value={newTabBpm} />
				</label>
				<div class="tap-row">
					<button onclick={tapTempo}>Tap</button>
					<span class="hint">
						{tapTimes.length === 0
							? "Tap a few times in rhythm; we'll estimate BPM."
							: `${tapTimes.length} tap${tapTimes.length === 1 ? '' : 's'}${tapBpm !== null ? ` · ~${tapBpm} bpm` : ''}`}
					</span>
					<button class="link" onclick={() => (tapTimes = [])}>reset</button>
					{#if tapBpm !== null}
						<button class="link" onclick={() => (newTabBpm = tapBpm ?? newTabBpm)}>use</button>
					{/if}
				</div>
				<label>
					<span>Time signature</span>
					<span class="ts">
						<input type="number" min="1" max="16" step="1" bind:value={newTabTimeSigTop} />
						/
						<select bind:value={newTabTimeSigBottom}>
							<option value={2}>2</option>
							<option value={4}>4</option>
							<option value={8}>8</option>
							<option value={16}>16</option>
						</select>
					</span>
				</label>
				<label>
					<span>Tuning</span>
					<select bind:value={tuningKey}>
						{#each Object.entries(TUNINGS) as [key, t] (key)}
							<option value={key}>{t.name}</option>
						{/each}
					</select>
				</label>
				<label>
					<span>Initial bars</span>
					<input type="number" min="1" max="256" step="1" bind:value={newTabBars} />
				</label>
				<div class="dialog-actions">
					<button onclick={() => (showNewTabDialog = false)}>Cancel</button>
					<button class="primary" onclick={confirmNewTab}>Create</button>
				</div>
			</div>
		</div>
	{/if}

	{#if showFileDetails && tab}
		{@const counts = tab.notes.reduce(
			(acc, n) => {
				for (const a of n.articulations ?? []) acc[a.kind] = (acc[a.kind] ?? 0) + 1;
				return acc;
			},
			{} as Record<string, number>
		)}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="dialog-backdrop" onclick={() => (showFileDetails = false)}>
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<!-- svelte-ignore a11y_interactive_supports_focus -->
			<div class="dialog wide" onclick={(e) => e.stopPropagation()} role="dialog">
				<h2>File details</h2>
				<p class="meta">
					{#if fileName}<span class="mono">{fileName}</span> ·
					{/if}{tab.notes.length} notes · {tab.bpm.toFixed(1)} bpm
					{#if tab.trimmedLeadingSec > 0}
						· trimmed {tab.trimmedLeadingSec.toFixed(2)}s of leading silence
					{/if}
				</p>
				<p class="meta mono">
					bend {counts.bend ?? 0} · slide↑ {counts.slideUp ?? 0} · slide↓ {counts.slideDown ?? 0} · harmonic
					{counts.harmonic ?? 0} · vibrato {counts.vibrato ?? 0} · PM {counts.palmMute ?? 0} · ghost {counts.ghost ??
						0} · hammer {counts.hammerOn ?? 0} · pull {counts.pullOff ?? 0} · tap {counts.tap ?? 0}
				</p>
				{#if inspection}
					<details class="inspector">
						<summary>Raw MIDI event inspector (per channel)</summary>
						<table>
							<thead>
								<tr>
									<th>ch</th>
									<th>notes</th>
									<th>pitchBend</th>
									<th>pressure</th>
									<th>polyAT</th>
									<th>CCs (num×count)</th>
								</tr>
							</thead>
							<tbody>
								{#each [...inspection.channels.entries()].sort((a, b) => a[0] - b[0]) as [ch, s] (ch)}
									<tr>
										<td>{ch}</td>
										<td>{s.notes}</td>
										<td>{s.pitchBends}</td>
										<td>{s.pressure}</td>
										<td>{s.polyAftertouch}</td>
										<td>
											{[...s.ccs.entries()]
												.sort((a, b) => a[0] - b[0])
												.map(([n, c]) => `CC${n}×${c}`)
												.join(', ') || '—'}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</details>
				{/if}
				<div class="dialog-actions">
					<button onclick={() => (showFileDetails = false)}>Close</button>
				</div>
			</div>
		</div>
	{/if}

	{#if showExportResult && exportResultUrl && exportResultName}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="dialog-backdrop" onclick={() => (showExportResult = false)}>
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<!-- svelte-ignore a11y_interactive_supports_focus -->
			<div class="dialog wide" onclick={(e) => e.stopPropagation()} role="dialog">
				<h2>Export ready</h2>
				<p class="meta">
					<span class="mono">{exportResultName}</span> ·
					{(exportResultSize / (1024 * 1024)).toFixed(1)} MB
				</p>
				<!-- svelte-ignore a11y_media_has_caption -->
				<video src={exportResultUrl} controls style="width:100%;max-height:60vh;background:#000"
				></video>
				<div class="dialog-actions">
					<button onclick={() => (showExportResult = false)}>Close</button>
					<a href={exportResultUrl} download={exportResultName}>
						<button class="primary"><span class="i-lucide-download"></span> Download</button>
					</a>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	:global(html, body) {
		background: #0b0f14;
		color: #e6eef7;
		font-family:
			ui-sans-serif,
			system-ui,
			-apple-system,
			Segoe UI,
			Roboto,
			sans-serif;
	}
	/* ---- App shell: menu bar, toolbar, side panel + stage ------------------- */
	.app {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
	}
	.grow {
		flex: 1;
	}
	.menubar {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 12px;
		background: #10161d;
		border-bottom: 1px solid #1d2630;
		position: relative;
		z-index: 50;
	}
	.brand {
		font-weight: 700;
		letter-spacing: -0.01em;
		margin-right: 12px;
		color: #e6eef7;
	}
	.menus {
		display: flex;
		gap: 2px;
	}
	.menu {
		position: relative;
	}
	.menu > button {
		background: transparent;
		color: #b5c1cf;
		font-weight: 500;
		padding: 4px 10px;
		border: none;
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.menu > button:hover,
	.menu > button.open {
		background: #1c2530;
		color: #e6eef7;
	}
	.menu-panel {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		min-width: 260px;
		background: #141b23;
		border: 1px solid #2a3543;
		border-radius: 8px;
		padding: 6px;
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
		display: grid;
		gap: 2px;
	}
	.menu-panel.form {
		padding: 10px 12px;
		gap: 8px;
		min-width: 320px;
	}
	.menu-panel.form label {
		display: grid;
		grid-template-columns: 110px 1fr auto;
		align-items: center;
		gap: 8px;
	}
	.menu-panel.form label.check {
		display: flex;
		gap: 8px;
	}
	.menu-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		text-align: left;
		background: transparent;
		color: #cfd8e3;
		border: none;
		border-radius: 5px;
		padding: 6px 8px;
		font-weight: 500;
		cursor: pointer;
	}
	.menu-item:hover:not(:disabled) {
		background: #1f2a36;
	}
	.menu-item > span:not([class^='i-']) {
		color: inherit;
		font-size: 13px;
	}
	.menu-item:disabled {
		background: transparent;
		color: #56616f;
	}
	.menu-key {
		margin-left: auto;
		color: #6b788a;
		font-family: 'JetBrains Mono Variable', ui-monospace, monospace;
	}
	/* The native file input stays in the label (so clicking it opens the
	   picker) but is visually hidden. */
	.file-pick input[type='file'] {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
	}
	.menu-sep {
		height: 1px;
		background: #232c36;
		margin: 4px 2px;
	}
	.menu-note {
		margin: 0;
		font-size: 12px;
		color: #8a99ad;
		max-width: 340px;
	}
	.menu-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: #56616f;
	}
	.dot.on {
		background: #4ade80;
	}
	.status-chip {
		font-size: 12px;
		color: #ffcc55;
		margin-right: 8px;
	}
	.mode-toggle {
		display: inline-flex;
		background: #141b23;
		border: 1px solid #232c36;
		border-radius: 8px;
		overflow: hidden;
	}
	.mode-toggle button {
		background: transparent;
		border: none;
		color: #8a99ad;
		padding: 4px 14px;
		font-weight: 600;
	}
	.mode-toggle button.on {
		background: #2a3644;
		color: #e6eef7;
	}

	.toolbar {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 12px;
		background: #0e141a;
		border-bottom: 1px solid #1d2630;
	}
	.tool-group {
		display: flex;
		gap: 2px;
	}
	.tb-sep {
		width: 1px;
		align-self: stretch;
		background: #232c36;
		margin: 2px 6px;
	}
	.icon-btn {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 32px;
		height: 30px;
		padding: 0 6px;
		background: transparent;
		color: #b5c1cf;
		border: 1px solid transparent;
		border-radius: 6px;
		font-size: 16px;
		font-weight: 600;
	}
	.icon-btn:hover:not(:disabled) {
		background: #1c2530;
		color: #e6eef7;
	}
	.icon-btn.on {
		background: #2a3644;
		border-color: #ffcc55;
		color: #ffcc55;
	}
	/* Palm-mute variant of a tool: red accent. */
	.icon-btn.pm {
		border-color: #ff6b6b;
	}
	.icon-btn.text {
		font-family: 'JetBrains Mono Variable', ui-monospace, monospace;
		font-size: 14px;
	}
	.icon-btn:disabled {
		background: transparent;
		color: #3d4855;
	}
	/* "75%" next to the reference-size icon; fixed width so the transport
	   doesn't shift as it changes. */
	.scale-pct {
		font-family: 'JetBrains Mono Variable', ui-monospace, monospace;
		font-size: 11px;
		min-width: 3.2em;
		text-align: left;
		margin-left: 4px;
	}
	.tool-key {
		position: absolute;
		right: 2px;
		bottom: 0;
		font-size: 9px;
		font-weight: 700;
		color: #6b788a;
	}
	.icon-btn.on .tool-key {
		color: #ffcc55;
	}
	.tb-grid {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: #8a99ad;
	}

	/* Tool panel | tab block | shortcut panel. The middle column takes the
	   rest of the width; the tab block centres itself inside it. */
	.workspace {
		flex: 1;
		display: grid;
		grid-template-columns: minmax(0, 1fr) 250px;
		gap: 12px;
		padding: 12px;
	}
	.app.author .workspace {
		grid-template-columns: 260px minmax(0, 1fr) 250px;
	}
	.side-panel {
		align-self: start;
		position: sticky;
		top: 12px;
		max-height: calc(100vh - 110px);
		overflow-y: auto;
		background: #10161d;
		border: 1px solid #1d2630;
		border-radius: 10px;
		padding: 10px 12px;
		font-size: 12px;
		line-height: 1.45;
		color: #8a99ad;
	}
	.side-panel h4 {
		margin: 0 0 8px;
		font-size: 14px;
		color: #e6eef7;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.side-panel .key {
		display: inline-block;
		min-width: 1.5em;
		text-align: center;
		border-radius: 4px;
		background: #1c2530;
		color: #ffcc55;
		font-family: 'JetBrains Mono Variable', ui-monospace, monospace;
		font-size: 12px;
	}
	.pm-badge {
		font-size: 10px;
		font-weight: 700;
		color: #ff6b6b;
		border: 1px solid #ff6b6b;
		border-radius: 4px;
		padding: 0 4px;
	}
	/* Key / description rows (tool panel and shortcut panel). */
	.keys {
		margin: 0;
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 8px 10px;
		align-items: baseline;
	}
	.keys dt {
		font-family: 'JetBrains Mono Variable', ui-monospace, monospace;
		font-size: 11.5px;
		color: #e6eef7;
		white-space: nowrap;
	}
	.keys dd {
		margin: 0;
		color: #8a99ad;
	}
	/* Top-row chord types: two key / type pairs per row. */
	.keys.row-keys {
		grid-template-columns: auto 1fr auto 1fr;
		gap: 6px 8px;
	}
	.side-panel h5,
	.shortcut-panel h5 {
		margin: 16px 0 8px;
		font-size: 10.5px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: #ffcc55;
	}
	.shortcut-panel {
		align-self: start;
		position: sticky;
		top: 12px;
		width: 250px;
		max-height: calc(100vh - 110px);
		overflow-y: auto;
		background: #10161d;
		border: 1px solid #1d2630;
		border-radius: 10px;
		padding: 8px 12px 12px;
		font-size: 12px;
		line-height: 1.4;
	}
	.shortcut-panel.collapsed {
		width: auto;
		padding: 4px;
		/* Stays at the right edge of its fixed-width column, so collapsing
		   doesn't move the tab. */
		justify-self: end;
	}
	.shortcut-panel section:first-of-type h5 {
		margin-top: 8px;
	}
	.collapse-btn {
		width: 100%;
		background: transparent;
		border: none;
		padding: 4px;
		color: #b5c1cf;
		font-weight: 600;
	}
	/* The tab block: centred in the free space, as wide as a 16:9 frame
	   that fits the window (so video + tab look like the export), capped at
	   the export's 1280 px tab width. */
	.stage {
		display: grid;
		gap: 8px;
		align-self: center;
		justify-self: center;
		width: min(100%, 1280px);
		min-width: 0;
	}
	.stage.has-video {
		/* Video (16:9, scaled by --ref-scale) + tab (1280:260) + timeline and
		   transport must fit the window height:
		   width × (9/16 × scale + 260/1280) ≤ height − chrome. */
		width: min(100%, 1280px, calc((100vh - 270px) / (0.5625 * var(--ref-scale, 1) + 0.203)));
	}
	.transport {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-wrap: wrap;
		padding: 4px 8px;
		background: #10161d;
		border: 1px solid #1d2630;
		border-radius: 8px;
	}
	.transport .position {
		min-width: 110px;
		padding: 0 6px;
		color: #e6eef7;
	}
	.transport .dim {
		color: #6b788a;
	}
	input[type='range'].slim {
		width: 80px;
		padding: 0;
	}
	.transport .offset {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		margin-left: 8px;
	}
	.transport .offset input {
		width: 64px;
		background: #0b0f14;
		color: #e6eef7;
		border: 1px solid #2a3543;
		border-radius: 4px;
		padding: 2px 4px;
		font-family: 'JetBrains Mono Variable', ui-monospace, monospace;
	}
	.transport .tempo {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-left: 8px;
	}
	.transport .tempo .bpm-input {
		width: 72px;
		background: #0b0f14;
		color: #e6eef7;
		border: 1px solid #2a3543;
		border-radius: 4px;
		padding: 2px 4px;
		font-family: 'JetBrains Mono Variable', ui-monospace, monospace;
	}
	.transport .tempo .hint,
	.menu-row .hint {
		margin-left: 0;
	}
	.status {
		margin: 0;
		font-size: 12px;
		color: #6b788a;
	}

	.dialog.wide {
		width: min(900px, 90vw);
	}
	.dialog-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.55);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
	}
	.dialog {
		background: #141b23;
		border: 1px solid #232c36;
		border-radius: 12px;
		padding: 20px 22px;
		min-width: 380px;
		display: grid;
		gap: 12px;
	}
	.dialog h2 {
		margin: 0 0 6px 0;
		font-size: 18px;
	}
	.dialog label {
		display: grid;
		grid-template-columns: 120px 1fr;
		align-items: center;
		gap: 8px;
	}
	.dialog .ts {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.dialog .ts input {
		width: 60px;
	}
	.dialog-actions {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
		margin-top: 8px;
	}
	.dialog-actions .primary {
		background: #ffcc55;
		color: #141b23;
		border-color: #ffcc55;
	}
	.tap-row {
		display: flex;
		align-items: center;
		gap: 10px;
		grid-column: 2;
	}
	label {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}
	label > span {
		color: #8a99ad;
		font-size: 13px;
	}
	select,
	input[type='range'],
	input[type='file'] {
		background: #0b0f14;
		color: #e6eef7;
		border: 1px solid #2a3543;
		border-radius: 6px;
		padding: 3px 6px;
		font-size: 13px;
	}
	canvas {
		width: 100%;
		max-width: 100%;
		border-radius: 10px;
		border: 1px solid #232c36;
		display: block;
	}
	canvas.timeline {
		border-radius: 6px;
		cursor: grab;
		touch-action: none;
		user-select: none;
	}
	canvas.timeline:active {
		cursor: grabbing;
	}
	canvas.perf-video {
		width: 100%;
		max-width: 100%;
		border-radius: 10px;
		border: 1px solid #232c36;
		background: #000;
		display: block;
	}
	/* Reference spectrogram: full tab width (it's lined up with the tab's
	   bars), height set inline from the reference size. */
	canvas.spectro {
		width: 100%;
		background: #05070a;
		cursor: crosshair;
		touch-action: none;
	}
	.spectro-wrap {
		position: relative;
	}
	/* Notes / Spectrum and Mix / Sides switches, over the spectrogram's
	   top-right corner. */
	.spectro-switches {
		position: absolute;
		top: 8px;
		right: 8px;
		display: flex;
		/* On a narrow window the two groups stack instead of running off the left. */
		flex-wrap: wrap;
		justify-content: flex-end;
		max-width: calc(100% - 16px);
		gap: 6px;
	}
	.spectro-channel {
		display: flex;
		background: rgba(14, 20, 26, 0.85);
		border: 1px solid #232c36;
		border-radius: 6px;
		overflow: hidden;
	}
	.spectro-channel button {
		background: transparent;
		border: none;
		border-radius: 0;
		color: #8a99ad;
		padding: 2px 10px;
		font-size: 11.5px;
		font-weight: 600;
	}
	.spectro-channel button.split {
		min-width: 92px;
	}
	.spectro-channel button.on {
		background: #2a3644;
		color: #e6eef7;
	}
	video.ref-video {
		width: calc(var(--ref-scale, 1) * 100%);
		justify-self: center;
		aspect-ratio: 16 / 9;
		object-fit: contain;
		border-radius: 10px;
		border: 1px solid #232c36;
		background: #000;
		display: block;
	}
	/* Not shown (spectrogram / view mode), but still the audio source: keep it
	   rendered at 1 px rather than display: none, which some browsers treat as
	   "nobody is watching" and stop playing. */
	video.ref-video.offstage {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
		border: 0;
	}
	/* Neutral, compact buttons; the accent colour is for primary actions and
	   "on" states only. */
	button {
		background: #1c2530;
		color: #cfd8e3;
		border: 1px solid #2a3543;
		border-radius: 6px;
		padding: 4px 10px;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	button:hover:not(:disabled) {
		background: #243040;
		color: #e6eef7;
	}
	button.primary {
		background: #ffcc55;
		border-color: #ffcc55;
		color: #141b23;
		font-weight: 700;
	}
	button.primary:hover:not(:disabled) {
		background: #ffd878;
		color: #141b23;
	}
	button:disabled {
		background: #161d25;
		color: #56616f;
		cursor: not-allowed;
	}
	.mono {
		font-family: ui-monospace, Menlo, Consolas, monospace;
		color: #8a99ad;
	}
	.hint {
		color: #6b788a;
		font-size: 12px;
		margin-left: auto;
	}
	button.link {
		background: none;
		color: #8a99ad;
		border: none;
		padding: 0;
		font-size: 12px;
		text-decoration: underline;
		cursor: pointer;
		font-weight: normal;
	}
	button.link:hover {
		color: #e6eef7;
	}
	button.nudge {
		background: #1c2734;
		color: #e6eef7;
		border: 1px solid #2a3543;
		border-radius: 4px;
		padding: 3px 8px;
		font-family: ui-monospace, Menlo, Consolas, monospace;
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
	}
	button.nudge:hover {
		background: #232c36;
	}
	.err {
		color: #ff8877;
	}
	.meta {
		color: #8a99ad;
		font-size: 14px;
	}
	.inspector {
		background: #141b23;
		border: 1px solid #232c36;
		border-radius: 10px;
		padding: 10px 14px;
		color: #e6eef7;
		font-size: 13px;
	}
	.inspector summary {
		cursor: pointer;
		color: #8a99ad;
	}
	.inspector table {
		width: 100%;
		border-collapse: collapse;
		margin-top: 8px;
		font-family: ui-monospace, Menlo, Consolas, monospace;
	}
	.inspector th,
	.inspector td {
		text-align: left;
		padding: 4px 8px;
		border-bottom: 1px solid #232c36;
	}
	.inspector th {
		color: #8a99ad;
		font-weight: 600;
	}
</style>
