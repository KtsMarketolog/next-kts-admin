import { canReadTopDashboardBlock } from '@/shared/lib/dashboardAccess';
import {
  isTopDashboardManagementSession,
  requireTopDashboardSession,
} from '@/shared/lib/adminAuth';
import { getTopDashboardBlockVersionContent, isPublishedTopDashboardBlockVersion } from '@/shared/lib/db';
import { isActiveTopDashboardHtmlVersion } from '@/shared/lib/db/topDashboardBlocksRepo';
import { isProfitabilityHtmlCandidate, isSupportedProfitabilityHtml } from '@/shared/lib/dashboardProfitabilityHtml';
import {
  buildTopDashboardFrameSecurityPolicy,
  createTopDashboardFrameBridgeScript,
} from '@/shared/lib/topDashboardContentSecurity';

import { parsePositiveId } from '../../../../routeUtils';

export const runtime = 'nodejs';

type Context = {
  params: Promise<{ blockId: string; versionId: string }>;
};

export async function GET(request: Request, context: Context) {
  const { denied, session } = await requireTopDashboardSession();
  if (denied) return denied;

  const { blockId: rawBlockId, versionId: rawVersionId } = await context.params;
  const blockId = parsePositiveId(rawBlockId);
  const versionId = parsePositiveId(rawVersionId);
  if (!blockId) return Response.json({ error: 'Некорректный блок' }, { status: 400 });
  if (!canReadTopDashboardBlock(session, blockId)) {
    return Response.json({ error: 'Нет доступа к этому отчёту' }, { status: 403, headers: { 'Cache-Control': 'private, no-store' } });
  }
  if (!versionId) return Response.json({ error: 'Некорректная версия HTML' }, { status: 400 });
  const canManage = isTopDashboardManagementSession(session);
  const version = await getTopDashboardBlockVersionContent(blockId, versionId);
  if (!version) return Response.json({ error: 'Версия HTML не найдена' }, { status: 404 });
  const profitability = isSupportedProfitabilityHtml(version.htmlContent);
  const unsupportedProfitability = !profitability && isProfitabilityHtmlCandidate(version.htmlContent);
  // The approved self-contained invoice report does not require a shared
  // snapshot; ordinary HTML reports retain their existing data-readiness gate.
  const published = profitability ? await isActiveTopDashboardHtmlVersion(blockId, versionId)
    : !canManage && await isPublishedTopDashboardBlockVersion(blockId, versionId);
  if (!canManage && !published) {
    return Response.json({ error: 'Версия HTML не найдена' }, { status: 404 });
  }

  const officeView = new URL(request.url).searchParams.get('view') === 'sales-office';
  const contentPath = `/api/admin/top-dashboard/blocks/${blockId}/versions/${versionId}/content${officeView ? '?view=sales-office' : ''}`;
  const bridgeScript = createTopDashboardFrameBridgeScript(
    blockId,
    versionId,
    canManage && !officeView,
    profitability && !officeView ? { preview: !published }
      : unsupportedProfitability || (profitability && officeView) ? { preview: true, auditEnabled: false } : undefined,
  );
  const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Защищенный предпросмотр</title>
  <style>
    html,body,iframe{width:100%;height:100%;margin:0;border:0;background:#fff}
    body{position:relative;overflow:hidden}
    iframe{display:block}
    #data-notice{position:fixed;z-index:10;top:14px;right:14px;max-width:min(420px,calc(100% - 28px));
      box-sizing:border-box;padding:10px 14px;border:1px solid transparent;border-radius:10px;
      box-shadow:0 8px 24px rgba(22,27,46,.18);font:600 14px/1.35 Arial,sans-serif;color:#202333;background:#fff}
    #data-notice[data-kind="success"]{color:#146c3b;background:#eaf8f0;border-color:#bde8cd}
    #data-notice[data-kind="error"]{color:#9d271e;background:#fff0ee;border-color:#f2c4bf}
    #data-notice[data-kind="pending"]{color:#32208c;background:#f0edff;border-color:#d4cbff}
    #data-notice[hidden]{display:none}
  </style>
</head>
<body>
  <iframe
    id="dashboard-frame"
    src="${contentPath}"
    title="HTML-дашборд"
    sandbox="allow-scripts allow-popups"
    referrerpolicy="same-origin"
    allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'; fullscreen *"
    allowfullscreen
  ></iframe>
  <div id="data-notice" role="status" aria-live="polite" hidden></div>
  ${unsupportedProfitability ? '<div role="alert" style="position:fixed;bottom:14px;left:14px;right:14px;padding:12px;background:#fff0ee;color:#9d271e;font:600 14px Arial,sans-serif">Эта версия «Рентабельности» ещё не поддерживает журнал счетов. Загрузка счетов отключена до адаптации HTML; общие данные не изменяются.</div>' : ''}
  <script>${bridgeScript}</script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      'Content-Security-Policy': buildTopDashboardFrameSecurityPolicy(bridgeScript),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=*',
    },
  });
}
