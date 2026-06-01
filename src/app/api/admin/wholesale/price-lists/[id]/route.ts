import {
  deleteWholesalePriceList,
  getWholesalePriceListEditor,
  updateClientCompanyManagerAssignments,
  updateWholesalePriceList,
  type WholesalePriceGroupStockSettingInput,
  type WholesalePriceListItemInput,
} from '@/shared/lib/db';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { isManagerSessionRole, requireEmployee } from '@/shared/lib/adminAuth';
import { publishClientRealtimeEvent } from '@/shared/lib/clientRealtime';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { getClientIp } from '@/shared/lib/rateLimit';
import { normalizeWholesalePriceWorkflowStatus } from '@/shared/lib/wholesalePriceWorkflowStatus';
import {
  normalizeOptionalDate,
  normalizeTextField,
  normalizeWholesalePrice,
} from '@/shared/lib/wholesaleSecurity';

type Context = {
  params: Promise<{ id: string }>;
};

const MAX_PRICE_ITEMS = 5000;

function itemsFromBody(items: unknown): WholesalePriceListItemInput[] {
  if (!Array.isArray(items)) return [];
  return items
    .slice(0, MAX_PRICE_ITEMS)
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const source = item as Record<string, unknown>;
      const productId = Number(source.productId);
      if (!Number.isInteger(productId) || productId <= 0) return null;
      const parsedVariantId = source.variantId === null || source.variantId === undefined ? null : Number(source.variantId);
      return {
        productId,
        variantId: parsedVariantId !== null && Number.isInteger(parsedVariantId) && parsedVariantId > 0 ? parsedVariantId : null,
        customWholesalePrice: normalizeWholesalePrice(source.customWholesalePrice),
        visible: Boolean(source.visible),
        sortOrder: Number.isInteger(Number(source.sortOrder)) ? Math.max(0, Number(source.sortOrder)) : index + 1,
      };
    })
    .filter(Boolean) as WholesalePriceListItemInput[];
}

function priceGroupStockSettingsFromBody(settings: unknown): WholesalePriceGroupStockSettingInput[] {
  const rows = Array.isArray(settings)
    ? settings
    : settings && typeof settings === 'object'
      ? Object.values(settings as Record<string, unknown>)
      : [];

  return rows
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const source = item as Record<string, unknown>;
      const priceGroup = normalizeTextField(source.priceGroup, 180);
      if (!priceGroup) return null;
      return {
        priceGroup,
        showStock: Boolean(source.showStock),
        showStockText: Boolean(source.showStockText),
      };
    })
    .filter((item): item is WholesalePriceGroupStockSettingInput => Boolean(item && (item.showStock || item.showStockText)));
}

function supportManagerIdFromBody(value: unknown) {
  const supportManagerId = Number(value);
  return Number.isInteger(supportManagerId) && supportManagerId > 0 ? supportManagerId : null;
}

function clientCompanyIdFromBody(value: unknown) {
  const clientCompanyId = Number(value);
  return Number.isInteger(clientCompanyId) && clientCompanyId > 0 ? clientCompanyId : null;
}

export async function GET(_request: Request, context: Context) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;
  const limited = await enforceAdminActionRateLimit(session, 'price_list_update', 120);
  if (limited) return limited;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) return Response.json({ error: 'Invalid id' }, { status: 400 });

  const priceList = await getWholesalePriceListEditor(numericId, session);
  if (!priceList) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json({ priceList });
}

export async function PUT(request: Request, context: Context) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const limited = await enforceAdminActionRateLimit(session, 'price_list_delete', 40);
  if (limited) return limited;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) return Response.json({ error: 'Invalid id' }, { status: 400 });

  const body = await request.json().catch(() => ({}));
  const existing = await getWholesalePriceListEditor(numericId, session);
  if (!existing) return Response.json({ error: 'Not found' }, { status: 404 });

  const title = normalizeTextField(body.title, 160);
  if (!title) return Response.json({ error: 'Title is required' }, { status: 400 });
  const validUntil = normalizeOptionalDate(body.validUntil);
  if (typeof body.validUntil === 'string' && body.validUntil.trim() && !validUntil) {
    return Response.json({ error: 'Invalid expiration date' }, { status: 400 });
  }
  const supportManagerId = supportManagerIdFromBody(body.supportManagerId);
  if (!supportManagerId) {
    return Response.json({ error: 'Выберите менеджера по сопровождению' }, { status: 400 });
  }
  const clientCompanyId = clientCompanyIdFromBody(body.clientCompanyId);
  if (!clientCompanyId) {
    return Response.json({ error: 'Выберите клиента из списка' }, { status: 400 });
  }

  const managerId = Number.isFinite(Number(body.managerId)) ? Number(body.managerId) : null;

  try {
    await updateWholesalePriceList(
      numericId,
      {
        title,
        clientCompanyId,
        clientName: normalizeTextField(body.clientName, 200),
        managerId,
        supportManagerId,
        validUntil,
        token: existing.token,
        comment: normalizeTextField(body.comment, 2000),
        workflowStatus: normalizeWholesalePriceWorkflowStatus(body.workflowStatus),
        showRetailPrices: Boolean(body.showRetailPrices),
        showStock: body.showStock !== false,
        showStockText: Boolean(body.showStockText),
        isActive: Boolean(body.isActive ?? true),
        items: itemsFromBody(body.items),
        priceGroupStockSettings: priceGroupStockSettingsFromBody(body.priceGroupStockSettings),
      },
      session,
    );
    await updateClientCompanyManagerAssignments(clientCompanyId, { managerId, supportManagerId }, session);
    publishClientRealtimeEvent({ type: 'client.updated', companyId: clientCompanyId });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Не удалось сохранить прайс' }, { status: 400 });
  }

  return Response.json({ ok: true });
}

export async function DELETE(request: Request, context: Context) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId)) return Response.json({ error: 'Invalid id' }, { status: 400 });

  await deleteWholesalePriceList(numericId, session);
  await recordSecurityEvent({
    eventType: 'price_deleted',
    actorType: isManagerSessionRole(session.role) ? 'manager' : session.role === 'wholesale_admin' ? 'wholesale_admin' : 'admin',
    adminUserId: session.adminUserId,
    managerId: isManagerSessionRole(session.role) ? session.managerId : undefined,
    sessionId: session.sessionId,
    entityType: 'wholesale_price_list',
    entityId: numericId,
    ip: getClientIp(request),
    userAgent: request.headers.get('user-agent'),
    referer: request.headers.get('referer'),
  });
  return Response.json({ ok: true });
}
