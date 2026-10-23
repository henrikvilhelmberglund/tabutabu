// Exactly seekable playback of MP3 / raw AAC references.
//
// Browsers seek inside these by estimating where a time is in the file, and
// in a long variable-bitrate MP3 that lands a second or more off (measured
// in Chrome: 1.2 s late at 8 min with a seek table, 1.8 s early without),
// while the spectrogram and the stems are decoded exactly. Such references
// play from an uncompressed copy instead (WAV in memory), which seeks to the
// sample. Chrome's full decode lines up with ffmpeg's (the stems) exactly.

export function needsSeekableCopy(type: string, name: string): boolean {
	return /audio\/(mpeg|mp3|aac)\b/i.test(type) || /\.(mp3|aac)$/i.test(name);
}

export async function seekableCopy(file: ArrayBuffer): Promise<Blob> {
	const ctx = new OfflineAudioContext(2, 1, 44100);
	const audio = await ctx.decodeAudioData(file.slice(0));
	return wavBlob(audio);
}

// 16-bit PCM WAV, mono or stereo.
function wavBlob(audio: AudioBuffer): Blob {
	const channels = Math.min(2, audio.numberOfChannels);
	const frames = audio.length;
	const data = new Int16Array(frames * channels);
	for (let c = 0; c < channels; c++) {
		const src = audio.getChannelData(c);
		for (let i = 0; i < frames; i++) {
			const v = Math.max(-1, Math.min(1, src[i]));
			data[i * channels + c] = v < 0 ? v * 0x8000 : v * 0x7fff;
		}
	}
	const header = new DataView(new ArrayBuffer(44));
	const text = (at: number, s: string) => {
		for (let i = 0; i < s.length; i++) header.setUint8(at + i, s.charCodeAt(i));
	};
	const bytes = data.byteLength;
	text(0, 'RIFF');
	header.setUint32(4, 36 + bytes, true);
	text(8, 'WAVE');
	text(12, 'fmt ');
	header.setUint32(16, 16, true);
	header.setUint16(20, 1, true); // PCM
	header.setUint16(22, channels, true);
	header.setUint32(24, audio.sampleRate, true);
	header.setUint32(28, audio.sampleRate * channels * 2, true);
	header.setUint16(32, channels * 2, true);
	header.setUint16(34, 16, true);
	text(36, 'data');
	header.setUint32(40, bytes, true);
	return new Blob([header.buffer, data.buffer], { type: 'audio/wav' });
}
