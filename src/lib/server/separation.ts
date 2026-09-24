// Optional stem separation for the reference audio (HT-Demucs, see
// tools/separate.py). Only available when the Python environment in .venv
// exists; everything else in the app works without it.
//
// Stems are cached on disk by the reference file's content hash, so a song
// is only separated once.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const STEMS = ['guitar', 'bass', 'drums', 'vocals', 'piano', 'other'] as const;
export type Stem = (typeof STEMS)[number];

const ROOT = process.cwd();
const PYTHON = resolve(
	ROOT,
	'.venv',
	process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
);
const SCRIPT = resolve(ROOT, 'tools', 'separate.py');
const CACHE = join(tmpdir(), 'tabutabu-stems');

export type Availability = { available: boolean; device?: 'cuda' | 'cpu'; reason?: string };

let availability: Promise<Availability> | null = null;

// Whether separation can run here, and on what. A working setup is
// remembered; a missing one is checked again next time (it may have been
// installed since).
export function checkAvailability(): Promise<Availability> {
	availability ??= new Promise<Availability>((done) => {
		if (!existsSync(PYTHON) || !existsSync(SCRIPT)) {
			done({ available: false, reason: 'Python environment not set up (see tools/README.md)' });
			return;
		}
		const p = spawn(PYTHON, ['-c', 'import demucs, torch; print(torch.cuda.is_available())'], {
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let out = '';
		let err = '';
		p.stdout.on('data', (d: Buffer) => (out += d));
		p.stderr.on('data', (d: Buffer) => (err += d));
		p.on('error', (e) => done({ available: false, reason: e.message }));
		p.on('close', (code) =>
			done(
				code === 0
					? { available: true, device: out.trim() === 'True' ? 'cuda' : 'cpu' }
					: { available: false, reason: err.trim().split('\n').pop() || `exit ${code}` }
			)
		);
	}).then((a) => {
		if (!a.available) availability = null;
		return a;
	});
	return availability;
}

export type Job = {
	status: 'running' | 'done' | 'error';
	progress: number;
	device?: string;
	error?: string;
};

const jobs = new Map<string, Job>();

const dirOf = (id: string) => join(CACHE, id);

export function stemPath(id: string, stem: Stem): string {
	return join(dirOf(id), `${stem}.ogg`);
}

function isDone(id: string): boolean {
	return STEMS.every((s) => existsSync(stemPath(id, s)));
}

// Ids are content hashes; anything else never touches the disk.
const validId = (id: string) => /^[0-9a-f]{20}$/.test(id);

// Status of a separation (from memory, or finished earlier and cached).
export function getJob(id: string): Job | null {
	if (!validId(id)) return null;
	const job = jobs.get(id);
	if (job) return job;
	return isDone(id) ? { status: 'done', progress: 1 } : null;
}

// Start separating `audio` (unless it's cached or already running). Returns
// the job id: the file's content hash.
export async function startSeparation(audio: Uint8Array, ext: string): Promise<string> {
	const id = createHash('sha1').update(audio).digest('hex').slice(0, 20);
	const running = jobs.get(id);
	if (isDone(id) || running?.status === 'running') return id;

	const dir = dirOf(id);
	await fs.mkdir(dir, { recursive: true });
	const input = join(dir, `input.${ext.replace(/[^a-z0-9]/gi, '') || 'bin'}`);
	await fs.writeFile(input, audio);

	const job: Job = { status: 'running', progress: 0 };
	jobs.set(id, job);
	const p = spawn(PYTHON, [SCRIPT, input, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
	let err = '';
	p.stdout.on('data', (d: Buffer) => {
		for (const line of d.toString().split(/\r?\n/)) {
			const [key, value] = line.trim().split(/\s+/);
			if (key === 'PROGRESS') job.progress = Math.max(job.progress, Number(value) || 0);
			else if (key === 'DEVICE') job.device = value;
		}
	});
	p.stderr.on('data', (d: Buffer) => {
		err = (err + d.toString()).slice(-4000);
	});
	p.on('error', (e) => {
		job.status = 'error';
		job.error = e.message;
	});
	p.on('close', (code) => {
		void fs.rm(input, { force: true });
		if (code === 0 && isDone(id)) {
			job.status = 'done';
			job.progress = 1;
		} else {
			job.status = 'error';
			job.error = err.trim().split('\n').pop() || `separation exited with ${code}`;
		}
	});
	return id;
}
