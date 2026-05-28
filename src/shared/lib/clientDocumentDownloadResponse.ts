import type { ClientDocumentFile } from './db';
import { readClientDocumentFile } from './clientDocumentStorage';

export async function createClientDocumentDownloadResponse(document: ClientDocumentFile) {
  const bytes = await readClientDocumentFile(document.filePath);
  const filename = document.originalName || document.title || `document-${document.id}`;

  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': document.mimeType || 'application/octet-stream',
      'Content-Length': String(bytes.length),
      'Content-Disposition': createContentDisposition(filename),
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function createContentDisposition(filename: string) {
  const fallback = filename.replace(/[^\x20-\x7e]+/g, '_').replace(/["\\\r\n]/g, '').trim() || 'document';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
