import { timingSafeEqual } from 'node:crypto';

import { revalidatePublicCatalog } from '@/entities/catalog/api/catalogRevalidation';
import { importStockFromEmail } from '@/entities/catalog/api/stockImport';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { getClientIp } from '@/shared/lib/rateLimit';
import { runPostCommitTasks } from '@/shared/lib/postCommitTasks';
import { TransactionCommitUnknownError } from '@/shared/lib/db/transactionOutcome';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getCronToken(request: Request) {
  const authorization = request.headers.get('authorization') ?? '';
  const bearerPrefix = 'Bearer ';
  if (authorization.startsWith(bearerPrefix)) {
    return authorization.slice(bearerPrefix.length).trim();
  }
  return request.headers.get('x-cron-secret')?.trim() ?? '';
}

function tokensMatch(token: string, secret: string) {
  const tokenBuffer = Buffer.from(token);
  const secretBuffer = Buffer.from(secret);
  return tokenBuffer.length === secretBuffer.length && timingSafeEqual(tokenBuffer, secretBuffer);
}

function assertCronAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return Response.json({ error: 'CRON_SECRET is not configured' }, { status: 503 });
  }

  const token = getCronToken(request);
  if (!token || !tokensMatch(token, secret)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return null;
}

export async function POST(request: Request) {
  const unauthorized = assertCronAuthorized(request);
  if (unauthorized) return unauthorized;

  try {
    const result = await importStockFromEmail();
    const warnings = await runPostCommitTasks([
      ...((result.result?.updatedRows ?? 0) > 0 ? [{
        code: 'stock_catalog_refresh_failed', message: 'Остатки сохранены, но обновление отображения каталога требует повторения.', run: () => revalidatePublicCatalog(),
      }] : []),
      { code: 'stock_security_audit_failed', message: 'Результат проверки сохранён, но запись в журнал безопасности требует повторения.', run: () => recordSecurityEvent({
      eventType: 'stock_import_check_email',
      actorType: 'system',
      entityType: 'stock_import',
      entityId: result.result?.logId ?? '',
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: {
        source: 'cron',
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
      actorType: 'system',
      entityType: 'stock_import',
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: {
        source: 'cron',
        error: error instanceof Error ? error.message : 'unknown',
      },
    }, { required: true }) }]);
    if (error instanceof TransactionCommitUnknownError) {
      return Response.json({ saved: null, code: error.code, error: 'Не удалось подтвердить сохранение остатков. Проверьте журнал импорта. Следующая проверка почты сверит квитанцию и не применит уже сохранённое письмо заново.' }, { status: 503 });
    }
    return Response.json({ saved: false, error: error instanceof Error ? error.message : 'Failed to check stock email' }, { status: 400 });
  }
}
