import { knowledgeBaseRoute } from '@/shared/lib/knowledgeBaseApi';
import { listKnowledgeBaseActors } from '@/shared/lib/db/knowledgeBaseRepo';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return knowledgeBaseRoute(request, { manage: true, action: 'actors' }, async session => {
    const query = new URL(request.url).searchParams;
    return Response.json(await listKnowledgeBaseActors(session, { search: query.get('search') ?? undefined,
      after: query.get('after') ?? undefined }));
  });
}
