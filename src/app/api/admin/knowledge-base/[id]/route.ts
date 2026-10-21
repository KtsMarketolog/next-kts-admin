import { knowledgeBaseObject, knowledgeBaseQueryId, knowledgeBaseRoute, readKnowledgeBaseJson } from '@/shared/lib/knowledgeBaseApi';
import { setKnowledgeBaseArchive, updateKnowledgeBaseNode } from '@/shared/lib/db/knowledgeBaseRepo';
import { knowledgeBaseInvalid, type KnowledgeBaseUpdate } from '@/shared/lib/knowledgeBase';

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return knowledgeBaseRoute(request, { manage: true, mutation: true, action: 'edit' }, async session => {
    const id = knowledgeBaseQueryId((await context.params).id)!;
    const body = knowledgeBaseObject(await readKnowledgeBaseJson(request), ['expectedRevision', 'title', 'access', 'archived']);
    if (Object.hasOwn(body, 'archived')) {
      if (Object.keys(body).length !== 2 || typeof body.archived !== 'boolean' || typeof body.expectedRevision !== 'string') throw knowledgeBaseInvalid();
      return Response.json({ node: await setKnowledgeBaseArchive(session, id, { expectedRevision: body.expectedRevision, archived: body.archived }) });
    }
    return Response.json({ node: await updateKnowledgeBaseNode(session, id, body as KnowledgeBaseUpdate) });
  });
}
