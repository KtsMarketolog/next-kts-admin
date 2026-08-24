import { getTopDashboardActor, requireTopDashboardManagementSession } from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import {
  deleteTopDashboardBlockVersion,
  TopDashboardActiveVersionDeleteError,
  TopDashboardBlockNotFoundError,
  TopDashboardVersionNotFoundError,
} from '@/shared/lib/db';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { getClientIp } from '@/shared/lib/rateLimit';

import { parsePositiveId } from '../../../routeUtils';

export const runtime = 'nodejs';

type Context = {
  params: Promise<{ blockId: string; versionId: string }>;
};

export async function DELETE(request: Request, context: Context) {
  const { denied, session } = await requireTopDashboardManagementSession();
  if (denied) return denied;

  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const limited = await enforceAdminActionRateLimit(
    session,
    'top_dashboard_block_delete',
    30,
    30 * 60 * 1000,
  );
  if (limited) return limited;

  const { blockId: rawBlockId, versionId: rawVersionId } = await context.params;
  const blockId = parsePositiveId(rawBlockId);
  const versionId = parsePositiveId(rawVersionId);
  if (!blockId) return Response.json({ error: 'Некорректный блок' }, { status: 400 });
  if (!versionId) return Response.json({ error: 'Некорректная версия HTML' }, { status: 400 });

  try {
    const actor = getTopDashboardActor(session);
    const result = await deleteTopDashboardBlockVersion({
      blockId,
      versionId,
      adminUserId: actor.adminUserId,
      managerId: actor.managerId,
    });

    await recordSecurityEvent({
      eventType: 'top_dashboard_version_deleted',
      ...actor,
      sessionId: session.sessionId,
      entityType: 'top_dashboard_block_version',
      entityId: `${blockId}:${versionId}`,
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: {
        blockId,
        versionId,
        originalName: result.deletedVersion.originalName,
        fileSize: result.deletedVersion.fileSize,
        sha256: result.deletedVersion.sha256,
        firstPublishedAt: result.deletedVersion.firstPublishedAt,
        activeVersionId: result.activeVersionId,
        replacedPreviousVersion: result.replacedPreviousVersion,
        replacementPreviousVersionId: result.previousVersionId,
      },
    });

    return Response.json(
      {
        ok: true,
        blockId,
        deletedVersion: result.deletedVersion,
        state: {
          activeVersionId: result.activeVersionId,
          previousVersionId: result.previousVersionId,
          updatedAt: result.updatedAt,
        },
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    if (error instanceof TopDashboardActiveVersionDeleteError) {
      return Response.json(
        { error: error.message, activeVersionId: error.activeVersionId },
        { status: 409 },
      );
    }
    if (error instanceof TopDashboardBlockNotFoundError || error instanceof TopDashboardVersionNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error('Failed to delete TOP dashboard block HTML', error);
    return Response.json({ error: 'Не удалось удалить версию HTML' }, { status: 500 });
  }
}
