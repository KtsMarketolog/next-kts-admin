import { knowledgeBaseObject, knowledgeBaseQueryId, knowledgeBaseRoute, readKnowledgeBaseJson } from '@/shared/lib/knowledgeBaseApi';
import { deleteKnowledgeBaseNode, previewKnowledgeBaseDeletion } from '@/shared/lib/db/knowledgeBaseRepo';
import { assertKnowledgeBaseRevision, assertKnowledgeBaseUuid, knowledgeBaseInvalid } from '@/shared/lib/knowledgeBase';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return knowledgeBaseRoute(request, { manage: true, mutation: true, action: 'delete', limit: 60 }, async session => {
    const id = knowledgeBaseQueryId((await context.params).id)!;
    const body = knowledgeBaseObject(await readKnowledgeBaseJson(request), ['action', 'expectedRevision', 'previewToken', 'confirmationTitle', 'operationId']);
    assertKnowledgeBaseRevision(body.expectedRevision);
    if (body.action === 'preview' && Object.keys(body).length === 2) {
      return Response.json(await previewKnowledgeBaseDeletion(session, id, { expectedRevision: body.expectedRevision }));
    }
    if (body.action === 'commit' && Object.keys(body).length === 5 && typeof body.previewToken === 'string' && typeof body.confirmationTitle === 'string') {
      assertKnowledgeBaseUuid(body.operationId);
      return Response.json(await deleteKnowledgeBaseNode(session, id, { expectedRevision: body.expectedRevision,
        previewToken: body.previewToken, confirmationTitle: body.confirmationTitle, operationId: body.operationId }));
    }
    throw knowledgeBaseInvalid();
  });
}
