import { getAdminSession, isTopDashboardManagementSession } from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { canViewDashboard } from '@/shared/lib/dashboardAccess';
import { canManageCurrencyDashboard } from '@/shared/lib/currencyDashboardAccess';
import { DASHBOARD_USAGE_MAX_BODY, parseDashboardUsageBatch } from '@/shared/lib/dashboardUsage';
import { listDashboardUsage, listDashboardUsageActors, listDashboardUsageEmployees, listDashboardUsageEmployeeReports, recordDashboardUsage } from '@/shared/lib/db/dashboardUsageRepo';
import { DashboardUsageFilterError, parseDashboardUsageFilters } from '@/shared/lib/dashboardUsageFilters';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { canReviewDashboardUsage } from '@/shared/lib/dashboardUsageAccess';
import { DASHBOARD_USAGE_SESSION_HEADER } from '@/shared/lib/dashboardUsageDelivery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (data: unknown, status = 200) => Response.json(data, { status, headers });

export async function POST(request: Request) {
  const session = await getAdminSession();
  if (!session?.sessionId) return json({ error: 'Нет доступа' }, 401);
  const forbidden = enforceSameOriginRequest(request);
  if (forbidden) return forbidden;
  // Retry IDs are scoped to the original rendered session, never whichever account logged in later.
  if (request.headers.get(DASHBOARD_USAGE_SESSION_HEADER) !== session.sessionId) return json({ error: 'Сеанс изменился. Обновите страницу' }, 409);
  if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'Нужен JSON' }, 415);
  const limited = await enforceAdminActionRateLimit(session, 'dashboard-usage', 120, 60_000);
  if (limited) return limited;
  try {
    if (Number(request.headers.get('content-length')) > DASHBOARD_USAGE_MAX_BODY || !request.body) return json({ error: 'Слишком большой запрос' }, 413);
    const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > DASHBOARD_USAGE_MAX_BODY) { await reader.cancel(); return json({ error: 'Слишком большой запрос' }, 413); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    const batch = parseDashboardUsageBatch(JSON.parse(bytes.toString('utf8')));
    if (!canViewDashboard(session, batch.dashboardKey)) return json({ error: 'Нет доступа к отчёту' }, 403);
    const manage = batch.dashboardKey === 'currency-rates' ? canManageCurrencyDashboard(session)
      : batch.dashboardKey.startsWith('top:') ? isTopDashboardManagementSession(session)
        : session.role === 'admin' || session.role === 'admintop';
    if (batch.preview && !manage) return json({ error: 'Нет доступа к предпросмотру' }, 403);
    await recordDashboardUsage(session, batch);
    return json({ ok: true });
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && error.message === 'Некорректные события')) return json({ error: 'Некорректные события' }, 400);
    console.error('DASHBOARD_USAGE_WRITE_FAILED');
    return json({ error: 'Журнал временно недоступен' }, 503);
  }
}

export async function GET(request: Request) {
  const session = await getAdminSession();
  if (!session || !canReviewDashboardUsage(session)) return json({ error: 'Нет доступа' }, session ? 403 : 401);
  const params = new URL(request.url).searchParams;
  const view = params.get('view') ?? 'events';
  if (!['events', 'employees', 'employee', 'actors'].includes(view)) return json({ error: 'Некорректный фильтр' }, 400);
  try {
    const filter = parseDashboardUsageFilters(params, view as 'events' | 'employees' | 'employee' | 'actors');
    const limited = await enforceAdminActionRateLimit(session, 'dashboard-usage-read', 60, 60_000);
    if (limited) { for (const [key, value] of Object.entries(headers)) limited.headers.set(key, value); return limited; }
    if (view === 'employee') return json(await listDashboardUsageEmployeeReports({ ...filter, actorKey: filter.actorKey! }));
    if (view === 'employees') return json(await listDashboardUsageEmployees(filter));
    if (view === 'actors') return json(await listDashboardUsageActors(filter));
    return json(await listDashboardUsage(filter));
  } catch (error) {
    if (error instanceof DashboardUsageFilterError) return json({ error: error.message }, 400);
    console.error('DASHBOARD_USAGE_READ_FAILED'); return json({ error: 'Журнал временно недоступен' }, 503);
  }
}
