import { knowledgeBaseObject, knowledgeBaseRoute, readKnowledgeBaseJson } from '@/shared/lib/knowledgeBaseApi';
import { recordKnowledgeBaseEvent } from '@/shared/lib/db/knowledgeBaseRepo';
import { knowledgeBaseInvalid, type KnowledgeBaseAction } from '@/shared/lib/knowledgeBase';
export async function POST(request: Request) {
  return knowledgeBaseRoute(request, { mutation: true, action: 'event', limit: 300 }, async session => {
    const body = knowledgeBaseObject(await readKnowledgeBaseJson(request), ['eventId', 'nodeId', 'action']);
    // File views/downloads are counted after the authorized file can be opened.
    if (body.action !== 'section_open' && body.action !== 'folder_open') throw knowledgeBaseInvalid();
    return Response.json(await recordKnowledgeBaseEvent(session, body as { eventId: string; nodeId: number | null; action: KnowledgeBaseAction }));
  });
}
