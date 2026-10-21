import { randomUUID } from 'crypto';
import { knowledgeBaseQueryId, knowledgeBaseRoute } from '@/shared/lib/knowledgeBaseApi';
import { assertKnowledgeBaseUuid, knowledgeBaseInvalid, knowledgeBaseNotFound } from '@/shared/lib/knowledgeBase';
import { getKnowledgeBaseFileForRead, recordKnowledgeBaseEvent } from '@/shared/lib/db/knowledgeBaseRepo';
import { knowledgeBaseFilename, knowledgeBaseFileStream, knowledgeBaseHtmlPolicy, openKnowledgeBaseFile } from '@/shared/lib/knowledgeBaseStorage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
async function read(request: Request, context: Context, head: boolean) {
  return knowledgeBaseRoute(request, { action: 'file', limit: 300 }, async session => {
    const id = knowledgeBaseQueryId((await context.params).id)!;
    const query = new URL(request.url).searchParams;
    const mode = query.get('mode') ?? 'download';
    if (!['preview', 'download'].includes(mode)) throw knowledgeBaseInvalid();
    const record = await getKnowledgeBaseFileForRead(session, id);
    if (!record || !record.node.originalName || !record.node.size) throw knowledgeBaseNotFound();
    const type = knowledgeBaseFilename(record.node.originalName);
    const inline = mode === 'preview' && (type.mimeType === 'text/html' || type.mimeType === 'application/pdf'
      || type.mimeType === 'text/plain' || type.mimeType.startsWith('image/'));
    const file = await openKnowledgeBaseFile(record.storagePath, record.node.size);
    let transferred = false;
    try {
      const headers = new Headers({
        'Content-Type': `${type.mimeType}${type.mimeType.startsWith('text/') ? '; charset=utf-8' : ''}`,
        // Inline HTML needs room for CSP hashes in a bounded upstream header;
        // the download action retains the complete original UTF-8 filename.
        'Content-Disposition': inline ? `inline; filename="document.${type.extension}"`
          : `attachment; filename="document.${type.extension}"; filename*=UTF-8''${encodeURIComponent(type.name).replace(/['()]/g, value => `%${value.charCodeAt(0).toString(16)}`)}`,
        'Content-Length': String(record.node.size), 'Accept-Ranges': 'none',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'; object-src 'none'",
      });
      let html: Buffer | null = null;
      if (!inline) headers.set('Content-Security-Policy', `${headers.get('Content-Security-Policy')}; sandbox`);
      if (inline && type.mimeType === 'text/html') {
        html = await file.readFile();
        headers.set('Content-Security-Policy', knowledgeBaseHtmlPolicy(new TextDecoder('utf-8', { fatal: true }).decode(html)));
      }
      if (!head) {
        const eventId = query.get('eventId') ?? randomUUID(); assertKnowledgeBaseUuid(eventId);
        await recordKnowledgeBaseEvent(session, { eventId, nodeId: id, action: inline ? 'file_view' : 'download_started' });
      }
      if (head) return new Response(null, { headers });
      if (html) return new Response(new Uint8Array(html), { headers });
      const response = new Response(knowledgeBaseFileStream(file), { headers });
      transferred = true;
      return response;
    } finally { if (!transferred) await file.close(); }
  });
}
export function GET(request: Request, context: Context) { return read(request, context, false); }
export function HEAD(request: Request, context: Context) { return read(request, context, true); }
