// DAW transport sync via WebMIDI. Listens only for MIDI real-time system
// messages (Start / Stop / Continue / Song Position Pointer) and forwards them
// as high-level callbacks. The tab data itself is loaded from a file — this
// module never touches notes.

export type SyncCallbacks = {
	onStart: () => void; // 0xFA — jump to 0 and play
	onStop: () => void; // 0xFC — pause, keep position
	onContinue: () => void; // 0xFB — resume from current position
	onSeek: (positionSec: number) => void; // 0xF2 — song position pointer
};

export type SyncPortInfo = { id: string; name: string; manufacturer: string };

export class DawSync {
	private access: MIDIAccess | null = null;
	private input: MIDIInput | null = null;
	private secondsPer16thNote = 60 / (120 * 4);
	private callbacks: SyncCallbacks;
	private lastSppReceivedMs = -Infinity;
	// If true, MIDI Start (0xFA) is treated as "resume from current position"
	// instead of "seek to 0". Useful when the DAW doesn't send SPP but you've
	// pre-seeked Tabutabu manually.
	preservePositionOnStart = false;
	// If true, log every transport-relevant message received. Handy for figuring
	// out whether the DAW is actually sending SPP.
	debug = false;

	constructor(callbacks: SyncCallbacks) {
		this.callbacks = callbacks;
	}

	// Song Position Pointer counts in "MIDI beats" — each is a 16th note. The
	// DAW's BPM determines how those map to seconds. Keep this current if the
	// user changes tempo mid-session or a new tab is loaded.
	setTempo(bpm: number): void {
		this.secondsPer16thNote = 60 / (bpm * 4);
	}

	async listPorts(): Promise<SyncPortInfo[]> {
		this.access ??= await navigator.requestMIDIAccess({ sysex: false });
		return Array.from(this.access.inputs.values()).map((p) => ({
			id: p.id,
			name: p.name ?? '(unnamed)',
			manufacturer: p.manufacturer ?? ''
		}));
	}

	async connect(portId: string): Promise<void> {
		this.access ??= await navigator.requestMIDIAccess({ sysex: false });
		this.disconnect();
		for (const input of this.access.inputs.values()) {
			if (input.id === portId) {
				this.input = input;
				input.onmidimessage = (e) => this.handleMessage(e);
				return;
			}
		}
		throw new Error(`MIDI input port ${portId} not found`);
	}

	disconnect(): void {
		if (this.input) {
			this.input.onmidimessage = null;
			this.input = null;
		}
	}

	private handleMessage(e: MIDIMessageEvent): void {
		const data = e.data;
		if (!data || data.length === 0) return;
		const status = data[0];
		switch (status) {
			case 0xfa: {
				// If Song Position Pointer just arrived, the DAW is telling us to
				// resume from a specific point (the SPP already applied the seek).
				// Otherwise Start means "from the top".
				const sppFresh = performance.now() - this.lastSppReceivedMs < 200;
				if (this.debug) console.log(`[sync] Start${sppFresh ? ' (after SPP → Continue)' : ''}`);
				if (sppFresh || this.preservePositionOnStart) this.callbacks.onContinue();
				else this.callbacks.onStart();
				break;
			}
			case 0xfb:
				if (this.debug) console.log('[sync] Continue');
				this.callbacks.onContinue();
				break;
			case 0xfc:
				if (this.debug) console.log('[sync] Stop');
				this.callbacks.onStop();
				break;
			case 0xf2: {
				const spp = (data[1] ?? 0) | ((data[2] ?? 0) << 7);
				const pos = spp * this.secondsPer16thNote;
				this.lastSppReceivedMs = performance.now();
				if (this.debug) console.log(`[sync] SPP → ${pos.toFixed(3)}s (spp=${spp})`);
				this.callbacks.onSeek(pos);
				break;
			}
		}
	}
}
