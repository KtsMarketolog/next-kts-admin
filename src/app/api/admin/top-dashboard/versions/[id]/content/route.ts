import { requireTopDashboardSession } from '@/shared/lib/adminAuth';
import { getTopDashboardVersionContent } from '@/shared/lib/db';
import {
  buildTopDashboardContentSecurityPolicy,
  isTopDashboardFrameRequest,
} from '@/shared/lib/topDashboardContentSecurity';

export const runtime = 'nodejs';

type Context = {
  params: Promise<{ id: string }>;
};

function parseId(value: string) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(request: Request, context: Context) {
  const { denied } = await requireTopDashboardSession();
  if (denied) return denied;

  const { id } = await context.params;
  const versionId = parseId(id);
  if (!versionId) return Response.json({ error: 'Некорректная версия HTML' }, { status: 400 });
  if (!isTopDashboardFrameRequest(request, versionId)) {
    return Response.json({ error: 'HTML доступен только в защищенном предпросмотре' }, { status: 403 });
  }

  try {
    const version = await getTopDashboardVersionContent(versionId);
    if (!version) return Response.json({ error: 'Версия HTML не найдена' }, { status: 404 });

    const bytes = Buffer.from(version.htmlContent, 'utf8');
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': String(bytes.length),
        'Content-Disposition': 'inline; filename="dashboard.html"',
        'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
        'Content-Security-Policy': buildTopDashboardContentSecurityPolicy(version.htmlContent),
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        'X-DNS-Prefetch-Control': 'off',
        'Referrer-Policy': 'no-referrer',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      },
    });
  } catch (error) {
    console.error('Failed to read TOP dashboard HTML', error);
    return Response.json({ error: 'Не удалось открыть HTML-файл' }, { status: 500 });
  }
}
