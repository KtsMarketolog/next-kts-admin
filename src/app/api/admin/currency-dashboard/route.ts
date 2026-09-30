import { getAdminSession } from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { canAccessCurrencyDashboard, canManageCurrencyDashboard, CURRENCY_PRIVATE_HEADERS } from '@/shared/lib/currencyDashboardAccess';
import { CurrencyDashboardValidationError } from '@/shared/lib/currencyDashboardModel';
import { CurrencyRequestError, readCurrencyRpcRequest } from '@/shared/lib/currencyDashboardRpc';
import { CurrencySourceError, getCurrencySource } from '@/shared/lib/currencyDashboardSources';
import {
  CurrencySnapshotConflictError, CurrencySnapshotPreviousMissingError,
  getCurrencyBaselines, readCurrencySnapshot, rollbackCurrencySnapshot, writeCurrencySnapshot,
} from '@/shared/lib/db/currencyDashboardRepo';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: CURRENCY_PRIVATE_HEADERS });

export async function POST(request: Request) {
  // Every operation, including sources and history, rechecks the persisted role.
  const session = await getAdminSession();
  if (!canAccessCurrencyDashboard(session)) return json({ error: 'Нет доступа к дашборду' }, session ? 403 : 401);
  const forbidden = enforceSameOriginRequest(request);
  if (forbidden) return forbidden;
  const limited = await enforceAdminActionRateLimit(session, 'currency-dashboard', 600);
  if (limited) return limited;

  try {
    const { method, params } = await readCurrencyRpcRequest(request);
    if (method === 'snapshot:get') return json(await readCurrencySnapshot());
    if (method === 'baselines:get') return json(await getCurrencyBaselines());
    if (method === 'source') {
      if (typeof params.kind !== 'string') throw new CurrencyRequestError('Укажите источник данных');
      const { kind, ...sourceParams } = params;
      return json(await getCurrencySource(kind, sourceParams));
    }
    if (!canManageCurrencyDashboard(session)) {
      return json({ error: 'Нет прав на изменение данных дашборда', code: 'CURRENCY_READ_ONLY' }, 403);
    }
    const writesLimited = await enforceAdminActionRateLimit(session, 'currency-dashboard-save', 60);
    if (writesLimited) return writesLimited;
    const actor = `${session.role}:${session.adminUserId ?? 'primary'}`;
    const expectedRevision = params.expectedRevision as number;
    const state = method === 'snapshot:save'
      ? await writeCurrencySnapshot(params.snapshot, expectedRevision, actor)
      : await rollbackCurrencySnapshot(expectedRevision, actor);
    await recordSecurityEvent({
      eventType: method === 'snapshot:save' ? 'currency_dashboard_saved' : 'currency_dashboard_rolled_back',
      actorType: session.role, adminUserId: session.adminUserId, sessionId: session.sessionId,
      entityType: 'currency_dashboard', entityId: state.revision,
      metadata: { revision: state.revision, previousRevision: expectedRevision },
    });
    return json(state);
  } catch (error) {
    if (error instanceof CurrencySnapshotConflictError) {
      return json({ error: error.message, code: error.code, revision: error.currentRevision }, 409);
    }
    if (error instanceof CurrencyDashboardValidationError || error instanceof CurrencySnapshotPreviousMissingError) {
      return json({ error: error.message, code: error.code }, 400);
    }
    if (error instanceof CurrencyRequestError) return json({ error: error.message }, error.status);
    if (error instanceof CurrencySourceError) {
      return json({ error: error.message, code: error.code }, error.code === 'CURRENCY_SOURCE_UNAVAILABLE' ? 503 : 400);
    }
    console.error('CURRENCY_DASHBOARD_REQUEST_FAILED', error instanceof Error ? error.message : 'unknown');
    return json({ error: 'Не удалось получить или сохранить данные. Предыдущая сохранённая версия не удалена.' }, 503);
  }
}
