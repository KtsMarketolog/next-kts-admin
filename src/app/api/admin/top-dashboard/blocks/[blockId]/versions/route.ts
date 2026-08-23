import { requireTopDashboardSession } from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import {
  createTopDashboardBlockVersion,
  TopDashboardBlockNotFoundError,
} from '@/shared/lib/db';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { getClientIp } from '@/shared/lib/rateLimit';

import {
  errorResponse,
  parsePositiveId,
  readTopDashboardHtmlUpload,
} from '../../routeUtils';

export const runtime = 'nodejs';

type Context = {
  params: Promise<{ blockId: string }>;
};

export async function POST(request: Request, context: Context) {
  const { denied, session } = await requireTopDashboardSession();
  if (denied) return denied;

  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const limited = await enforceAdminActionRateLimit(
    session,
    'top_dashboard_block_upload',
    10,
    30 * 60 * 1000,
  );
  if (limited) return limited;

  const { blockId: rawBlockId } = await context.params;
  const blockId = parsePositiveId(rawBlockId);
  if (!blockId) return errorResponse('Некорректный блок');

  try {
    const parsed = await readTopDashboardHtmlUpload(request);
    if (parsed.error) return parsed.error;

    const version = await createTopDashboardBlockVersion({
      blockId,
      ...parsed.upload,
      uploadedByAdminUserId: session.adminUserId ?? null,
    });

    await recordSecurityEvent({
      eventType: 'top_dashboard_version_uploaded',
      actorType: session.role === 'top' ? 'top' : 'admin',
      adminUserId: session.adminUserId,
      sessionId: session.sessionId,
      entityType: 'top_dashboard_block_version',
      entityId: `${blockId}:${version.id}`,
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: {
        blockId,
        versionId: version.id,
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
    if (error instanceof TopDashboardBlockNotFoundError) {
      return errorResponse(error.message, 404);
    }
    console.error('Failed to upload TOP dashboard block HTML', error);
    return errorResponse('Не удалось загрузить HTML-файл', 500);
  }
}
