import { knowledgeBaseObject, knowledgeBaseQueryId, knowledgeBaseRoute, readKnowledgeBaseJson } from '@/shared/lib/knowledgeBaseApi';
import { moveKnowledgeBaseNode, previewKnowledgeBaseMove } from '@/shared/lib/db/knowledgeBaseRepo';
import { assertKnowledgeBaseId, assertKnowledgeBaseRevision, knowledgeBaseInvalid } from '@/shared/lib/knowledgeBase';

// Preview and commit share authentication, origin and bounded-body protection.
// Preview itself never changes the tree; commit rechecks its revision/token in a transaction.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return knowledgeBaseRoute(request, { manage: true, mutation: true, action: 'move' }, async session => {
    const id = knowledgeBaseQueryId((await context.params).id)!;
    const body = knowledgeBaseObject(await readKnowledgeBaseJson(request), ['action', 'expectedRevision', 'targetParentId', 'previewToken']);
    assertKnowledgeBaseRevision(body.expectedRevision);
    if (body.targetParentId !== null) assertKnowledgeBaseId(body.targetParentId);
    const input = { expectedRevision: body.expectedRevision, targetParentId: body.targetParentId };
    if (body.action === 'preview' && !Object.hasOwn(body, 'previewToken')) {
      return Response.json(await previewKnowledgeBaseMove(session, id, input));
    }
    if (body.action === 'commit' && typeof body.previewToken === 'string' && /^[a-f0-9]{64}$/.test(body.previewToken)) {
      return Response.json(await moveKnowledgeBaseNode(session, id, { ...input, previewToken: body.previewToken }));
    }
    throw knowledgeBaseInvalid();
  });
}
