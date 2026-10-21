import { getAdminSession } from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { canReviewDashboardUsage } from '@/shared/lib/dashboardUsageAccess';
import { DashboardUsageExportLimitError, DashboardUsageFilterError, parseDashboardUsageFilters } from '@/shared/lib/dashboardUsageFilters';
import { acquireDashboardUsageExportSlot, buildDashboardUsageWorkbook } from '@/shared/lib/dashboardUsageExport';
import { exportDashboardUsage } from '@/shared/lib/db/dashboardUsageRepo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (data: unknown, status: number) => Response.json(data, { status, headers });

export async function GET(request: Request) {
  const session = await getAdminSession();
  if (!session || !canReviewDashboardUsage(session)) return json({ error: 'Нет доступа' }, session ? 403 : 401);
  let release: (() => void) | null = null;
  try {
    const params = new URL(request.url).searchParams, view = params.get('view');
    if (view !== 'employees' && view !== 'events') throw new DashboardUsageFilterError();
    const filters = parseDashboardUsageFilters(params, view, true);
    const limited = await enforceAdminActionRateLimit(session, 'dashboard-usage-export', 5, 60_000);
    if (limited) { for (const [key, value] of Object.entries(headers)) limited.headers.set(key, value); return limited; }
    release = acquireDashboardUsageExportSlot();
    if (!release) return json({ error: 'Другая выгрузка ещё готовится. Повторите через несколько секунд.' }, 429);
    const data = await exportDashboardUsage(view, filters);
    if (request.signal.aborted) return json({ error: 'Выгрузка отменена' }, 408);
    const file = buildDashboardUsageWorkbook(data, filters);
    return new Response(new Uint8Array(file), { headers: { ...headers,
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="dashboard-usage-${view}.xlsx"`, 'Content-Length': String(file.length) } });
  } catch (error) {
    if (error instanceof DashboardUsageFilterError) return json({ error: error.message }, 400);
    if (error instanceof DashboardUsageExportLimitError) return json({ error: error.message }, 413);
    console.error('DASHBOARD_USAGE_EXPORT_FAILED');
    return json({ error: 'Не удалось подготовить Excel. Попробуйте сузить период и повторить выгрузку.' }, 503);
  } finally { release?.(); }
}
