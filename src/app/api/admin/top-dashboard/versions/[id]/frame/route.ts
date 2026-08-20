import { requireTopDashboardSession } from '@/shared/lib/adminAuth';

export const runtime = 'nodejs';

type Context = {
  params: Promise<{ id: string }>;
};

function parseId(value: string) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(_request: Request, context: Context) {
  const { denied } = await requireTopDashboardSession();
  if (denied) return denied;

  const { id } = await context.params;
  const versionId = parseId(id);
  if (!versionId) return Response.json({ error: 'Некорректная версия HTML' }, { status: 400 });

  const contentPath = `/api/admin/top-dashboard/versions/${versionId}/content`;
  const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Защищенный предпросмотр</title>
  <style>
    html,body,iframe{width:100%;height:100%;margin:0;border:0;background:#fff}
    body{overflow:hidden}
    iframe{display:block}
  </style>
</head>
<body>
  <iframe
    src="${contentPath}"
    title="Стратегический обзор"
    sandbox="allow-scripts"
    referrerpolicy="same-origin"
    allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'"
  ></iframe>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      'Content-Security-Policy': [
        "default-src 'none'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'self'",
        "frame-src 'self'",
        "child-src 'self'",
        "form-action 'none'",
        "script-src 'none'",
        "style-src 'unsafe-inline'",
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Referrer-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    },
  });
}
