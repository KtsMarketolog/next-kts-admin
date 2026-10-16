import { getAdminSession } from '@/shared/lib/adminAuth';
import { canAccessCurrencyDashboard, canManageCurrencyDashboard, CURRENCY_PRIVATE_HEADERS } from '@/shared/lib/currencyDashboardAccess';
import { renderCurrencyDashboardHtml, buildCurrencyDashboardContentSecurityPolicy } from '@/shared/lib/currencyDashboardHtml';
import { getBuiltinCurrencyDashboardHtmlSeed } from '@/shared/lib/currencyDashboardHtmlUpload';
import {
  CurrencyHtmlError, ensureCurrencyDashboardHtmlSeed, getCurrencyDashboardHtmlVersion, getPublishedCurrencyDashboardHtml,
} from '@/shared/lib/db/currencyDashboardHtmlRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const errorResponse = (message: string, status: number) => new Response(message, { status, headers: CURRENCY_PRIVATE_HEADERS });
  try {
    const session = await getAdminSession();
    if (!canAccessCurrencyDashboard(session)) return errorResponse('Нет доступа к дашборду', session ? 403 : 401);
    const forbidden = enforceSameOriginRequest(request);
    if (forbidden) {
      for (const [key, value] of Object.entries(CURRENCY_PRIVATE_HEADERS)) forbidden.headers.set(key, value);
      return forbidden;
    }
    const params = new URL(request.url).searchParams;
    const allowed = ['nonce', 'readOnly', 'previewVersion'];
    if ([...params.keys()].some((key) => !allowed.includes(key) || params.getAll(key).length !== 1)) return errorResponse('Некорректные параметры запроса', 400);
    const nonce = params.get('nonce') ?? '';
    if (!/^[a-f0-9-]{36}$/.test(nonce)
      || (params.has('readOnly') && !['0', '1'].includes(params.get('readOnly')!))) {
      return errorResponse('Некорректный запрос', 400);
    }
    const preview = params.has('previewVersion');
    const canManage = canManageCurrencyDashboard(session);
    // A view grant must never expose staged or archived HTML, even with a guessed version ID.
    if (preview && !canManage) return errorResponse('Нет прав на предпросмотр HTML-версий', 403);
    const previewId = Number(params.get('previewVersion'));
    if (preview && (!/^[1-9][0-9]{0,15}$/.test(params.get('previewVersion')!) || !Number.isSafeInteger(previewId))) return errorResponse('Некорректный номер HTML-версии', 400);
    const parentOrigin = new URL(request.headers.get('referer') ?? request.url).origin;
    await ensureCurrencyDashboardHtmlSeed(getBuiltinCurrencyDashboardHtmlSeed());
    const selected = preview ? await getCurrencyDashboardHtmlVersion(previewId) : await getPublishedCurrencyDashboardHtml();
    if (!selected) return errorResponse(preview ? 'HTML-версия не найдена' : 'Опубликованная HTML-версия недоступна', preview ? 404 : 503);
    const readOnly = preview || params.get('readOnly') === '1';
    const html = renderCurrencyDashboardHtml(nonce, parentOrigin, !readOnly && canManage, selected.htmlContent, { trackUsage: !preview });
    return new Response(html, {
      headers: { ...CURRENCY_PRIVATE_HEADERS, 'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': buildCurrencyDashboardContentSecurityPolicy(html) },
    });
  } catch (error) {
    if (error instanceof CurrencyHtmlError) return errorResponse(error.message, error.status);
    console.error('CURRENCY_HTML_FRAME_FAILED', error instanceof Error ? error.message : 'unknown');
    return errorResponse('Не удалось открыть HTML дашборда. Сохранённые данные не изменены.', 503);
  }
}
