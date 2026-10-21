import { knowledgeBaseQueryId, knowledgeBaseRoute } from '@/shared/lib/knowledgeBaseApi';
import { assertKnowledgeBaseUuid, KnowledgeBaseError, knowledgeBaseInvalid, parseKnowledgeBaseAccess, parseKnowledgeBaseTitle } from '@/shared/lib/knowledgeBase';
import { createKnowledgeBaseFile, getKnowledgeBaseNode } from '@/shared/lib/db/knowledgeBaseRepo';
import { acquireKnowledgeBaseUploadSlot } from '@/shared/lib/knowledgeBaseUploadConcurrency';
import { removeUncommittedKnowledgeBaseFile, saveKnowledgeBaseUpload, type SavedKnowledgeBaseFile } from '@/shared/lib/knowledgeBaseStorage';

export const runtime = 'nodejs';
function header(request: Request, name: string) {
  const value = request.headers.get(name);
  if (value === null || value.length > 12_000) throw knowledgeBaseInvalid();
  try { return decodeURIComponent(value); } catch { throw knowledgeBaseInvalid(); }
}
export async function POST(request: Request) {
  return knowledgeBaseRoute(request, { manage: true, mutation: true, action: 'upload', limit: 60 }, async session => {
    const query = new URL(request.url).searchParams;
    const parentId = knowledgeBaseQueryId(query.get('parentId'))!;
    const operationId = query.get('operationId'); assertKnowledgeBaseUuid(operationId);
    const title = parseKnowledgeBaseTitle(header(request, 'x-kb-title'));
    let access;
    if (request.headers.has('x-kb-access')) {
      try { access = parseKnowledgeBaseAccess(JSON.parse(header(request, 'x-kb-access'))); } catch { throw knowledgeBaseInvalid(); }
    }
    const originalName = header(request, 'x-kb-file-name');
    const parent = await getKnowledgeBaseNode(session, parentId);
    if (!parent || parent.kind !== 'folder' || parent.archivedAt) throw new KnowledgeBaseError(404, 'NOT_FOUND', 'Раздел не найден или недоступен');
    const release = await acquireKnowledgeBaseUploadSlot();
    if (!release) return Response.json({ error: 'Сейчас загружаются другие файлы. Повторите через минуту.' }, { status: 429, headers: { 'Retry-After': '30' } });
    let file: SavedKnowledgeBaseFile | null = null;
    let attemptedCommit = false;
    let discard = false;
    let result: Awaited<ReturnType<typeof createKnowledgeBaseFile>>;
    let cleanupWarning = false;
    try {
      file = await saveKnowledgeBaseUpload(request, originalName);
      // Once DB work starts, its commit may succeed even if the reply is lost.
      // Preserve that file on uncertainty; retry uses the same operation UUID.
      attemptedCommit = true;
      result = await createKnowledgeBaseFile(session, { operationId, parentId, title, access, ...file });
      discard = !result.created;
    } catch (error) {
      // These are explicit validation/ACL/revision rejections, never an unknown
      // COMMIT acknowledgement. Only the newly created upload is discarded.
      if (error instanceof KnowledgeBaseError) discard = true;
      throw error;
    } finally {
      try { if (file && (!attemptedCommit || discard)) await removeUncommittedKnowledgeBaseFile(file.storagePath); }
      catch { cleanupWarning = true; console.warn(JSON.stringify({ event: 'knowledge_base_upload_cleanup_failed' })); }
      try { await release(); }
      catch { cleanupWarning = true; console.warn(JSON.stringify({ event: 'knowledge_base_upload_unlock_failed' })); }
    }
    return Response.json({ ...result, ...(cleanupWarning ? { warning: 'Файл сохранён; служебная очистка требует проверки.' } : {}) });
  });
}
