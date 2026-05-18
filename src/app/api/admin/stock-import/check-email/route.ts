import { importStockFromEmail } from '@/entities/catalog/api/stockImport';
import { revalidatePublicCatalog } from '@/entities/catalog/api/catalogRevalidation';
import { requireAdminSession } from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { getClientIp } from '@/shared/lib/rateLimit';

export async function POST(request: Request) {
  const { denied, session } = await requireAdminSession();
  if (denied) return denied;

  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const limited = await enforceAdminActionRateLimit(session, 'stock_import_check_email', 10, 30 * 60 * 1000);
  if (limited) return limited;

  try {
    const result = await importStockFromEmail();
    if ((result.result?.updatedRows ?? 0) > 0) {
      revalidatePublicCatalog();
    }
    await recordSecurityEvent({
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
    });
    return Response.json(result);
  } catch (error) {
    await recordSecurityEvent({
      eventType: 'stock_import_check_email_failed',
      actorType: 'admin',
      adminUserId: session.adminUserId,
      sessionId: session.sessionId,
      entityType: 'stock_import',
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: { error: error instanceof Error ? error.message : 'unknown' },
    });
    return Response.json(
      { error: error instanceof Error ? error.message : 'Не удалось проверить почту' },
      { status: 400 },
    );
  }
}
