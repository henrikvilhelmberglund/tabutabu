// Serves the source video for the export job so the render page inside
// puppeteer can load it via `<video src=".../video">`.

import type { RequestHandler } from './$types';
import { createReadStream, promises as fs } from 'node:fs';
import { Readable } from 'node:stream';
import { readConfig, videoPath } from '$lib/server/exportJobs';

export const GET: RequestHandler = async ({ params }) => {
	const cfg = await readConfig(params.jobId);
	if (!cfg) return new Response('job not found', { status: 404 });
	const path = videoPath(params.jobId);
	let stat;
	try {
		stat = await fs.stat(path);
	} catch {
		return new Response('video missing', { status: 404 });
	}
	const stream = createReadStream(path);
	const webBody = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
	return new Response(webBody, {
		status: 200,
		headers: {
			'Content-Type': cfg.videoMime || 'video/mp4',
			'Content-Length': String(stat.size),
			'Cache-Control': 'no-store',
			'Accept-Ranges': 'bytes'
		}
	});
};
