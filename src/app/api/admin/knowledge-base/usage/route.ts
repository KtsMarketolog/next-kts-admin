import { knowledgeBaseQueryId, knowledgeBaseRoute } from '@/shared/lib/knowledgeBaseApi';
import { listKnowledgeBaseStats } from '@/shared/lib/db/knowledgeBaseRepo';
import { knowledgeBaseInvalid } from '@/shared/lib/knowledgeBase';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return knowledgeBaseRoute(request, { manage: true, action: 'usage' }, async session => {
    const query = new URL(request.url).searchParams;
    const view = query.get('view') ?? 'employees';
    if (view !== 'employees' && view !== 'materials') throw knowledgeBaseInvalid();
    return Response.json(await listKnowledgeBaseStats(session, { view, search: query.get('search') ?? undefined, after: query.get('after') ?? undefined,
      actorKey: query.get('actorKey') ?? undefined, nodeId: knowledgeBaseQueryId(query.get('nodeId'), true) }));
  });
}
