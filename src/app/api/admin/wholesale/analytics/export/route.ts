import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { requireWholesaleAdminSession } from '@/shared/lib/adminAuth';
import {
  getWholesaleAdminAnalytics,
  getWholesaleManagerAnalyticsExtended,
  type WholesaleAdminAnalyticsPeriod,
} from '@/shared/lib/db';
import { sendSystemMail } from '@/shared/lib/mailer';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import {
  buildWholesaleAnalyticsReport,
  renderWholesaleAnalyticsExport,
  type WholesaleAnalyticsExportFormat,
} from '@/shared/lib/wholesaleAnalyticsExport';
import { normalizeTextField } from '@/shared/lib/wholesaleSecurity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parsePeriod(value: unknown): WholesaleAdminAnalyticsPeriod {
  return value === '7d' || value === '30d' || value === 'all' ? value : '30d';
}

function parseFormat(value: unknown): WholesaleAnalyticsExportFormat {
  return value === 'xls' ? 'xls' : 'pdf';
}

function parseManagerId(value: unknown) {
  if (value === null || value === undefined || value === '' || value === 'all') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 160;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function loadReport(period: WholesaleAdminAnalyticsPeriod, managerId: number | null) {
  if (managerId) {
    const analytics = await getWholesaleManagerAnalyticsExtended(managerId, period);
    if (!analytics) return null;
    return buildWholesaleAnalyticsReport(analytics, period, 'manager');
  }

  const analytics = await getWholesaleAdminAnalytics(period);
  return buildWholesaleAnalyticsReport(analytics, period, 'admin');
}

export async function GET(request: Request) {
  const { denied, session } = await requireWholesaleAdminSession();
  if (denied) return denied;

  const limited = await enforceAdminActionRateLimit(session, 'wholesale_analytics_export_download', 80);
  if (limited) return limited;

  const url = new URL(request.url);
  const period = parsePeriod(url.searchParams.get('period'));
  const format = parseFormat(url.searchParams.get('format'));
  const managerId = parseManagerId(url.searchParams.get('managerId'));
  const report = await loadReport(period, managerId);
  if (!report) return Response.json({ error: 'Manager not found' }, { status: 404 });

  const file = await renderWholesaleAnalyticsExport(report, format);
  return new Response(new Uint8Array(file.content), {
    headers: {
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'Cache-Control': 'private, no-store',
    },
  });
}

export async function POST(request: Request) {
  const { denied, session } = await requireWholesaleAdminSession();
  if (denied) return denied;

  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const limited = await enforceAdminActionRateLimit(session, 'wholesale_analytics_export_email', 30);
  if (limited) return limited;

  const body = await request.json().catch(() => ({}));
  const email = normalizeTextField(body.email, 160);
  if (!isValidEmail(email)) {
    return Response.json({ error: 'Укажите корректный email' }, { status: 400 });
  }

  const period = parsePeriod(body.period);
  const format = parseFormat(body.format);
  const managerId = parseManagerId(body.managerId);
  const report = await loadReport(period, managerId);
  if (!report) return Response.json({ error: 'Manager not found' }, { status: 404 });

  const file = await renderWholesaleAnalyticsExport(report, format);
  await sendSystemMail({
    to: email,
    subject: report.title,
    text: `${report.title}\n${report.subtitle}\n\nФайл с аналитикой во вложении.`,
    html: `<p><strong>${escapeHtml(report.title)}</strong></p><p>${escapeHtml(report.subtitle)}</p><p>Файл с аналитикой во вложении.</p>`,
    attachments: [
      {
        filename: file.filename,
        content: file.content,
        contentType: file.contentType,
      },
    ],
  });

  return Response.json({ ok: true });
}
