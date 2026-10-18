import type { AdminSession } from '@/shared/lib/adminAuth';
import { getWholesalePriceListAccessScope, type WholesalePriceListAccessScope, type WholesalePriceListManagerRole } from '@/shared/lib/wholesalePriceListAccess';
import { getWholesalePriceWorkflowStatusLabel, normalizeWholesalePriceWorkflowStatus } from '@/shared/lib/wholesalePriceWorkflowStatus';
import { query, withTransaction } from '../client';
import { ensureSiteSchema } from '../schema';
import type { WholesalePriceListSummary, WholesalePriceListEditor } from './types';

export type PriceListRow = {
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

export function mapPriceList(row: PriceListRow): WholesalePriceListSummary {
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

export async function getWholesalePriceListsByManager(scope: WholesalePriceListAccessScope) {
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

export async function getWholesalePriceListEditor(id: number, session?: AdminSession | null) {
  await ensureSiteSchema();
  const scope = getWholesalePriceListAccessScope(session);
  // Header/version, items and group settings must belong to the same committed
  // snapshot. Separate READ COMMITTED queries can pair old rows with a new token.
  return withTransaction(async (client) => {
    await client.query('set transaction isolation level repeatable read read only');
    const priceList = await client.query<
      Omit<WholesalePriceListEditor, 'id' | 'items' | 'clientCompanyId' | 'managerId' | 'supportManagerId' | 'priceGroupStockSettings'> & {
        id: string;
        client_company_id: string | null;
        manager_id: string | null;
        support_manager_id: string | null;
      }
    >(
      `select id::text, revision::text, title, client_company_id::text, client_name as "clientName", token, valid_until::text as "validUntil",
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

    const items = await client.query<{
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
    const groupStockSettings = await client.query<{
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
      revision: row.revision,
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
  });
}
