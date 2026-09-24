// GET /api/separate/<id>/<stem> → one separated stem (Opus).

import type { RequestHandler } from './$types';
import { promises as fs } from 'node:fs';
import { STEMS, getJob, stemPath, type Stem } from '$lib/server/separation';

export const GET: RequestHandler = async ({ params }) => {
	const stem = params.stem as Stem;
	if (!STEMS.includes(stem) || getJob(params.id)?.status !== 'done') {
		return new Response('not found', { status: 404 });
	}
	const data = await fs.readFile(stemPath(params.id, stem));
	return new Response(data, {
		headers: {
			'content-type': 'audio/ogg',
			'cache-control': 'private, max-age=31536000, immutable'
		}
	});
};
