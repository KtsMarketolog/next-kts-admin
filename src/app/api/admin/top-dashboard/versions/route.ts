import { createHash } from 'crypto';

import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { requireTopDashboardSession } from '@/shared/lib/adminAuth';
import { createTopDashboardVersion } from '@/shared/lib/db';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { getClientIp } from '@/shared/lib/rateLimit';

export const runtime = 'nodejs';

const MAX_TOP_DASHBOARD_BYTES = 5 * 1024 * 1024;
const MAX_MULTIPART_OVERHEAD_BYTES = 256 * 1024;
const HTML_DOCUMENT_MARKER = /(?:<!doctype\s+html(?:\s|>)|<html(?:\s|>))/i;

function errorResponse(error: string, status = 400) {
  return Response.json({ error }, { status });
}

function normalizeOriginalName(value: string) {
  return value
    .replace(/[\\/:*?"<>|\r\n\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220) || 'dashboard.html';
}

function contentLengthTooLarge(request: Request) {
  const value = request.headers.get('content-length');
  if (!value) return false;
  const length = Number(value);
  return Number.isFinite(length) && length > MAX_TOP_DASHBOARD_BYTES + MAX_MULTIPART_OVERHEAD_BYTES;
}

export async function POST(request: Request) {
  const { denied, session } = await requireTopDashboardSession();
  if (denied) return denied;
  if (!session.adminUserId) {
    return errorResponse('Для загрузки требуется учетная запись сотрудника', 403);
  }

  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const limited = await enforceAdminActionRateLimit(session, 'top_dashboard_upload', 10, 30 * 60 * 1000);
  if (limited) return limited;

  if (contentLengthTooLarge(request)) {
    return errorResponse('HTML-файл должен быть не больше 5 МБ', 413);
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!(file instanceof File)) return errorResponse('Выберите HTML-файл');
    if (file.size <= 0) return errorResponse('HTML-файл пустой');
    if (file.size > MAX_TOP_DASHBOARD_BYTES) {
      return errorResponse('HTML-файл должен быть не больше 5 МБ', 413);
    }
    if (!/\.html?$/i.test(file.name)) {
      return errorResponse('Загрузите файл с расширением .html или .htm');
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length <= 0) return errorResponse('HTML-файл пустой');
    if (bytes.length > MAX_TOP_DASHBOARD_BYTES) {
      return errorResponse('HTML-файл должен быть не больше 5 МБ', 413);
    }
    if (bytes.includes(0)) {
      return errorResponse('HTML-файл содержит недопустимые нулевые байты');
    }

    let htmlContent = '';
    try {
      htmlContent = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return errorResponse('HTML-файл должен быть сохранен в кодировке UTF-8');
    }

    if (!HTML_DOCUMENT_MARKER.test(htmlContent)) {
      return errorResponse('В файле не найден полноценный HTML-документ');
    }

    const version = await createTopDashboardVersion({
      originalName: normalizeOriginalName(file.name),
      htmlContent,
      fileSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      uploadedByAdminUserId: session.adminUserId,
    });

    await recordSecurityEvent({
      eventType: 'top_dashboard_version_uploaded',
      actorType: session.role === 'top' ? 'top' : 'admin',
      adminUserId: session.adminUserId,
      sessionId: session.sessionId,
      entityType: 'top_dashboard_version',
      entityId: version.id,
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: {
        originalName: version.originalName,
        fileSize: version.fileSize,
        sha256: version.sha256,
      },
    });

    return Response.json(
      { version },
      {
        status: 201,
        headers: { 'Cache-Control': 'private, no-store' },
      },
    );
  } catch (error) {
    console.error('Failed to upload TOP dashboard HTML', error);
    return errorResponse('Не удалось загрузить HTML-файл', 500);
  }
}
