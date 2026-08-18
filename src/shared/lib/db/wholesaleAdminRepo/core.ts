import type { AdminSession } from '@/shared/lib/adminAuth';
import {
  getWholesalePriceListAccessScope,
  resolveWholesalePriceListManagerAssignment,
  type WholesalePriceListAccessScope,
  type WholesalePriceListManagerRole,
} from '@/shared/lib/wholesalePriceListAccess';
import {
  getWholesalePriceWorkflowStatusLabel,
  normalizeWholesalePriceWorkflowStatus,
} from '@/shared/lib/wholesalePriceWorkflowStatus';

import { trackAnalyticsEvent } from '../analyticsRepo';
import { query } from '../client';
import { assertClientCompanyVisible } from '../clientCompaniesRepo';
import { ensureSiteSchema } from '../schema';
import {
  actionEventType,
  actorMeta,
  actorTypeFromRole,
  clientIdFromName,
  priceListAction,
  priceListDetails,
  resolveWholesaleClientCompany,
} from './analyticsHelpers';
import { normalizeWholesaleSupportManagerId } from './managerHelpers';

export type {
  WholesalePriceListSummary,
  WholesaleCatalogVariant,
  WholesaleCatalogProduct,
  WholesaleCatalogCategory,
  WholesalePriceListItemInput,
  WholesalePriceGroupStockSettingInput,
  WholesalePriceListEditor,
  WholesaleDiscountReportRow,
  WholesaleManagerAnalyticsPeriod,
  WholesaleAdminAnalyticsPeriod,
  WholesaleManagerAnalytics,
  WholesaleManagerAnalyticsProblem,
  WholesaleManagerAnalyticsProblemPrice,
  WholesaleManagerAnalyticsChange,
  WholesaleManagerAnalyticsEvent,
  WholesaleManagerAnalyticsClient,
  WholesaleAnalyticsStatusFunnelStep,
  WholesaleAnalyticsStatusFunnel,
  WholesaleAnalyticsAttentionPrice,
  WholesaleAnalyticsReactionNeeded,
  WholesaleAnalyticsPriorityClient,
  WholesaleAnalyticsClientHistory,
  WholesaleAnalyticsProductInterest,
  WholesaleAnalyticsPeriodComparison,
  WholesaleAdminAnalyticsManager,
  WholesaleAdminAnalyticsProblemPrice,
  WholesaleAdminAnalyticsEvent,
  WholesaleAdminAnalyticsClient,
  WholesaleAdminAnalytics
} from './types';
import type {
  WholesalePriceListSummary,
  WholesaleCatalogProduct,
  WholesaleCatalogCategory,
  WholesalePriceListItemInput,
  WholesalePriceGroupStockSettingInput,
  WholesalePriceListEditor,
} from './types';

type PriceListRow = {
  id: string;
  title: string;
  client_company_id: string | null;
  client_name: string;
  token: string;
  valid_until: string | null;
  workflow_status: string | null;
  show_retail_prices: boolean;
  show_stock: boolean;
  show_stock_text: boolean;
  is_active: boolean;
  manager_id: string | null;
  manager_name: string | null;
  item_count: string;
  price_group_count: string;
  created_at: string;
  updated_at: string;
  last_changed_at: string | null;
  last_changed_title: string | null;
  last_changed_by_name: string | null;
};

type PriceListEventInput = {
  priceListId: number;
  ownerManagerId: number | null;
  actorManagerId: number | null;
  actorRole: AdminSession['role'] | 'admin';
  title: string;
  action: string;
  details?: string;
};

async function insertPriceListEvent(input: PriceListEventInput) {
  await query(
    `insert into wholesale_price_list_events (
       price_list_id, manager_id, owner_manager_id, action, title_snapshot, actor_role, actor_label, details
     )
     values (
       $1,
       $2,
       $3,
       $4,
       $5,
       $6,
       case
         when $6 in ('manager', 'support_manager') then coalesce((select name from wholesale_managers where id = $2), $7)
         else $7
       end,
       $8
     )`,
    [
      input.priceListId,
      input.actorManagerId,
      input.ownerManagerId,
      input.action,
      input.title,
      input.actorRole,
      actorMeta({ role: input.actorRole as AdminSession['role'] }).actorFallback,
      input.details ?? '',
    ],
  );
  await trackAnalyticsEvent({
    eventType: actionEventType(input.action),
    actorType: actorTypeFromRole(input.actorRole),
    actorUserId: input.actorManagerId,
    managerId: input.ownerManagerId,
    priceListId: input.priceListId,
    metadata: {
      title: input.title,
      action: input.action,
      details: input.details ?? '',
    },
  });
}

