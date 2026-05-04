import { getNewsItems } from '@/shared/lib/db';
import { DEFAULT_NEWS } from '@/entities/site/model/defaultNews';

export async function GET() {
  try {
    const news = await getNewsItems({ activeOnly: true });
    return Response.json({ news });
  } catch {
    return Response.json({ news: DEFAULT_NEWS });
  }
}
