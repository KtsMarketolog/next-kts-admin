import { getAdminSession } from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { canReviewDashboardUsage } from '@/shared/lib/dashboardUsageAccess';
import { MAX_PROFITABILITY_AUDIT_BODY, parseProfitabilityAuditRequest } from '@/shared/lib/dashboardProfitabilityAudit';
import { ProfitabilityAuditError, readDashboardProfitabilityAudit, recordDashboardProfitabilityAudit } from '@/shared/lib/db/dashboardProfitabilityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (data: unknown, status = 200) => Response.json(data, { status, headers });

/** Bound even chunked bodies; never log invoice contents on a parse or database failure. */
async function readBody(request: Request) {
  if (!request.body || Number(request.headers.get('content-length')) > MAX_PROFITABILITY_AUDIT_BODY) throw new RangeError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new RangeError()), 10_000); });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_PROFITABILITY_AUDIT_BODY || chunks.length >= 8192) throw new RangeError();
      chunks.push(part.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    clearTimeout(timeout);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function POST(request: Request) {
  const session = await getAdminSession();
  if (!session?.sessionId) return json({ error: 'Нет доступа' }, 401);
  const forbidden = enforceSameOriginRequest(request);
  if (forbidden) return forbidden;
  if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'Нужен JSON' }, 415);
  const limited = await enforceAdminActionRateLimit(session, 'profitability-audit-write', 120, 60_000);
  if (limited) return limited;
  let input;
  try { input = parseProfitabilityAuditRequest(await readBody(request)); }
  catch (error) { return json({ error: error instanceof RangeError ? 'Превышен размер или время передачи детализации' : 'Некорректная детализация' }, error instanceof RangeError ? 413 : 400); }
  try {
    const saved = await recordDashboardProfitabilityAudit(session, input);
    return json({ ok: true, id: saved.id });
  } catch (error) {
    if (error instanceof ProfitabilityAuditError) return json({ error: error.message }, error.status);
    console.error('PROFITABILITY_AUDIT_WRITE_FAILED');
    return json({ error: 'Журнал временно недоступен' }, 503);
  }
}

export async function GET(request: Request) {
  const session = await getAdminSession();
  if (!session || !canReviewDashboardUsage(session)) return json({ error: 'Нет доступа' }, session ? 403 : 401);
  const id = new URL(request.url).searchParams.get('id');
  if (!id || !/^[1-9][0-9]{0,17}$/.test(id)) return json({ error: 'Некорректное событие' }, 400);
  const limited = await enforceAdminActionRateLimit(session, 'profitability-audit-read', 60, 60_000);
  if (limited) return limited;
  try {
    const invoice = await readDashboardProfitabilityAudit(session, id);
    return invoice ? json({ invoice }) : json({ error: 'Запись отсутствует или срок хранения истёк' }, 404);
  } catch (error) {
    if (error instanceof ProfitabilityAuditError) return json({ error: error.message }, error.status);
    console.error('PROFITABILITY_AUDIT_READ_FAILED');
    return json({ error: 'Журнал временно недоступен' }, 503);
  }
}
