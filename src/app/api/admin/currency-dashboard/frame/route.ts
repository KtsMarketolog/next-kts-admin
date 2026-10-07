import { getAdminSession } from '@/shared/lib/adminAuth';
import { canAccessCurrencyDashboard, canManageCurrencyDashboard, CURRENCY_PRIVATE_HEADERS } from '@/shared/lib/currencyDashboardAccess';
import { renderCurrencyDashboardHtml, buildCurrencyDashboardContentSecurityPolicy } from '@/shared/lib/currencyDashboardHtml';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const session = await getAdminSession();
  if (!canAccessCurrencyDashboard(session)) {
    return new Response('Нет доступа к дашборду', { status: session ? 403 : 401, headers: CURRENCY_PRIVATE_HEADERS });
  }
  const forbidden = enforceSameOriginRequest(request);
  if (forbidden) return forbidden;
  const nonce = new URL(request.url).searchParams.get('nonce') ?? '';
  if (!/^[a-f0-9-]{36}$/.test(nonce)) return new Response('Некорректный запрос', { status: 400, headers: CURRENCY_PRIVATE_HEADERS });
  const parentOrigin = new URL(request.headers.get('referer') ?? request.url).origin;
  const readOnly = new URL(request.url).searchParams.get('readOnly') === '1';
  const html = renderCurrencyDashboardHtml(nonce, parentOrigin, !readOnly && canManageCurrencyDashboard(session));
  return new Response(html, {
    headers: { ...CURRENCY_PRIVATE_HEADERS, 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': buildCurrencyDashboardContentSecurityPolicy(html) },
  });
}
