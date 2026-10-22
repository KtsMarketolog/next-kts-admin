import { requireEmployee } from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { getSanhuaKnowledgeCandidates } from '@/shared/lib/analogs';
import { getActiveAnalogCatalog } from '@/shared/lib/db/analogCatalogRepo';
import { getAnalogStockMatches } from '@/shared/lib/db/analogStockRepo';

export const dynamic = 'force-dynamic';

export async function GET() {
  const { session, denied } = await requireEmployee();
  if (denied) return denied;
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    const limited = await enforceAdminActionRateLimit(session, 'analog-search', 120, 60_000);
    if (limited) return Response.json({ error: 'Слишком много запросов. Подождите немного и повторите.' }, {
      status: 429, headers: { ...headers, 'Retry-After': limited.headers.get('Retry-After') ?? '60' },
    });
    const catalog = await getActiveAnalogCatalog();
    const rows = getSanhuaKnowledgeCandidates();
    const matches = getAnalogStockMatches(rows.map((row) => ({ ...row, aliases: row.catalogAliases })), catalog);
    const candidates = rows.flatMap((row) => {
      const catalogMatches = matches.get(row.id) ?? [];
      return catalogMatches.length ? [{ ...row, catalogMatches }] : [];
    });
    return Response.json({ candidates }, { headers });
  } catch (error) {
    console.error('Failed to load Sanhua catalogue', error);
    return Response.json({ error: 'Не удалось проверить каталог и остатки Sanhua. Повторите запрос позже.' }, { status: 503, headers });
  }
}
