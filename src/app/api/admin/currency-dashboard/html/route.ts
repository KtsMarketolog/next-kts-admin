import { getAdminSession, type AdminSession } from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { canAccessCurrencyDashboard, canManageCurrencyDashboard, CURRENCY_PRIVATE_HEADERS } from '@/shared/lib/currencyDashboardAccess';
import { getBuiltinCurrencyDashboardHtmlSeed, inspectCurrencyDashboardUpload } from '@/shared/lib/currencyDashboardHtmlUpload';
import {
  CURRENCY_HTML_MAX_BYTES, CurrencyHtmlConflictError, CurrencyHtmlError,
  createCurrencyDashboardHtmlVersion, ensureCurrencyDashboardHtmlSeed,
  getCurrencyDashboardHtmlState, getCurrencyDashboardHtmlVersion,
  publishCurrencyDashboardHtmlVersion, rollbackCurrencyDashboardHtmlVersion,
} from '@/shared/lib/db/currencyDashboardHtmlRepo';
import { recordSecurityEvent, type SecurityEventType } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: CURRENCY_PRIVATE_HEADERS });
function privateResponse(response: Response) {
  for (const [key, value] of Object.entries(CURRENCY_PRIVATE_HEADERS)) response.headers.set(key, value);
  return response;
}
async function access(request: Request, write: boolean) {
  const session = await getAdminSession();
  if (!canAccessCurrencyDashboard(session) || !canManageCurrencyDashboard(session)) {
    return { denied: json({ error: 'Нет прав на управление HTML дашборда', code: 'CURRENCY_READ_ONLY' }, session ? 403 : 401) };
  }
  if ([...new URL(request.url).searchParams].length) return { denied: json({ error: 'Неизвестные параметры запроса' }, 400) };
  if (write) {
    const forbidden = enforceSameOriginRequest(request);
    if (forbidden) return { denied: privateResponse(forbidden) };
  }
  const limited = await enforceAdminActionRateLimit(session, write ? 'currency-dashboard-html-write' : 'currency-dashboard-html-read', write ? 20 : 120);
  if (limited) return { denied: privateResponse(limited) };
  const isManager = session.role === 'manager' || session.role === 'support_manager';
  return { session, actor: `${session.role}:${isManager ? session.managerId : session.adminUserId ?? 'primary'}` };
}
function failure(error: unknown) {
  if (error instanceof CurrencyHtmlConflictError) return json({ error: error.message, code: error.code, revision: error.currentRevision }, 409);
  if (error instanceof CurrencyHtmlError) return json({ error: error.message, code: error.code }, error.status);
  console.error('CURRENCY_HTML_REQUEST_FAILED', error instanceof Error ? error.message : 'unknown');
  return json({ error: 'Не удалось выполнить действие с HTML. Опубликованный отчёт и его данные не удалены.' }, 503);
}
async function ready() { await ensureCurrencyDashboardHtmlSeed(getBuiltinCurrencyDashboardHtmlSeed()); }
function inspect(html: string) {
  try { return inspectCurrencyDashboardUpload(html); }
  catch (error) {
    throw new CurrencyHtmlError(error instanceof Error ? error.message.slice(0, 500) : 'HTML не совместим с дашбордом курсов', 'CURRENCY_HTML_INCOMPATIBLE');
  }
}
async function audit(session: AdminSession, eventType: SecurityEventType, versionId: number | null, revision: number) {
  const isManager = session.role === 'manager' || session.role === 'support_manager';
  try {
    await recordSecurityEvent({ eventType, actorType: session.role === 'support_manager' ? 'manager' : session.role,
      adminUserId: isManager ? undefined : session.adminUserId, managerId: isManager ? session.managerId : undefined,
      sessionId: session.sessionId, entityType: 'currency_dashboard_html', entityId: versionId, metadata: { revision } });
  } catch {
    // The HTML transaction has committed. A secondary audit failure must not report an unsuccessful save.
    console.error('CURRENCY_HTML_AUDIT_FAILED', eventType);
  }
}
async function readBytes(request: Request, maximum: number) {
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new CurrencyHtmlError('Запрос превышает допустимый размер', 'CURRENCY_HTML_TOO_LARGE', 413);
  if (!request.body) throw new CurrencyHtmlError('Пустой запрос');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximum) throw new CurrencyHtmlError('Запрос превышает допустимый размер', 'CURRENCY_HTML_TOO_LARGE', 413);
      chunks.push(part.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

export async function GET(request: Request) {
  try {
    const auth = await access(request, false);
    if (auth.denied) return auth.denied;
    await ready();
    return json(await getCurrencyDashboardHtmlState());
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    const auth = await access(request, true);
    if (auth.denied) return auth.denied;
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;')) throw new CurrencyHtmlError('Загрузите HTML-файл через форму', 'CURRENCY_HTML_MEDIA_TYPE', 415);
    const bytes = await readBytes(request, CURRENCY_HTML_MAX_BYTES + 64 * 1024);
    let form: FormData;
    try {
      form = await new Request(request.url, { method: 'POST', headers: { 'content-type': request.headers.get('content-type')! }, body: bytes }).formData();
    } catch { throw new CurrencyHtmlError('Не удалось прочитать загруженный файл'); }
    if ([...form.keys()].some((key) => key !== 'file') || form.getAll('file').length !== 1) throw new CurrencyHtmlError('Загрузите один HTML-файл');
    const file = form.get('file');
    if (!file || typeof file === 'string' || !/\.html?$/i.test(file.name)) throw new CurrencyHtmlError('Нужен файл .html или .htm');
    if (file.size > CURRENCY_HTML_MAX_BYTES) throw new CurrencyHtmlError('HTML больше 2 МБ', 'CURRENCY_HTML_TOO_LARGE', 413);
    let htmlContent: string;
    try { htmlContent = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
    catch { throw new CurrencyHtmlError('HTML должен быть сохранён в кодировке UTF-8'); }
    const metadata = inspect(htmlContent);
    await ready();
    const result = await createCurrencyDashboardHtmlVersion({ htmlContent, originalName: file.name, sourceVersion: metadata.sourceVersion, actor: auth.actor! });
    await audit(auth.session!, 'currency_dashboard_html_uploaded', result.version.id, result.revision);
    return json(result, 201);
  } catch (error) { return failure(error); }
}

export async function PATCH(request: Request) {
  try {
    const auth = await access(request, true);
    if (auth.denied) return auth.denied;
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new CurrencyHtmlError('Ожидается JSON', 'CURRENCY_HTML_MEDIA_TYPE', 415);
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBytes(request, 4096)));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
      body = parsed as Record<string, unknown>;
    } catch (error) { if (error instanceof CurrencyHtmlError) throw error; throw new CurrencyHtmlError('Некорректный JSON'); }
    const publish = body.action === 'publish';
    const allowed = publish ? ['action', 'versionId', 'expectedRevision'] : ['action', 'expectedRevision'];
    if ((!publish && body.action !== 'rollback') || Object.keys(body).some((key) => !allowed.includes(key))
      || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0
      || (publish && (!Number.isSafeInteger(body.versionId) || Number(body.versionId) < 1))) throw new CurrencyHtmlError('Укажите действие, версию и актуальную ревизию');
    await ready();
    const before = await getCurrencyDashboardHtmlState();
    if (before.revision !== body.expectedRevision) throw new CurrencyHtmlConflictError(before.revision);
    const targetId = publish ? Number(body.versionId) : before.previousVersionId;
    if (!targetId) throw new CurrencyHtmlError('Предыдущей опубликованной HTML-версии ещё нет', 'CURRENCY_HTML_NO_PREVIOUS');
    const target = await getCurrencyDashboardHtmlVersion(targetId);
    if (!target) throw new CurrencyHtmlError('HTML-версия не найдена', 'CURRENCY_HTML_NOT_FOUND', 404);
    // Revalidate against the currently deployed adapter, including old uploaded drafts.
    inspect(target.htmlContent);
    const result = publish
      ? await publishCurrencyDashboardHtmlVersion(targetId, Number(body.expectedRevision), auth.actor!)
      : await rollbackCurrencyDashboardHtmlVersion(Number(body.expectedRevision), auth.actor!);
    await audit(auth.session!, publish ? 'currency_dashboard_html_published' : 'currency_dashboard_html_rolled_back', result.activeVersionId, result.revision);
    return json(result);
  } catch (error) { return failure(error); }
}
