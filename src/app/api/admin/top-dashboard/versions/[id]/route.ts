import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { requireTopDashboardSession } from '@/shared/lib/adminAuth';
import {
  deleteTopDashboardVersion,
  TopDashboardActiveVersionDeleteError,
  TopDashboardVersionNotFoundError,
} from '@/shared/lib/db';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { getClientIp } from '@/shared/lib/rateLimit';

export const runtime = 'nodejs';

type Context = {
  params: Promise<{ id: string }>;
};

function parseId(value: string) {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

export async function DELETE(request: Request, context: Context) {
  const { denied, session } = await requireTopDashboardSession();
  if (denied) return denied;

  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const limited = await enforceAdminActionRateLimit(
    session,
    'top_dashboard_delete',
    30,
    30 * 60 * 1000,
  );
  if (limited) return limited;

  const { id } = await context.params;
  const versionId = parseId(id);
  if (!versionId) {
    return Response.json({ error: 'Некорректная версия HTML' }, { status: 400 });
  }

  try {
    const result = await deleteTopDashboardVersion({
      versionId,
      adminUserId: session.adminUserId ?? null,
    });

    await recordSecurityEvent({
      eventType: 'top_dashboard_version_deleted',
      actorType: session.role === 'top' ? 'top' : 'admin',
      adminUserId: session.adminUserId,
      sessionId: session.sessionId,
      entityType: 'top_dashboard_version',
      entityId: versionId,
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: {
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
        {
          error: error.message,
          activeVersionId: error.activeVersionId,
        },
        { status: 409 },
      );
    }
    if (error instanceof TopDashboardVersionNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }

    console.error('Failed to delete TOP dashboard HTML', error);
    return Response.json({ error: 'Не удалось удалить версию HTML' }, { status: 500 });
  }
}
