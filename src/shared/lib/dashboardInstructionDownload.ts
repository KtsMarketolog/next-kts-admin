import { open } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DASHBOARD_INSTRUCTIONS, DASHBOARD_INSTRUCTION_HEADERS, type DashboardInstructionKind } from './dashboardInstructions';

/** Called only after the current session and exact report have been authorised. */
export async function dashboardInstructionDownload(request: Request, kind: DashboardInstructionKind, download: boolean) {
  const instruction = DASHBOARD_INSTRUCTIONS[kind];
  const file = await open(path.join(process.cwd(), 'assets', 'dashboard-instructions', instruction.filename), 'r');
  let streamOwnsHandle = false;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0) throw new Error('Instruction file unavailable');
    const headers = new Headers({
      ...DASHBOARD_INSTRUCTION_HEADERS,
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${instruction.filename}"; filename*=UTF-8''${encodeURIComponent(instruction.downloadName)}`,
      'Accept-Ranges': 'bytes',
    });
    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    // HEAD describes the complete file. With no validator, If-Range falls back to 200.
    const range = request.method === 'GET' && !request.headers.has('if-range') ? request.headers.get('range') : null;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const first = match?.[1] ? Number(match[1]) : null;
      const last = match?.[2] ? Number(match[2]) : null;
      if (!match || (first === null && last === null)
        || (first !== null && !Number.isSafeInteger(first))
        || (last !== null && !Number.isSafeInteger(last))
        || (first === null && last === 0)) {
        headers.set('Content-Range', `bytes */${stat.size}`);
        return new Response(null, { status: 416, headers });
      }
      start = first ?? Math.max(0, stat.size - last!);
      end = first !== null && last !== null ? Math.min(last, end) : end;
      if (start >= stat.size || end < start) {
        headers.set('Content-Range', `bytes */${stat.size}`);
        return new Response(null, { status: 416, headers });
      }
      status = 206;
      headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    }
    headers.set('Content-Length', String(end - start + 1));
    if (request.method === 'HEAD') return new Response(null, { status, headers });
    if (request.signal.aborted) throw new Error('Download cancelled');
    const stream = file.createReadStream({ start, end, autoClose: true });
    const abort = () => stream.destroy(new Error('Download cancelled'));
    request.signal.addEventListener('abort', abort, { once: true });
    stream.once('close', () => request.signal.removeEventListener('abort', abort));
    const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
    streamOwnsHandle = true;
    return new Response(body, { status, headers });
  } finally {
    if (!streamOwnsHandle) await file.close();
  }
}
