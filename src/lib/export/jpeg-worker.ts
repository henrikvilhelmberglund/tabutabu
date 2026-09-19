// JPEG-encode worker for the export pipeline. Receives an ImageBitmap
// transferred from the main thread, draws it into an OffscreenCanvas, then
// calls `convertToBlob({ type: 'image/jpeg' })` — all off the main thread.
//
// convertToBlob on OffscreenCanvas is comparable in speed to canvas.toBlob but
// with the huge win that it doesn't block the main thread. That's what lets
// the main thread keep up with rVFC callbacks at 60 fps (or higher).

type EncodeMessage = {
	kind: 'encode';
	id: number;
	bitmap: ImageBitmap;
	quality: number;
};

type ReadyMessage = { kind: 'result'; id: number; buffer: ArrayBuffer };
type ErrorMessage = { kind: 'error'; id: number; message: string };

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

self.onmessage = async (e: MessageEvent<EncodeMessage>) => {
	const msg = e.data;
	if (msg.kind !== 'encode') return;
	try {
		const w = msg.bitmap.width;
		const h = msg.bitmap.height;
		if (!canvas || canvas.width !== w || canvas.height !== h) {
			canvas = new OffscreenCanvas(w, h);
			ctx = canvas.getContext('2d', { alpha: false });
		}
		if (!ctx) throw new Error('no 2d context');
		ctx.drawImage(msg.bitmap, 0, 0);
		msg.bitmap.close();
		const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: msg.quality });
		const buffer = await blob.arrayBuffer();
		const reply: ReadyMessage = { kind: 'result', id: msg.id, buffer };
		(self as unknown as Worker).postMessage(reply, [buffer]);
	} catch (err) {
		const reply: ErrorMessage = {
			kind: 'error',
			id: msg.id,
			message: err instanceof Error ? err.message : String(err)
		};
		(self as unknown as Worker).postMessage(reply);
	}
};

export {};
