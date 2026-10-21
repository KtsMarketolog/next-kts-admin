import { knowledgeBaseObject, knowledgeBaseQueryBoolean, knowledgeBaseQueryId, knowledgeBaseRoute, readKnowledgeBaseJson } from '@/shared/lib/knowledgeBaseApi';
import { createKnowledgeBaseFolder, listKnowledgeBase } from '@/shared/lib/db/knowledgeBaseRepo';
import type { KnowledgeBaseCreate } from '@/shared/lib/knowledgeBase';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return knowledgeBaseRoute(request, { action: 'list', limit: 300 }, async session => {
    const query = new URL(request.url).searchParams;
    return Response.json(await listKnowledgeBase(session, {
      parentId: knowledgeBaseQueryId(query.get('parentId'), true) ?? null,
      after: knowledgeBaseQueryId(query.get('after'), true), search: query.get('search') ?? undefined,
      archived: knowledgeBaseQueryBoolean(query.get('archived')),
    }));
  });
}
export async function POST(request: Request) {
  return knowledgeBaseRoute(request, { manage: true, mutation: true, action: 'create' }, async session => {
    const body = knowledgeBaseObject(await readKnowledgeBaseJson(request), ['operationId', 'parentId', 'title', 'access']);
    return Response.json(await createKnowledgeBaseFolder(session, body as KnowledgeBaseCreate));
  });
}
