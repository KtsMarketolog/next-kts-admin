import { Readable } from 'node:stream';
import type { FirmwareKind } from './firmwareContract';
import { openFirmwareDownload } from './firmwareStorage';

// The same descriptor is hashed, fstat'ed and streamed. Neither publication nor
// rollback can mix old headers with a new file's bytes between stat and open.
export async function firmwareDownloadResponse(request: Request, kind: FirmwareKind) {
  const file = await openFirmwareDownload(kind);
  let streamOwnsHandle = false;
  try {
    const etag = `"${file.sha256}"`;
    const headers = new Headers({
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Accept-Ranges': 'bytes',
      'ETag': etag,
      'Last-Modified': file.modifiedAt.toUTCString(),
    });
    const ifNoneMatch = request.headers.get('if-none-match');
    if (ifNoneMatch?.split(',').some((tag) => ['*', etag, `W/${etag}`].includes(tag.trim()))) {
      return new Response(null, { status: 304, headers });
    }
    let start = 0;
    let end = file.size - 1;
    let status = 200;
    const range = request.headers.get('range');
    const ifRange = request.headers.get('if-range');
    const useRange = range && (!ifRange || ifRange === etag
      || Number.isFinite(Date.parse(ifRange)) && Math.floor(file.modifiedAt.getTime() / 1000) <= Date.parse(ifRange) / 1000);
    if (useRange) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] || match[2])) {
        if (!match[1]) start = Math.max(0, file.size - Number(match[2]));
        else start = Number(match[1]);
        if (match[1] && match[2]) end = Math.min(end, Number(match[2]));
      }
      if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || start >= file.size || end < start) {
        headers.set('Content-Range', `bytes */${file.size}`);
        return new Response(null, { status: 416, headers });
      }
      status = 206;
      headers.set('Content-Range', `bytes ${start}-${end}/${file.size}`);
    }
    headers.set('Content-Length', String(end - start + 1));
    if (request.method === 'HEAD') return new Response(null, { status, headers });
    if (request.signal.aborted) throw new Error('Download cancelled');
    const stream = file.handle.createReadStream({ start, end, autoClose: true });
    const abort = () => stream.destroy(new Error('Download cancelled'));
    request.signal.addEventListener('abort', abort, { once: true });
    stream.once('close', () => request.signal.removeEventListener('abort', abort));
    const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
    streamOwnsHandle = true;
    return new Response(body, { status, headers });
  } finally {
    if (!streamOwnsHandle) await file.handle.close();
  }
}
