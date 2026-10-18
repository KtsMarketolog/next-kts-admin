import { requireEmployee } from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { restoreClientCompany, ClientArchiveConflictError } from '@/shared/lib/db';
import { publishClientRealtimeEvent } from '@/shared/lib/clientRealtime';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { TransactionCommitUnknownError } from '@/shared/lib/db/transactionOutcome';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { runPostCommitTasks } from '@/shared/lib/postCommitTasks';
import { getClientIp } from '@/shared/lib/rateLimit';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;
  const forbidden = enforceSameOriginRequest(request);
  if (forbidden) return forbidden;
  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    return Response.json({ saved: false, error: 'Некорректная компания клиента' }, { status: 400 });
  }
  const limited = await enforceAdminActionRateLimit(session, 'client_company_restore', 30);
  if (limited) return limited;
  const body = await request.json().catch(() => null);
  const expectedUpdatedAt = body?.expectedUpdatedAt;
  if (typeof expectedUpdatedAt !== 'string' || expectedUpdatedAt.length > 64 || !Number.isFinite(Date.parse(expectedUpdatedAt))) {
    return Response.json({ saved: false, error: 'Обновите страницу перед восстановлением клиента.' }, { status: 428 });
  }
  try {
    const company = await restoreClientCompany(numericId, session, expectedUpdatedAt);
    const warnings = await runPostCommitTasks([
      {
        code: 'CLIENT_REALTIME_UNAVAILABLE',
        message: 'Клиент восстановлен, но уведомление других страниц не отправлено. Обновите их вручную.',
        run: () => publishClientRealtimeEvent({ type: 'client.updated', companyId: company.id }),
      },
      {
        code: 'CLIENT_RESTORE_AUDIT_UNAVAILABLE',
        message: 'Клиент восстановлен, но запись в журнал не добавлена. Требуется повторить журналирование.',
        run: () => recordSecurityEvent({
          eventType: 'client_company_restored',
          actorType: session.role === 'admin' ? 'admin' : session.role === 'wholesale_admin' ? 'wholesale_admin' : 'manager',
          adminUserId: session.adminUserId,
          managerId: session.managerId,
          sessionId: session.sessionId,
          entityType: 'client_company',
          entityId: company.id,
          ip: getClientIp(request),
          userAgent: request.headers.get('user-agent'),
          referer: request.headers.get('referer'),
          metadata: { title: company.title, accessEnabled: company.isActive },
        }, { required: true }),
      },
    ]);
    return Response.json({ ok: true, saved: true, company, warnings });
  } catch (error) {
    if (error instanceof ClientArchiveConflictError) {
      return Response.json({ saved: false, error: error.message }, { status: 409 });
    }
    if (error instanceof TransactionCommitUnknownError) {
      return Response.json({ saved: null, code: 'COMMIT_OUTCOME_UNKNOWN', error: 'Не удалось подтвердить восстановление. Обновите список перед повтором.' }, { status: 503 });
    }
    return Response.json({ saved: false, error: error instanceof Error ? error.message : 'Не удалось восстановить клиента' }, { status: 400 });
  }
}
