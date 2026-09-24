// Runs the reference-audio analysis (spectrogram-analysis.ts) off the main
// thread, posting progress while it works.

import { analyse, type AnalysisOptions } from './spectrogram-analysis';

self.onmessage = (e: MessageEvent<AnalysisOptions & { samples: Float32Array }>) => {
	const { samples, ...opts } = e.data;
	const result = analyse(samples, opts, (progress) => self.postMessage({ progress }));
	self.postMessage(
		{ done: true, ...result },
		{ transfer: [result.plain.buffer, result.spectrum.buffer, result.notes.buffer] }
	);
};
