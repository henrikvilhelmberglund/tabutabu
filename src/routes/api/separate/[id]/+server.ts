// GET /api/separate/<id> → progress of a separation.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getJob } from '$lib/server/separation';

export const GET: RequestHandler = ({ params }) => {
	const job = getJob(params.id);
	return job ? json(job) : json({ error: 'unknown separation' }, { status: 404 });
};
