import { getTopDashboardActor, requireTopDashboardManagementSession } from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import {
  activateTopDashboardBlockDataVersion,
  getTopDashboardBlockOverview,
  getTopDashboardBlockVersionContent,
  TopDashboardActiveHtmlRequiredError,
  TopDashboardBlockDataStateConflictError,
  TopDashboardBlockDataVersionNotFoundError,
  TopDashboardBlockNotFoundError,
  TopDashboardDataCompatibilityError,
  TopDashboardStateConflictError,
} from '@/shared/lib/db';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { getClientIp } from '@/shared/lib/rateLimit';
import {
  detectTopDashboardDataContract,
} from '@/shared/lib/topDashboardContentSecurity';

import { parsePositiveId } from '../../../routeUtils';

export const runtime = 'nodejs';

type Context = {
  params: Promise<{ blockId: string }>;
};

function parseExpectedActiveVersionId(value: unknown) {
  if (value === null) return null;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export async function PUT(request: Request, context: Context) {
  const { denied, session } = await requireTopDashboardManagementSession();
  if (denied) return denied;

  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const limited = await enforceAdminActionRateLimit(
    session,
    'top_dashboard_data_rollback',
    30,
    30 * 60 * 1000,
  );
  if (limited) return limited;

  const { blockId: rawBlockId } = await context.params;
  const blockId = parsePositiveId(rawBlockId);
  if (!blockId) return Response.json({ error: 'Некорректный блок' }, { status: 400 });

  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Response.json({ error: 'Некорректные данные запроса' }, { status: 400 });
  }
  const record = body as Record<string, unknown>;
  const versionId = typeof record.versionId === 'number'
    && Number.isSafeInteger(record.versionId)
    && record.versionId > 0
    ? record.versionId
    : null;
  const expectedActiveVersionId = parseExpectedActiveVersionId(record.expectedActiveVersionId);
  if (!versionId || expectedActiveVersionId === undefined) {
    return Response.json({ error: 'Некорректная версия данных' }, { status: 400 });
  }

  try {
    const overview = await getTopDashboardBlockOverview(blockId);
    const expectedActiveHtmlVersionId = overview.activeVersionId;
    if (!expectedActiveHtmlVersionId) {
      return Response.json(
        { error: 'Сначала опубликуйте HTML-страницу, затем восстановите данные' },
        { status: 422 },
      );
    }
    const activeHtml = await getTopDashboardBlockVersionContent(
      blockId,
      expectedActiveHtmlVersionId,
    );
    if (!activeHtml) {
      return Response.json(
        { error: 'Активная HTML-страница уже изменилась. Обновите страницу и повторите.' },
        { status: 409 },
      );
    }
    const contract = detectTopDashboardDataContract(activeHtml.htmlContent);
    const expectedHtmlSnapshotFormat = contract.snapshotFormat;
    const expectedHtmlProfile = contract.profile;
    if (contract.mode === 'disabled' || !expectedHtmlSnapshotFormat || !expectedHtmlProfile) {
      return Response.json(
        { error: 'Для опубликованной HTML-страницы не удалось определить подходящий тип данных' },
        { status: 422 },
      );
    }

    const actor = getTopDashboardActor(session);
    const result = await activateTopDashboardBlockDataVersion({
      blockId,
      versionId,
      expectedActiveVersionId,
      expectedActiveHtmlVersionId,
      expectedHtmlSnapshotFormat,
      expectedHtmlProfile,
      adminUserId: actor.adminUserId,
      managerId: actor.managerId,
    });

    if (result.change === 'rolled_back') {
      await recordSecurityEvent({
        eventType: 'top_dashboard_data_rolled_back',
        ...actor,
        sessionId: session.sessionId,
        entityType: 'top_dashboard_block_data_version',
        entityId: `${blockId}:${versionId}`,
        ip: getClientIp(request),
        userAgent: request.headers.get('user-agent'),
        referer: request.headers.get('referer'),
        metadata: {
          blockId,
          versionId,
          previousVersionId: result.previousVersionId,
        },
      });
    }

    return Response.json(
      { state: result },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    if (error instanceof TopDashboardStateConflictError) {
      return Response.json(
        {
          error: 'Активная HTML-страница уже изменилась. Обновите страницу и повторите.',
          currentActiveHtmlVersionId: error.currentActiveVersionId,
        },
        { status: 409 },
      );
    }
    if (error instanceof TopDashboardBlockDataStateConflictError) {
      return Response.json(
        {
          error: error.message,
          currentActiveVersionId: error.currentActiveVersionId,
        },
        { status: 409 },
      );
    }
    if (
      error instanceof TopDashboardBlockDataVersionNotFoundError
      || error instanceof TopDashboardBlockNotFoundError
    ) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (
      error instanceof TopDashboardActiveHtmlRequiredError
      || error instanceof TopDashboardDataCompatibilityError
    ) {
      return Response.json({ error: error.message }, { status: 422 });
    }
    console.error('Failed to roll back TOP dashboard data', error);
    return Response.json({ error: 'Не удалось восстановить данные дашборда' }, { status: 500 });
  }
}
