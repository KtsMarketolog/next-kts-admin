import { knowledgeBaseObject, knowledgeBaseRoute, readKnowledgeBaseJson } from '@/shared/lib/knowledgeBaseApi';
import { getKnowledgeBaseAccessSummary } from '@/shared/lib/db/knowledgeBaseRepo';
import { assertKnowledgeBaseId, knowledgeBaseInvalid, parseKnowledgeBaseAccess } from '@/shared/lib/knowledgeBase';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  // Read-only POST keeps the draft recipient list out of URLs and shares same-origin/body guards with editing.
  return knowledgeBaseRoute(request, { manage: true, mutation: true, action: 'access_preview', limit: 300 }, async session => {
    const body = knowledgeBaseObject(await readKnowledgeBaseJson(request), ['parentId', 'access']);
    const parentId = body.parentId;
    if (parentId !== null) assertKnowledgeBaseId(parentId);
    if (body.access === undefined) throw knowledgeBaseInvalid();
    const access = parseKnowledgeBaseAccess(body.access, parentId === null);
    return Response.json(await getKnowledgeBaseAccessSummary(session, { parentId, access }));
  });
}
