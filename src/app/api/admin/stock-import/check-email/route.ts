import { importStockFromEmail } from '@/entities/catalog/api/stockImport';
import { ExcelProcessingError } from '@/entities/catalog/api/excelProcessing/errors';
import { revalidatePublicCatalog } from '@/entities/catalog/api/catalogRevalidation';
import { requireAdminSession } from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { getClientIp } from '@/shared/lib/rateLimit';
import { runPostCommitTasks } from '@/shared/lib/postCommitTasks';
import { TransactionCommitUnknownError } from '@/shared/lib/db/transactionOutcome';

export async function POST(request: Request) {
  const { denied, session } = await requireAdminSession();
  if (denied) return denied;

  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const limited = await enforceAdminActionRateLimit(session, 'stock_import_check_email', 10, 30 * 60 * 1000);
  if (limited) return limited;

  try {
    const result = await importStockFromEmail();
    const warnings = await runPostCommitTasks([
      ...((result.result?.updatedRows ?? 0) > 0 ? [{
        code: 'stock_catalog_refresh_failed', message: 'Остатки сохранены, но обновление отображения каталога требует повторения.', run: () => revalidatePublicCatalog(),
      }] : []),
      { code: 'stock_security_audit_failed', message: 'Результат проверки сохранён, но запись в журнал безопасности требует повторения.', run: () => recordSecurityEvent({
      eventType: 'stock_import_check_email',
      actorType: 'admin',
      adminUserId: session.adminUserId,
      sessionId: session.sessionId,
      entityType: 'stock_import',
      entityId: result.result?.logId ?? '',
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: {
        processed: result.processed,
        checkedMessages: result.checkedMessages,
        skipped: result.skipped,
        status: result.result?.status,
        updatedRows: result.result?.updatedRows,
        failedRows: result.result?.failedRows,
      },
      }, { required: true }) },
    ]);
    return Response.json({ ...result, warnings: [...(result.warnings ?? []), ...warnings] });
  } catch (error) {
    await runPostCommitTasks([{ code: 'stock_failure_audit_failed', message: 'Не удалось записать ошибку проверки почты в журнал безопасности.', run: () => recordSecurityEvent({
      eventType: 'stock_import_check_email_failed',
      actorType: 'admin',
      adminUserId: session.adminUserId,
      sessionId: session.sessionId,
      entityType: 'stock_import',
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: { error: error instanceof Error ? error.message : 'unknown' },
    }, { required: true }) }]);
    if (error instanceof TransactionCommitUnknownError) {
      return Response.json({ saved: null, code: error.code, error: 'Не удалось подтвердить результат сохранения остатков. Проверьте журнал импорта; не повторяйте ручную загрузку, пока результат не выяснен. При следующей проверке почты уже сохранённое письмо не будет применено заново.' }, { status: 503 });
    }
    if (error instanceof ExcelProcessingError) {
      return Response.json({ saved: false, code: error.code, error: error.message }, {
        status: error.status, headers: { 'Cache-Control': 'private, no-store', ...(error.status === 503 ? { 'Retry-After': '10' } : {}) },
      });
    }
    return Response.json(
      { saved: false, error: error instanceof Error ? error.message : 'Не удалось проверить почту' },
      { status: 400 },
    );
  }
}
