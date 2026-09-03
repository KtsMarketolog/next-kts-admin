import {
  getTopDashboardActor,
  isTopDashboardManagementSession,
  requireTopDashboardManagementSession,
  requireTopDashboardSession,
} from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import {
  deleteTopDashboardBlock,
  getPublishedTopDashboardBlockOverview,
  getTopDashboardBlockOverview,
  normalizeTopDashboardBlockTitle,
  renameTopDashboardBlock,
  TopDashboardBlockNotFoundError,
  TopDashboardBlockTitleValidationError,
} from '@/shared/lib/db';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { getClientIp } from '@/shared/lib/rateLimit';
import { deleteTopDashboardDataFiles } from '@/shared/lib/topDashboardDataStorage';

import { parsePositiveId } from '../routeUtils';

export const runtime = 'nodejs';

type Context = {
  params: Promise<{ blockId: string }>;
};

export async function GET(_request: Request, context: Context) {
  const { denied, session } = await requireTopDashboardSession();
  if (denied) return denied;

  const { blockId: rawBlockId } = await context.params;
  const blockId = parsePositiveId(rawBlockId);
  if (!blockId) return Response.json({ error: 'Некорректный блок' }, { status: 400 });

  try {
    const overview = isTopDashboardManagementSession(session)
      ? await getTopDashboardBlockOverview(blockId)
      : await getPublishedTopDashboardBlockOverview(blockId);
    if (!overview) {
      return Response.json({ error: 'Блок не найден' }, { status: 404 });
    }
    return Response.json(overview, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    if (error instanceof TopDashboardBlockNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error('Failed to load TOP dashboard block', error);
    return Response.json({ error: 'Не удалось загрузить блок' }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: Context) {
  const { denied, session } = await requireTopDashboardManagementSession();
  if (denied) return denied;

  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const limited = await enforceAdminActionRateLimit(
    session,
    'top_dashboard_block_rename',
    60,
    30 * 60 * 1000,
  );
  if (limited) return limited;

  const { blockId: rawBlockId } = await context.params;
  const blockId = parsePositiveId(rawBlockId);
  if (!blockId) return Response.json({ error: 'Некорректный блок' }, { status: 400 });

  const body: unknown = await request.json().catch(() => null);
  const title = normalizeTopDashboardBlockTitle(
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).title
      : null,
  );
  if (!title) {
    return Response.json(
      { error: 'Название блока должно содержать от 1 до 120 символов' },
      { status: 400 },
    );
  }

  try {
    const result = await renameTopDashboardBlock({ blockId, title });

    if (result.changed) {
      const actor = getTopDashboardActor(session);
      await recordSecurityEvent({
        eventType: 'top_dashboard_block_renamed',
        ...actor,
        sessionId: session.sessionId,
        entityType: 'top_dashboard_block',
        entityId: blockId,
        ip: getClientIp(request),
        userAgent: request.headers.get('user-agent'),
        referer: request.headers.get('referer'),
        metadata: {
          previousTitle: result.previousTitle,
          title: result.block.title,
        },
      });
    }

    return Response.json(
      { block: result.block, changed: result.changed },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    if (error instanceof TopDashboardBlockTitleValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof TopDashboardBlockNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error('Failed to rename TOP dashboard block', error);
    return Response.json({ error: 'Не удалось изменить название блока' }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: Context) {
  const { denied, session } = await requireTopDashboardManagementSession();
  if (denied) return denied;

  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const limited = await enforceAdminActionRateLimit(
    session,
    'top_dashboard_block_remove',
    30,
    30 * 60 * 1000,
  );
  if (limited) return limited;

  const { blockId: rawBlockId } = await context.params;
  const blockId = parsePositiveId(rawBlockId);
  if (!blockId) return Response.json({ error: 'Некорректный блок' }, { status: 400 });

  try {
    const result = await deleteTopDashboardBlock(blockId);
    const deletedBlock = result.deletedBlock;
    const actor = getTopDashboardActor(session);

    await recordSecurityEvent({
      eventType: 'top_dashboard_block_deleted',
      ...actor,
      sessionId: session.sessionId,
      entityType: 'top_dashboard_block',
      entityId: blockId,
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: {
        title: deletedBlock.title,
        versionCount: deletedBlock.versionCount,
        storedBytes: deletedBlock.storedBytes,
        dataVersionCount: deletedBlock.dataVersionCount,
        dataStoredBytes: deletedBlock.dataStoredBytes,
        activeVersionId: deletedBlock.activeVersionId,
        previousVersionId: deletedBlock.previousVersionId,
      },
    });

    await deleteTopDashboardDataFiles(result.deletedStoragePaths).catch((error) => {
      console.error('Failed to remove deleted TOP dashboard data files', error);
    });

    return Response.json(
      { ok: true, deletedBlock },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    if (error instanceof TopDashboardBlockNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    console.error('Failed to delete TOP dashboard block', error);
    return Response.json({ error: 'Не удалось удалить блок' }, { status: 500 });
  }
}
