import {
  getTopDashboardActor,
  isTopDashboardManagementSession,
  requireTopDashboardManagementSession,
  requireTopDashboardSession,
} from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import {
  createTopDashboardBlock,
  getPublishedTopDashboardBlocks,
  getTopDashboardBlocks,
  normalizeTopDashboardBlockTitle,
  TopDashboardBlockTitleValidationError,
} from '@/shared/lib/db';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { getClientIp } from '@/shared/lib/rateLimit';

export const runtime = 'nodejs';

export async function GET() {
  const { denied, session } = await requireTopDashboardSession();
  if (denied) return denied;

  try {
    const blocks = isTopDashboardManagementSession(session)
      ? await getTopDashboardBlocks()
      : await getPublishedTopDashboardBlocks();
    return Response.json(
      { blocks },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    console.error('Failed to load TOP dashboard blocks', error);
    return Response.json({ error: 'Не удалось загрузить блоки' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const { denied, session } = await requireTopDashboardManagementSession();
  if (denied) return denied;

  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const limited = await enforceAdminActionRateLimit(
    session,
    'top_dashboard_block_create',
    60,
    30 * 60 * 1000,
  );
  if (limited) return limited;

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
    const actor = getTopDashboardActor(session);
    const block = await createTopDashboardBlock({
      title,
      createdByAdminUserId: actor.adminUserId,
      createdByManagerId: actor.managerId,
    });

    await recordSecurityEvent({
      eventType: 'top_dashboard_block_created',
      ...actor,
      sessionId: session.sessionId,
      entityType: 'top_dashboard_block',
      entityId: block.id,
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: {
        title: block.title,
      },
    });

    return Response.json(
      { block },
      {
        status: 201,
        headers: { 'Cache-Control': 'private, no-store' },
      },
    );
  } catch (error) {
    if (error instanceof TopDashboardBlockTitleValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    console.error('Failed to create TOP dashboard block', error);
    return Response.json({ error: 'Не удалось создать блок' }, { status: 500 });
  }
}
