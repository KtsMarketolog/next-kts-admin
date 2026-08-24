import { getTopDashboardActor, requireTopDashboardSession } from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import {
  activateTopDashboardBlockVersion,
  getTopDashboardBlockVersionContent,
  TopDashboardBlockNotFoundError,
  TopDashboardDataCompatibilityError,
  TopDashboardStateConflictError,
  TopDashboardVersionNotFoundError,
} from '@/shared/lib/db';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { getClientIp } from '@/shared/lib/rateLimit';
import {
  detectTopDashboardExpectedProfile,
  detectTopDashboardExpectedSnapshotFormat,
} from '@/shared/lib/topDashboardContentSecurity';

import { parsePositiveId } from '../../routeUtils';

export const runtime = 'nodejs';

type Context = {
  params: Promise<{ blockId: string }>;
};

function expectedVersionId(value: unknown) {
  if (value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export async function PUT(request: Request, context: Context) {
  const { denied, session } = await requireTopDashboardSession();
  if (denied) return denied;

  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const limited = await enforceAdminActionRateLimit(
    session,
    'top_dashboard_block_activate',
    30,
    30 * 60 * 1000,
  );
  if (limited) return limited;

  const { blockId: rawBlockId } = await context.params;
  const blockId = parsePositiveId(rawBlockId);
  if (!blockId) return Response.json({ error: 'Некорректный блок' }, { status: 400 });

  const rawBody: unknown = await request.json().catch(() => null);
  const body = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
    ? rawBody as Record<string, unknown>
    : {};
  const versionId = expectedVersionId(body.versionId);
  const hasExpectedVersion = Object.prototype.hasOwnProperty.call(body, 'expectedActiveVersionId');
  const expectedActiveVersionId = expectedVersionId(body.expectedActiveVersionId);
  if (!versionId) {
    return Response.json({ error: 'Некорректная версия HTML' }, { status: 400 });
  }
  if (!hasExpectedVersion || (body.expectedActiveVersionId !== null && !expectedActiveVersionId)) {
    return Response.json(
      { error: 'Обновите список версий и повторите публикацию' },
      { status: 400 },
    );
  }

  try {
    const targetHtml = await getTopDashboardBlockVersionContent(blockId, versionId);
    if (!targetHtml) {
      return Response.json({ error: 'Версия HTML не найдена' }, { status: 404 });
    }
    const expectedSnapshotFormat = detectTopDashboardExpectedSnapshotFormat(
      targetHtml.htmlContent,
    );
    const expectedProfile = detectTopDashboardExpectedProfile(targetHtml.htmlContent);

    const actor = getTopDashboardActor(session);
    const state = await activateTopDashboardBlockVersion({
      blockId,
      versionId,
      expectedActiveVersionId,
      expectedSnapshotFormat,
      expectedProfile,
      adminUserId: actor.adminUserId,
      managerId: actor.managerId,
    });

    if (state.change !== 'unchanged') {
      await recordSecurityEvent({
        eventType: state.change === 'rolled_back'
          ? 'top_dashboard_version_rolled_back'
          : 'top_dashboard_version_published',
        ...actor,
        sessionId: session.sessionId,
        entityType: 'top_dashboard_block_version',
        entityId: `${blockId}:${versionId}`,
        ip: getClientIp(request),
        userAgent: request.headers.get('user-agent'),
        referer: request.headers.get('referer'),
        metadata: {
          blockId,
          fromVersionId: expectedActiveVersionId,
          toVersionId: versionId,
          previousVersionId: state.previousVersionId,
          expectedSnapshotFormat,
          expectedProfile,
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
    if (error instanceof TopDashboardBlockNotFoundError || error instanceof TopDashboardVersionNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof TopDashboardDataCompatibilityError) {
      return Response.json({ error: error.message }, { status: 422 });
    }
    console.error('Failed to activate TOP dashboard block HTML', error);
    return Response.json({ error: 'Не удалось опубликовать версию HTML' }, { status: 500 });
  }
}
