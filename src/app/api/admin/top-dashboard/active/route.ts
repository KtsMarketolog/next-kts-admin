import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { requireTopDashboardSession } from '@/shared/lib/adminAuth';
import {
  activateTopDashboardVersion,
  TopDashboardStateConflictError,
  TopDashboardVersionNotFoundError,
} from '@/shared/lib/db';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { getClientIp } from '@/shared/lib/rateLimit';

export const runtime = 'nodejs';

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function expectedVersionId(value: unknown) {
  if (value === null) return null;
  return positiveInteger(value);
}

export async function PUT(request: Request) {
  const { denied, session } = await requireTopDashboardSession();
  if (denied) return denied;
  if (!session.adminUserId) {
    return Response.json({ error: 'Для публикации требуется учетная запись сотрудника' }, { status: 403 });
  }

  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const limited = await enforceAdminActionRateLimit(session, 'top_dashboard_activate', 30, 30 * 60 * 1000);
  if (limited) return limited;

  const body = await request.json().catch(() => ({}));
  const versionId = positiveInteger(body.versionId);
  const hasExpectedVersion = Object.prototype.hasOwnProperty.call(body, 'expectedActiveVersionId');
  const expectedActiveVersionId = expectedVersionId(body.expectedActiveVersionId);

  if (!versionId) {
    return Response.json({ error: 'Некорректная версия HTML' }, { status: 400 });
  }
  if (!hasExpectedVersion || (body.expectedActiveVersionId !== null && !expectedActiveVersionId)) {
    return Response.json({ error: 'Обновите список версий и повторите публикацию' }, { status: 400 });
  }

  try {
    const state = await activateTopDashboardVersion({
      versionId,
      expectedActiveVersionId,
      adminUserId: session.adminUserId,
    });

    if (state.change !== 'unchanged') {
      await recordSecurityEvent({
        eventType: state.change === 'rolled_back'
          ? 'top_dashboard_version_rolled_back'
          : 'top_dashboard_version_published',
        actorType: session.role === 'top' ? 'top' : 'admin',
        adminUserId: session.adminUserId,
        sessionId: session.sessionId,
        entityType: 'top_dashboard_version',
        entityId: versionId,
        ip: getClientIp(request),
        userAgent: request.headers.get('user-agent'),
        referer: request.headers.get('referer'),
        metadata: {
          fromVersionId: expectedActiveVersionId,
          toVersionId: versionId,
          previousVersionId: state.previousVersionId,
        },
      });
    }

    return Response.json(
      { state },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    if (error instanceof TopDashboardStateConflictError) {
      return Response.json(
        {
          error: 'Активная версия уже изменилась. Обновите список и повторите.',
          currentActiveVersionId: error.currentActiveVersionId,
        },
        { status: 409 },
      );
    }
    if (error instanceof TopDashboardVersionNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }

    console.error('Failed to activate TOP dashboard HTML', error);
    return Response.json({ error: 'Не удалось опубликовать версию HTML' }, { status: 500 });
  }
}
