// Serves the export job's config JSON to the render page loaded inside
// puppeteer. Returns 404 if the job dir doesn't exist (e.g. cleaned up).

import type { RequestHandler } from './$types';
import { readConfig } from '$lib/server/exportJobs';

export const GET: RequestHandler = async ({ params }) => {
	const cfg = await readConfig(params.jobId);
	if (!cfg) return new Response('job not found', { status: 404 });
	return new Response(JSON.stringify(cfg), {
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store'
		}
	});
};
