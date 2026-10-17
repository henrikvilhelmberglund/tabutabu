// GET /api/separate/<id>/export?name=<song> → every stem as a 24-bit WAV, zipped.

import type { RequestHandler } from './$types';
import { Readable } from 'node:stream';
import { exportStems } from '$lib/server/separation';

export const GET: RequestHandler = async ({ params, url }) => {
	// Song name for the file names, without characters file systems reject.
	const name =
		(url.searchParams.get('name') ?? 'stems')
			.replace(/\.[^.]+$/, '')
			.replace(/[\/:*?"<>|\x00-\x1f]/g, '_')
			.trim()
			.slice(0, 120) || 'stems';
	let result;
	try {
		result = await exportStems(params.id, name);
	} catch (e) {
		return new Response(`export failed: ${e instanceof Error ? e.message : e}`, { status: 500 });
	}
	if (!result) return new Response('not found', { status: 404 });
	// JSZip hands back an older-style stream; wrap it for the web Response.
	const body = Readable.toWeb(new Readable().wrap(result.zip)) as ReadableStream;
	return new Response(body, {
		headers: {
			'content-type': 'application/zip',
			'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name + ' - stems.zip')}`,
			'x-stems-lossless': result.lossless ? '1' : '0'
		}
	});
};
