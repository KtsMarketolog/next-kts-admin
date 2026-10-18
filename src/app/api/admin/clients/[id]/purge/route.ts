import { requireEmployee } from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { publishClientRealtimeEvent } from '@/shared/lib/clientRealtime';
import { purgeArchivedClientCompany } from '@/shared/lib/db/clientArchivePurgeRepo';
import { ClientArchiveConflictError } from '@/shared/lib/db/clientCompaniesRepo';
import { canSeeAllClients } from '@/shared/lib/db/clientCompaniesRepo.helpers';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { TransactionCommitUnknownError } from '@/shared/lib/db/transactionOutcome';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { runPostCommitTasks } from '@/shared/lib/postCommitTasks';
import { getClientIp } from '@/shared/lib/rateLimit';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;
  if (!canSeeAllClients(session)) return Response.json({ saved: false, error: 'Недостаточно прав для окончательного удаления клиента' }, { status: 403 });
  const forbidden = enforceSameOriginRequest(request);
  if (forbidden) return forbidden;
  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    return Response.json({ saved: false, error: 'Некорректная компания клиента' }, { status: 400 });
  }
  const limited = await enforceAdminActionRateLimit(session, 'client_company_purge', 10);
  if (limited) return limited;
  const body = await request.json().catch(() => null);
  if (typeof body?.expectedUpdatedAt !== 'string' || body.expectedUpdatedAt.length > 64 || !Number.isFinite(Date.parse(body.expectedUpdatedAt))) {
    return Response.json({ saved: false, error: 'Сначала обновите проверку последствий удаления.' }, { status: 428 });
  }
  if (typeof body?.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedRevision)) {
    return Response.json({ saved: false, error: 'Сначала обновите проверку последствий удаления.' }, { status: 428 });
  }
  if (typeof body?.confirmationTitle !== 'string' || !body.confirmationTitle || body.confirmationTitle.length > 200) {
    return Response.json({ saved: false, error: 'Для подтверждения введите точное название клиента.' }, { status: 400 });
  }
  let result: Awaited<ReturnType<typeof purgeArchivedClientCompany>>;
  try {
    result = await purgeArchivedClientCompany(numericId, session, {
      expectedUpdatedAt: body.expectedUpdatedAt,
      expectedRevision: body.expectedRevision,
      confirmationTitle: body.confirmationTitle,
    });
  } catch (error) {
    if (error instanceof ClientArchiveConflictError) return Response.json({ saved: false, error: error.message }, { status: 409 });
    if (error instanceof TransactionCommitUnknownError) {
      return Response.json({ saved: null, code: 'COMMIT_OUTCOME_UNKNOWN', error: 'Не удалось подтвердить результат удаления. Обновите архив перед повтором.' }, { status: 503 });
    }
    return Response.json({ saved: false, error: error instanceof Error ? error.message : 'Не удалось удалить клиента' }, { status: 400 });
  }

  // Exact receipts are durable. Physical cleanup is separately confirmed by the
  // maintenance command, not an unbounded batch after an interactive deletion.
  const cleanupPending = result.cleanupIds.length;
  const warnings = await runPostCommitTasks([
    {
      code: 'CLIENT_PURGE_AUDIT_UNAVAILABLE',
      message: 'Клиент окончательно удалён, но запись в журнал не добавлена. Требуется повторить журналирование.',
      run: () => recordSecurityEvent({
        eventType: 'client_company_purged',
        actorType: session.role === 'admin' ? 'admin' : 'wholesale_admin',
        adminUserId: session.adminUserId, managerId: session.managerId, sessionId: session.sessionId,
        entityType: 'client_company', entityId: result.id,
        ip: getClientIp(request), userAgent: request.headers.get('user-agent'), referer: request.headers.get('referer'),
        metadata: { title: result.title, removed: result.removed, detachedPriceLists: result.detachedPriceLists, cleanupQueued: result.cleanupIds.length },
      }, { required: true }),
    },
    {
      code: 'CLIENT_REALTIME_UNAVAILABLE',
      message: 'Клиент окончательно удалён, но уведомление других страниц не отправлено. Обновите их вручную.',
      run: () => publishClientRealtimeEvent({ type: 'client.updated', companyId: result.id }),
    },
  ]);
  if (cleanupPending) warnings.push({
    code: 'CLIENT_FILE_CLEANUP_PENDING',
    message: `Клиент и связанные записи удалены. Заданий очистки файлов, ожидающих проверки администратором: ${cleanupPending}. Прайсы сохранены.`,
  });
  return Response.json({
    ok: true, saved: true, removed: result.removed, detachedPriceLists: result.detachedPriceLists,
    cleanupQueued: result.cleanupIds.length, cleanupPending, warnings,
  });
}
