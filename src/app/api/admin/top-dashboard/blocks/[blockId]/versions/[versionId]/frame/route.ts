import {
  isTopDashboardManagementSession,
  requireTopDashboardSession,
} from '@/shared/lib/adminAuth';
import { isPublishedTopDashboardBlockVersion } from '@/shared/lib/db';
import {
  buildTopDashboardFrameSecurityPolicy,
  createTopDashboardFrameBridgeScript,
} from '@/shared/lib/topDashboardContentSecurity';

import { parsePositiveId } from '../../../../routeUtils';

export const runtime = 'nodejs';

type Context = {
  params: Promise<{ blockId: string; versionId: string }>;
};

export async function GET(_request: Request, context: Context) {
  const { denied, session } = await requireTopDashboardSession();
  if (denied) return denied;

  const { blockId: rawBlockId, versionId: rawVersionId } = await context.params;
  const blockId = parsePositiveId(rawBlockId);
  const versionId = parsePositiveId(rawVersionId);
  if (!blockId) return Response.json({ error: 'Некорректный блок' }, { status: 400 });
  if (!versionId) return Response.json({ error: 'Некорректная версия HTML' }, { status: 400 });
  if (
    !isTopDashboardManagementSession(session)
    && !(await isPublishedTopDashboardBlockVersion(blockId, versionId))
  ) {
    return Response.json({ error: 'Версия HTML не найдена' }, { status: 404 });
  }

  const contentPath = `/api/admin/top-dashboard/blocks/${blockId}/versions/${versionId}/content`;
  const bridgeScript = createTopDashboardFrameBridgeScript(blockId);
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
