// Optional stem separation (see $lib/server/separation.ts).
//   GET  /api/separate → whether it's available here (and on GPU or CPU)
//   POST /api/separate → start separating the posted audio file (raw body,
//                        file extension in ?ext=; only ?start= seconds for
//                        ?length= seconds, if given); returns { id }

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { checkAvailability, startSeparation } from '$lib/server/separation';

export const GET: RequestHandler = async () => json(await checkAvailability());

export const POST: RequestHandler = async ({ request, url }) => {
	const availability = await checkAvailability();
	if (!availability.available) {
		return json({ error: availability.reason ?? 'not available' }, { status: 503 });
	}
	const audio = new Uint8Array(await request.arrayBuffer());
	if (audio.length === 0) return json({ error: 'empty file' }, { status: 400 });
	const start = Number(url.searchParams.get('start'));
	const length = Number(url.searchParams.get('length'));
	const range =
		url.searchParams.has('length') && Number.isFinite(start) && Number.isFinite(length) && length > 0
			? { start: Math.max(0, start), length }
			: undefined;
	const id = await startSeparation(audio, url.searchParams.get('ext') ?? '', range);
	return json({ id });
};
