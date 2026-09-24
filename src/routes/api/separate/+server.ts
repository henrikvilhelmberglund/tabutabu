// Optional stem separation (see $lib/server/separation.ts).
//   GET  /api/separate → whether it's available here (and on GPU or CPU)
//   POST /api/separate → start separating the posted audio file (raw body,
//                        file extension in ?ext=); returns { id }

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
	const id = await startSeparation(audio, url.searchParams.get('ext') ?? '');
	return json({ id });
};