function mapPriceList(row: PriceListRow): WholesalePriceListSummary {
  return {
    id: Number(row.id),
    title: row.title,
    clientCompanyId: row.client_company_id ? Number(row.client_company_id) : null,
    clientName: row.client_name,
    token: row.token,
    validUntil: row.valid_until,
    workflowStatus: normalizeWholesalePriceWorkflowStatus(row.workflow_status),
    workflowStatusLabel: getWholesalePriceWorkflowStatusLabel(row.workflow_status),
    showRetailPrices: row.show_retail_prices,
    showStock: row.show_stock !== false,
    showStockText: row.show_stock_text === true,
    isActive: row.is_active,
    managerId: row.manager_id ? Number(row.manager_id) : null,
    managerName: row.manager_name,
    itemCount: Number(row.item_count),
    priceGroupCount: Number(row.price_group_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastChangedAt: row.last_changed_at,
    lastChangedTitle: row.last_changed_title,
    lastChangedByName: row.last_changed_by_name,
  };
}

export async function getWholesalePriceLists(session?: AdminSession | null) {
  await ensureSiteSchema();
  return getWholesalePriceListsByManager(getWholesalePriceListAccessScope(session));
}

export async function getWholesalePriceListsForManager(
  managerId: number,
  role: WholesalePriceListManagerRole,
) {
  await ensureSiteSchema();
  return getWholesalePriceListsByManager({ managerId, role });
}

async function getWholesalePriceListsByManager(scope: WholesalePriceListAccessScope) {
  const result = await query<PriceListRow>(
    `select
       pl.id::text,
       pl.title,
       pl.client_company_id::text,
       pl.client_name,
       pl.token,
       pl.valid_until::text,
       pl.workflow_status,
       pl.show_retail_prices,
       pl.show_stock,
       pl.show_stock_text,
       pl.is_active,
       pl.manager_id::text,
       m.name as manager_name,
       (count(distinct p.id) filter (
         where i.visible = true
           and p.is_active = true
           and (i.wholesale_variant_id is null or v.is_active = true)
       ))::text as item_count,
       (count(distinct coalesce(nullif(p.price_group, ''), 'Без ценовой группы')) filter (
         where i.visible = true
           and p.is_active = true
           and (i.wholesale_variant_id is null or v.is_active = true)
       ))::text as price_group_count,
       pl.created_at::text,
       pl.updated_at::text,
       last_event.created_at::text as last_changed_at,
       last_event.title_snapshot as last_changed_title,
       last_event.actor_name as last_changed_by_name
     from wholesale_price_lists pl
     left join wholesale_managers m on m.id = pl.manager_id
     left join wholesale_price_list_items i on i.price_list_id = pl.id
     left join wholesale_products p on p.id = i.wholesale_product_id
     left join wholesale_product_variants v on v.id = i.wholesale_variant_id and v.product_id = p.id
     left join lateral (
       select
         e.created_at,
         e.title_snapshot,
         coalesce(
           nullif(e.actor_label, ''),
           em.name,
           case
             when e.actor_role = 'admin' then 'Администратор'
             when e.actor_role = 'wholesale_admin' then 'Администратор прайсов'
             else null
           end
         ) as actor_name
       from wholesale_price_list_events e
       left join wholesale_managers em on em.id = e.manager_id
       where e.price_list_id = pl.id
       order by e.created_at desc, e.id desc
       limit 1
     ) last_event on true
     where (
       $1::bigint is null
       or ($2::text = 'manager' and pl.manager_id = $1)
       or ($2::text = 'support_manager' and (pl.support_manager_id = $1 or pl.manager_id = $1))
     )
     group by pl.id, m.name, last_event.created_at, last_event.title_snapshot, last_event.actor_name
     order by pl.updated_at desc, pl.id desc`,
    [scope.managerId, scope.role],
  );
  return result.rows.map(mapPriceList);
}

export async function getWholesaleCatalog() {
  await ensureSiteSchema();
  const result = await query<{
    category_id: string | null;
    category_title: string | null;
    product_id: string;
    product_title: string;
    sku: string;
    model: string | null;
    series_description: string;
    image_url: string | null;
    price_group: string | null;
    price_group_image_url: string | null;
    price_eur: string | null;
    price_rub: string | null;
    price_cny: string | null;
    general_discount: string | null;
    manual_discount: string | null;
    manual_discount_rop: string | null;
    stock: string | null;
    unit: string | null;
    is_expected: boolean | null;
    stock_updated_at: string | null;
    variant_id: string | null;
    variant_title: string | null;
    retail_price: string | null;
    wholesale_price: string | null;
  }>(`
    select
      c.id::text as category_id,
      coalesce(c.title, 'Без категории') as category_title,
      p.id::text as product_id,
      p.title as product_title,
      p.sku,
      p.model,
      p.series_description,
      img.image_url,
      p.price_group,
      pgi.image_url as price_group_image_url,
      p.price_eur::text,
      p.price_rub::text,
      p.price_cny::text,
      p.general_discount::text,
      p.manual_discount::text,
      p.manual_discount_rop::text,
      p.stock::text,
      p.unit,
      p.is_expected,
      p.stock_updated_at::text,
      v.id::text as variant_id,
      v.title as variant_title,
      coalesce(v.retail_price, p.retail_price)::text as retail_price,
      coalesce(v.wholesale_price, p.wholesale_price)::text as wholesale_price
    from wholesale_products p
    left join wholesale_categories c on c.id = p.category_id
    left join wholesale_product_variants v on v.product_id = p.id and v.is_active = true
    left join price_group_images pgi on pgi.price_group = coalesce(nullif(trim(p.price_group), ''), 'Без ценовой группы')
    left join lateral (
      select image_url
      from wholesale_product_images
      where product_id = p.id and is_active = true
      order by sort_order asc, id asc
      limit 1
    ) img on true
    where p.is_active = true
    order by c.sort_order asc nulls last, c.id asc nulls last, p.sort_order asc, p.id asc, v.sort_order asc nulls last, v.id asc nulls last
  `);

  const categories = new Map<number, WholesaleCatalogCategory>();
  const products = new Map<string, WholesaleCatalogProduct>();

  for (const row of result.rows) {
    const categoryId = Number(row.category_id ?? 0);
    const normalizedCategoryId = Number.isFinite(categoryId) && categoryId > 0 ? categoryId : 0;
    let category = categories.get(normalizedCategoryId);
    if (!category) {
      category = { id: normalizedCategoryId, title: row.category_title || 'Без категории', products: [] };
      categories.set(normalizedCategoryId, category);
    }

    const productId = Number(row.product_id);
    const productKey = `${normalizedCategoryId}:${productId}`;
    let product = products.get(productKey);
    if (!product) {
      product = {
        id: productId,
        title: row.product_title,
        sku: row.sku,
        model: row.model ?? '',
        description: row.series_description,
        imageUrl: row.image_url,
        priceGroup: row.price_group ?? '',
        priceGroupImageUrl: row.price_group_image_url,
        priceEur: row.price_eur,
        priceRub: row.price_rub,
        priceCny: row.price_cny,
        generalDiscount: row.general_discount,
        manualDiscount: row.manual_discount,
        manualDiscountRop: row.manual_discount_rop,
        stock: Number(row.stock ?? 0),
        unit: row.unit,
        isExpected: Boolean(row.is_expected),
        stockUpdatedAt: row.stock_updated_at,
        variants: [],
      };
      products.set(productKey, product);
      category.products.push(product);
    }

    product.variants.push({
      id: row.variant_id ? Number(row.variant_id) : null,
      title: row.variant_title || 'Цена',
      retailPrice: row.retail_price,
      wholesalePrice: row.wholesale_price,
    });
  }

  return Array.from(categories.values());
}

export async function getWholesalePriceListEditor(id: number, session?: AdminSession | null) {
  await ensureSiteSchema();
  const scope = getWholesalePriceListAccessScope(session);
  const priceList = await query<
    Omit<WholesalePriceListEditor, 'id' | 'items' | 'clientCompanyId' | 'managerId' | 'supportManagerId' | 'priceGroupStockSettings'> & {
      id: string;
      client_company_id: string | null;
      manager_id: string | null;
      support_manager_id: string | null;
    }
  >(
    `select id::text, title, client_company_id::text, client_name as "clientName", token, valid_until::text as "validUntil",
            comment, workflow_status as "workflowStatus", show_retail_prices as "showRetailPrices", show_stock as "showStock",
            show_stock_text as "showStockText", is_active as "isActive", manager_id::text, support_manager_id::text
     from wholesale_price_lists
     where id = $1
       and (
         $2::bigint is null
         or ($3::text = 'manager' and manager_id = $2)
         or ($3::text = 'support_manager' and (support_manager_id = $2 or manager_id = $2))
       )
     limit 1`,
    [id, scope.managerId, scope.role],
  );
  const row = priceList.rows[0];
  if (!row) return null;

  const items = await query<{
    product_id: string;
    variant_id: string | null;
    custom_wholesale_price: string | null;
    discount_percent: string | null;
    price_manually_changed: boolean;
    visible: boolean;
    sort_order: number;
  }>(
    `select wholesale_product_id::text as product_id,
            wholesale_variant_id::text as variant_id,
            custom_wholesale_price::text,
            discount_percent::text,
            price_manually_changed,
            visible,
            sort_order
     from wholesale_price_list_items
     where price_list_id = $1
     order by sort_order asc, id asc`,
    [id],
  );
  const groupStockSettings = await query<{
    price_group: string;
    show_stock_numbers: boolean;
    show_stock_text: boolean;
  }>(
    `select price_group, show_stock_numbers, show_stock_text
     from wholesale_price_list_group_stock_settings
     where price_list_id = $1
     order by lower(price_group) asc`,
    [id],
  );

  return {
    id: Number(row.id),
    title: row.title,
    clientCompanyId: row.client_company_id ? Number(row.client_company_id) : null,
    clientName: row.clientName,
    token: row.token,
    validUntil: row.validUntil,
    comment: row.comment,
    workflowStatus: normalizeWholesalePriceWorkflowStatus(row.workflowStatus),
    showRetailPrices: row.showRetailPrices,
    showStock: row.showStock !== false,
    showStockText: row.showStockText === true,
    isActive: row.isActive,
    managerId: row.manager_id ? Number(row.manager_id) : null,
    supportManagerId: row.support_manager_id ? Number(row.support_manager_id) : null,
    items: items.rows.map((item) => ({
      productId: Number(item.product_id),
      variantId: item.variant_id ? Number(item.variant_id) : null,
      customWholesalePrice: item.custom_wholesale_price,
      discountPercent: item.discount_percent,
      priceManuallyChanged: item.price_manually_changed === true,
      visible: item.visible,
      sortOrder: item.sort_order,
    })),
    priceGroupStockSettings: groupStockSettings.rows.map((setting) => ({
      priceGroup: setting.price_group,
      showStock: setting.show_stock_numbers === true,
      showStockText: setting.show_stock_text === true,
    })),
  };
}

export async function createWholesalePriceList(
  input: Omit<WholesalePriceListEditor, 'id'>,
  session?: AdminSession | null,
) {
  await ensureSiteSchema();
  const assignment = resolveWholesalePriceListManagerAssignment(input, session);
  const managerId = assignment.managerId;
  const supportManagerId = await normalizeWholesaleSupportManagerId(assignment.supportManagerId);
  const clientCompany = await resolveWholesaleClientCompany(input.clientCompanyId, session);
  const result = await query<{ id: string }>(
    `insert into wholesale_price_lists (
       title, client_company_id, client_name, manager_id, support_manager_id, valid_until, token, comment, workflow_status, show_retail_prices, show_stock, show_stock_text, is_active
     )
     values ($1, $2, $3, $4, $5, nullif($6, '')::date, $7, $8, $9, $10, $11, $12, $13)
     returning id`,
    [
      input.title,
      clientCompany.id,
      clientCompany.title,
      managerId,
      supportManagerId,
      input.validUntil ?? '',
      input.token,
      input.comment,
      input.workflowStatus,
      input.showRetailPrices,
      input.showStock,
      input.showStockText,
      input.isActive,
    ],
  );
  const id = Number(result.rows[0].id);
  await replaceWholesalePriceListItems(id, input.items);
  await replaceWholesalePriceListGroupStockSettings(id, input.priceGroupStockSettings);
  const actor = actorMeta(session);
  await insertPriceListEvent({
    priceListId: id,
    ownerManagerId: managerId,
    actorManagerId: actor.actorManagerId,
    actorRole: actor.actorRole,
    title: input.title,
    action: 'create',
    details: 'Прайс создан',
  });
  await trackAnalyticsEvent({
    eventType: 'price_public_link_created',
    actorType: actorTypeFromRole(actor.actorRole),
    actorUserId: actor.actorManagerId,
    managerId,
    priceListId: id,
    token: input.token,
    metadata: {
      title: input.title,
      clientCompanyId: clientCompany.id,
      clientName: clientCompany.title,
    },
  });
  return id;
}

export async function updateWholesalePriceList(
  id: number,
  input: Omit<WholesalePriceListEditor, 'id'>,
  session?: AdminSession | null,
) {
  await ensureSiteSchema();
  const scope = getWholesalePriceListAccessScope(session);
  const assignment = resolveWholesalePriceListManagerAssignment(input, session);
  const managerId = assignment.managerId;
  const supportManagerId = await normalizeWholesaleSupportManagerId(assignment.supportManagerId);
  const previous = await query<{
    title: string;
    client_name: string;
    manager_id: string | null;
    valid_until: string | null;
    workflow_status: string | null;
    is_active: boolean;
  }>(
    `select title, client_name, manager_id::text, valid_until::text, workflow_status, is_active
     from wholesale_price_lists
     where id = $1
       and (
         $2::bigint is null
         or ($3::text = 'manager' and manager_id = $2)
         or ($3::text = 'support_manager' and (support_manager_id = $2 or manager_id = $2))
       )
     limit 1`,
    [id, scope.managerId, scope.role],
  );
  const previousRow = previous.rows[0];
  if (!previousRow) return;
  const clientCompany = await resolveWholesaleClientCompany(input.clientCompanyId, session);
  const nextInput = { ...input, clientCompanyId: clientCompany.id, clientName: clientCompany.title };
  const previousItems = await query<{ count: string }>(
    `select count(*)::text as count
     from wholesale_price_list_items
     where price_list_id = $1 and visible = true`,
    [id],
  );
  const previousVisibleItems = Number(previousItems.rows[0]?.count ?? 0);
  const nextVisibleItems = nextInput.items.filter((item) => item.visible).length;

  await query(
    `update wholesale_price_lists
     set title = $2,
         client_company_id = $3,
         client_name = $4,
         manager_id = $5,
         support_manager_id = $6,
         valid_until = nullif($7, '')::date,
         token = $8,
         comment = $9,
         workflow_status = $10,
         show_retail_prices = $11,
         show_stock = $12,
         show_stock_text = $13,
         is_active = $14,
         updated_at = now()
     where id = $1
       and (
         $15::bigint is null
         or ($16::text = 'manager' and manager_id = $15)
         or ($16::text = 'support_manager' and (support_manager_id = $15 or manager_id = $15))
       )`,
    [
      id,
      nextInput.title,
      clientCompany.id,
      clientCompany.title,
      managerId,
      supportManagerId,
      nextInput.validUntil ?? '',
      nextInput.token,
      nextInput.comment,
      nextInput.workflowStatus,
      nextInput.showRetailPrices,
      nextInput.showStock,
      nextInput.showStockText,
      nextInput.isActive,
      scope.managerId,
      scope.role,
    ],
  );
  await replaceWholesalePriceListItems(id, nextInput.items);
  await replaceWholesalePriceListGroupStockSettings(id, nextInput.priceGroupStockSettings);
  const actor = actorMeta(session);
  await insertPriceListEvent({
    priceListId: id,
    ownerManagerId: managerId,
    actorManagerId: actor.actorManagerId,
    actorRole: actor.actorRole,
    title: nextInput.title,
    action: priceListAction(previousRow, nextInput),
    details: priceListDetails(previousRow, nextInput),
  });
  const baseEvent = {
    actorType: actorTypeFromRole(actor.actorRole),
    actorUserId: actor.actorManagerId,
    managerId,
    priceListId: id,
    token: nextInput.token,
  };
  if ((previousRow.client_name || '') !== nextInput.clientName) {
    await trackAnalyticsEvent({
      ...baseEvent,
      eventType: 'price_client_changed',
      clientId: clientIdFromName(nextInput.clientName),
      metadata: { from: previousRow.client_name, to: nextInput.clientName, title: nextInput.title, clientCompanyId: clientCompany.id },
    });
  }
  if ((previousRow.valid_until || '') !== (nextInput.validUntil || '')) {
    await trackAnalyticsEvent({
      ...baseEvent,
      eventType: 'price_expiration_changed',
      metadata: { from: previousRow.valid_until, to: nextInput.validUntil || null, title: nextInput.title },
    });
  }
  if (normalizeWholesalePriceWorkflowStatus(previousRow.workflow_status) !== nextInput.workflowStatus) {
    await trackAnalyticsEvent({
      ...baseEvent,
      eventType: 'price_status_changed',
      clientId: clientIdFromName(nextInput.clientName),
      metadata: {
        from: getWholesalePriceWorkflowStatusLabel(previousRow.workflow_status),
        to: getWholesalePriceWorkflowStatusLabel(nextInput.workflowStatus),
        title: nextInput.title,
        clientCompanyId: clientCompany.id,
        clientName: nextInput.clientName,
      },
    });
  }
  if (nextVisibleItems > previousVisibleItems) {
    await trackAnalyticsEvent({
      ...baseEvent,
      eventType: 'price_items_added',
      metadata: {
        added: nextVisibleItems - previousVisibleItems,
        from: previousVisibleItems,
        to: nextVisibleItems,
        title: nextInput.title,
      },
    });
  }
  if (nextVisibleItems < previousVisibleItems) {
    await trackAnalyticsEvent({
      ...baseEvent,
      eventType: 'price_items_removed',
      metadata: {
        removed: previousVisibleItems - nextVisibleItems,
        from: previousVisibleItems,
        to: nextVisibleItems,
        title: nextInput.title,
      },
    });
  }
}

export async function updateWholesalePriceListManagerAssignmentsForClientCompany(
  clientCompanyId: number,
  input: { managerId: number | null; supportManagerId: number | null },
  session?: AdminSession | null,
) {
  await ensureSiteSchema();
  const companyId = Number(clientCompanyId);
  if (!Number.isInteger(companyId) || companyId <= 0) return;
  if (session) await assertClientCompanyVisible(companyId, session);

  await query(
    `update wholesale_price_lists
     set manager_id = $2,
         support_manager_id = $3,
         updated_at = now()
     where client_company_id = $1`,
    [companyId, input.managerId, input.supportManagerId],
  );
}

export async function deleteWholesalePriceList(id: number, session?: AdminSession | null) {
  await ensureSiteSchema();
  const scope = getWholesalePriceListAccessScope(session);
  const previous = await query<{
    title: string;
    manager_id: string | null;
  }>(
    `select title, manager_id::text
     from wholesale_price_lists
     where id = $1
       and (
         $2::bigint is null
         or ($3::text = 'manager' and manager_id = $2)
         or ($3::text = 'support_manager' and (support_manager_id = $2 or manager_id = $2))
       )
     limit 1`,
    [id, scope.managerId, scope.role],
  );
  const previousRow = previous.rows[0];
  if (!previousRow) return;

  const actor = actorMeta(session);
  await insertPriceListEvent({
    priceListId: id,
    ownerManagerId: previousRow.manager_id ? Number(previousRow.manager_id) : null,
    actorManagerId: actor.actorManagerId,
    actorRole: actor.actorRole,
    title: previousRow.title,
    action: 'delete',
    details: 'Прайс удалён',
  });

  await query(
    `delete from wholesale_price_lists
     where id = $1
       and (
         $2::bigint is null
         or ($3::text = 'manager' and manager_id = $2)
         or ($3::text = 'support_manager' and (support_manager_id = $2 or manager_id = $2))
       )`,
    [id, scope.managerId, scope.role],
  );
}

export async function recordWholesaleManagerLogin(
  managerId: number,
  input: { ip?: string | null; userAgent?: string | null; referer?: string | null; actorType?: 'admin' | 'manager' },
) {
  await ensureSiteSchema();
  await query(
    `insert into wholesale_manager_login_logs (manager_id, ip, user_agent)
     values ($1, $2, $3)`,
    [managerId, input.ip ?? '', input.userAgent ?? ''],
  );
  await trackAnalyticsEvent({
    eventType: 'manager_login',
    actorType: input.actorType ?? 'manager',
    actorUserId: managerId,
    managerId,
    ip: input.ip,
    userAgent: input.userAgent,
    referer: input.referer,
  });
}

export async function recordWholesalePriceView(
  priceListId: number,
  token: string,
  input: {
    ip?: string | null;
    userAgent?: string | null;
    referer?: string | null;
    sessionId?: string | null;
    actorType?: 'admin' | 'manager' | 'client';
    actorUserId?: number | null;
    managerId?: number | null;
    clientName?: string | null;
    reopened?: boolean;
  },
) {
  await ensureSiteSchema();
  await query(
    `insert into wholesale_price_view_logs (price_list_id, token, ip, user_agent, referer)
     values ($1, $2, $3, $4, $5)`,
    [priceListId, token, input.ip ?? '', input.userAgent ?? '', input.referer ?? ''],
  );
  await trackAnalyticsEvent({
    eventType: input.reopened ? 'public_price_reopened' : 'public_price_opened',
    actorType: input.actorType ?? 'client',
    actorUserId: input.actorUserId,
    managerId: input.managerId,
    clientId: clientIdFromName(input.clientName),
    priceListId,
    token,
    sessionId: input.sessionId,
    ip: input.ip,
    userAgent: input.userAgent,
    referer: input.referer,
    metadata: {
      clientName: input.clientName ?? '',
    },
  });
}

async function replaceWholesalePriceListItems(id: number, items: WholesalePriceListItemInput[]) {
  await query(`delete from wholesale_price_list_items where price_list_id = $1`, [id]);

  for (const item of items) {
    const customWholesalePrice = item.priceManuallyChanged || item.discountPercent ? item.customWholesalePrice : null;
    await query(
      `insert into wholesale_price_list_items (
         price_list_id, wholesale_product_id, wholesale_variant_id, custom_wholesale_price, discount_percent, price_manually_changed, visible, sort_order
       )
       select $1, p.id, v.id, nullif($4, '')::numeric, nullif($5, '')::numeric, $6, $7, $8
       from wholesale_products p
       left join wholesale_product_variants v on v.id = $3 and v.product_id = p.id
       where p.id = $2
         and ($3::bigint is null or v.id is not null)`,
      [
        id,
        item.productId,
        item.variantId,
        customWholesalePrice ?? '',
        item.discountPercent ?? '',
        item.priceManuallyChanged,
        item.visible,
        item.sortOrder,
      ],
    );
  }
}

async function replaceWholesalePriceListGroupStockSettings(id: number, settings: WholesalePriceGroupStockSettingInput[]) {
  await query(`delete from wholesale_price_list_group_stock_settings where price_list_id = $1`, [id]);

  for (const setting of settings) {
    const priceGroup = setting.priceGroup.trim().slice(0, 180);
    if (!priceGroup || (!setting.showStock && !setting.showStockText)) continue;

    await query(
      `insert into wholesale_price_list_group_stock_settings (
         price_list_id, price_group, show_stock_numbers, show_stock_text
       )
       values ($1, $2, $3, $4)
       on conflict (price_list_id, price_group) do update
       set show_stock_numbers = excluded.show_stock_numbers,
           show_stock_text = excluded.show_stock_text,
           updated_at = now()`,
      [id, priceGroup, setting.showStock, setting.showStockText],
    );
  }
}
