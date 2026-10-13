import { getAdminSession } from '@/shared/lib/adminAuth';
import { canViewDashboardKey } from '@/shared/lib/dashboardPermissions';
import { dashboardInstructionDownload } from '@/shared/lib/dashboardInstructionDownload';
import { DASHBOARD_INSTRUCTION_HEADERS, resolveDashboardInstruction, type DashboardInstructionKind } from '@/shared/lib/dashboardInstructions';
import { getActiveTopDashboardBlockHtmlContent } from '@/shared/lib/db/topDashboardBlocksRepo';
import { detectTopDashboardExpectedProfile } from '@/shared/lib/topDashboardContentSecurity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ kind: string }> };

async function serve(request: Request, context: Context) {
  const error = (message: string, status: number) => request.method === 'HEAD'
    ? new Response(null, { status, headers: DASHBOARD_INSTRUCTION_HEADERS })
    : Response.json({ error: message }, { status, headers: DASHBOARD_INSTRUCTION_HEADERS });
  try {
    const session = await getAdminSession();
    if (!session) return error('Необходим вход в кабинет', 401);
    const { kind } = await context.params;
    const query = new URL(request.url).searchParams;
    if (query.getAll('dashboardKey').length !== 1 || query.getAll('download').length > 1
      || [...query.keys()].some((key) => !['dashboardKey', 'download'].includes(key))
      || (query.has('download') && query.get('download') !== '1')) {
      return error('Некорректный запрос инструкции', 400);
    }
    const key = query.get('dashboardKey')!;
    if (!resolveDashboardInstruction(kind, key)) return error('Инструкция не найдена', 404);
    if (!canViewDashboardKey(session, key)) return error('Нет доступа к этому отчёту', 403);
    if (kind === 'sales-analytics') {
      // A grant for some other TOP report must not expose this manual. Titles and
      // numeric block IDs are mutable; identify the currently published HTML.
      const publishedHtml = await getActiveTopDashboardBlockHtmlContent(Number(key.slice(4)));
      if (!publishedHtml || detectTopDashboardExpectedProfile(publishedHtml) !== 'sales-analytics') {
        return error('Инструкция не найдена для этого отчёта', 404);
      }
    }
    return await dashboardInstructionDownload(request, kind as DashboardInstructionKind, query.get('download') === '1');
  } catch (cause) {
    console.error('Failed to serve dashboard instruction', cause);
    return error('Не удалось открыть инструкцию. Попробуйте ещё раз.', 500);
  }
}

export const GET = serve;
export const HEAD = serve;
