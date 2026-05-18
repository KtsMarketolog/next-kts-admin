import { timingSafeEqual } from 'node:crypto';

import { revalidatePublicCatalog } from '@/entities/catalog/api/catalogRevalidation';
import { importStockFromEmail } from '@/entities/catalog/api/stockImport';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { getClientIp } from '@/shared/lib/rateLimit';

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
    if ((result.result?.updatedRows ?? 0) > 0) {
      revalidatePublicCatalog();
    }
    await recordSecurityEvent({
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
    });
    return Response.json(result);
  } catch (error) {
    await recordSecurityEvent({
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
    });
    return Response.json({ error: error instanceof Error ? error.message : 'Failed to check stock email' }, { status: 400 });
  }
}
