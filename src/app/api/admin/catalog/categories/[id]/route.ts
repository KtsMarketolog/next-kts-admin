import { updateCatalogAdminCategory } from '@/entities/catalog/api/catalogAdmin';
import { revalidatePublicCatalog } from '@/entities/catalog/api/catalogRevalidation';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { requireAdminSession } from '@/shared/lib/adminAuth';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { getClientIp } from '@/shared/lib/rateLimit';

type Context = {
  params: Promise<{ id: string }>;
};

function badRequest(error: string, status = 400) {
  return Response.json({ error }, { status });
}

function parseId(value: string) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function PUT(request: Request, context: Context) {
  const { denied, session } = await requireAdminSession();
  if (denied) return denied;
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;
  const limited = await enforceAdminActionRateLimit(session, 'catalog_category_update', 120);
  if (limited) return limited;

  const { id } = await context.params;
  const categoryId = parseId(id);
  if (!categoryId) return badRequest('Некорректная категория');

  const body = await request.json().catch(() => ({}));
  const update = {
    ...(typeof body.iconUrl === 'string' ? { iconUrl: body.iconUrl } : {}),
    ...(typeof body.showOnSite === 'boolean' ? { showOnSite: body.showOnSite } : {}),
  };

  try {
    const category = await updateCatalogAdminCategory(categoryId, update);
    revalidatePublicCatalog();
    await recordSecurityEvent({
      eventType: 'catalog_category_updated',
      actorType: 'admin',
      adminUserId: session.adminUserId,
      sessionId: session.sessionId,
      entityType: 'catalog_category',
      entityId: categoryId,
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: { title: category.title, iconUrl: category.iconUrl, showOnSite: category.showOnSite },
    });
    return Response.json({ category });
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : 'Не удалось сохранить иконку категории');
  }
}
