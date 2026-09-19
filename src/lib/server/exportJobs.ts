// Simple filesystem-backed job store for the puppeteer-driven export pipeline.
// The client POSTs a video + tab data → we create a job dir under /tmp and
// launch puppeteer, which loads /render/<jobId>. The render page reads back
// the same job data via GET endpoints, captures frames, and POSTs to the
// /finalize endpoint which encodes with ffmpeg-NVENC and writes out.mp4.
//
// Job state is only used to route data between:
//   client         -> orchestrator (writes video + config)
//   render page    -> orchestrator (reads video + config)
//   render page    -> finalize (writes frames -> ffmpeg -> out.mp4)
//   orchestrator   -> client (reads out.mp4 and streams it back)
//
// The job dir is deleted after the outer /api/export request finishes.

import { promises as fs, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type JobConfig = {
	width: number;
	height: number;
	offsetX: number;
	offsetY: number;
	compositeLayout: {
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
		cropTop: number;
		cropBottom: number;
	};
	videoOffsetSec: number;
	encoder: string;
	bitrate: number;
	// Everything the tab renderer needs to reproduce the UI.
	tab: unknown;
	tuningKey: string;
	renderMode: string;
	playheadStyle: string;
	theme: string;
	stringFlashEnabled: boolean;
	pixelsPerSecond: number;
	barsPerPage: number;
	peekBeats: number;
	showNoteLengths: boolean;
	videoMime: string;
	// Probed from the source video by ffprobe on the server. Filled in by
	// the orchestrator before puppeteer starts, so the render page knows
	// exactly how many tab frames to produce and at what rate.
	sourceFps: number;
	sourceDurationSec: number;
	sourceFrameCount: number;
};

const JOBS_ROOT = join(tmpdir(), 'tabutabu-jobs');

export function jobRoot(): string {
	return JOBS_ROOT;
}
export function jobDir(jobId: string): string {
	return join(JOBS_ROOT, jobId);
}
export function jobFile(jobId: string, name: string): string {
	return join(jobDir(jobId), name);
}

export async function createJob(): Promise<string> {
	await fs.mkdir(JOBS_ROOT, { recursive: true });
	const id = randomUUID();
	await fs.mkdir(jobDir(id));
	return id;
}

export async function cleanupJob(jobId: string): Promise<void> {
	const dir = jobDir(jobId);
	if (!existsSync(dir)) return;
	await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

export async function writeConfig(jobId: string, cfg: JobConfig): Promise<void> {
	await fs.writeFile(jobFile(jobId, 'config.json'), JSON.stringify(cfg));
}

export async function readConfig(jobId: string): Promise<JobConfig | null> {
	try {
		const buf = await fs.readFile(jobFile(jobId, 'config.json'), 'utf8');
		return JSON.parse(buf) as JobConfig;
	} catch {
		return null;
	}
}

export async function writeVideo(jobId: string, buf: Buffer): Promise<void> {
	await fs.writeFile(jobFile(jobId, 'source'), buf);
}

export function videoPath(jobId: string): string {
	return jobFile(jobId, 'source');
}

export function outputPath(jobId: string): string {
	return jobFile(jobId, 'out.mp4');
}
