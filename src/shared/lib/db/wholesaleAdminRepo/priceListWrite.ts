import type { WholesalePriceGroupStockSettingInput, WholesalePriceListItemInput } from './types';

// Inject the transaction's client.query; no global pool or transaction is opened here.
export type PriceListWriteQuery = (text: string, params: unknown[]) => Promise<{ rowCount: number | null }>;

export const WHOLESALE_PRICE_WRITE_BATCH_SIZE = 1000;

export async function replaceWholesalePriceListItems(
  execute: PriceListWriteQuery,
  id: number,
  items: WholesalePriceListItemInput[],
) {
  const keys = new Set<string>();
  for (const item of items) {
    const key = `${item.productId}:${item.variantId ?? 'base'}`;
    if (keys.has(key)) throw new Error('В прайсе есть повторяющиеся позиции. Обновите страницу и повторите сохранение.');
    keys.add(key);
  }
  // Legacy databases have no unique constraint on nullable variant keys. Fail
  // closed instead of merging/deleting historical duplicates or allowing their
  // extra UPDATE rows to mask a missing catalogue item in the batch row count.
  const legacyDuplicates = await execute(
    `select wholesale_product_id from wholesale_price_list_items
     where price_list_id = $1
     group by wholesale_product_id, wholesale_variant_id having count(*) > 1 limit 1`, [id],
  );
  if (legacyDuplicates.rowCount !== 0) throw new Error('В сохранённом прайсе есть повторяющиеся позиции. Прайс сохранён без изменений; требуется проверка администратором.');
  for (let offset = 0; offset < items.length; offset += WHOLESALE_PRICE_WRITE_BATCH_SIZE) {
    const batch = items.slice(offset, offset + WHOLESALE_PRICE_WRITE_BATCH_SIZE).map((item, index) => ({
      product_id: item.productId,
      variant_id: item.variantId,
      // An untouched calculated base price is not stored as an override, matching the existing rule.
      custom_wholesale_price: item.priceManuallyChanged || item.discountPercent ? item.customWholesalePrice : null,
      discount_percent: item.discountPercent,
      price_manually_changed: item.priceManuallyChanged,
      visible: item.visible,
      sort_order: item.sortOrder,
      input_order: index,
    }));
    const result = await execute(
      `with incoming as materialized (
         select p.id as product_id, v.id as variant_id,
                nullif(item.custom_wholesale_price, '')::numeric as custom_wholesale_price,
                nullif(item.discount_percent, '')::numeric as discount_percent,
                item.price_manually_changed, item.visible, item.sort_order, item.input_order
         from jsonb_to_recordset($2::jsonb) as item(
           product_id bigint, variant_id bigint, custom_wholesale_price text,
           discount_percent text, price_manually_changed boolean, visible boolean, sort_order integer, input_order integer
         )
         join wholesale_products p on p.id = item.product_id
         left join wholesale_product_variants v on v.id = item.variant_id and v.product_id = p.id
         where item.variant_id is null or v.id is not null
       ), updated as (
         update wholesale_price_list_items existing
         set custom_wholesale_price = item.custom_wholesale_price,
             discount_percent = item.discount_percent,
             price_manually_changed = item.price_manually_changed,
             visible = item.visible, sort_order = item.sort_order, updated_at = now()
         from incoming item
         where existing.price_list_id = $1
           and existing.wholesale_product_id = item.product_id
           and existing.wholesale_variant_id is not distinct from item.variant_id
         returning existing.id
       ), inserted as (
       insert into wholesale_price_list_items (
         price_list_id, wholesale_product_id, wholesale_variant_id, custom_wholesale_price,
         discount_percent, price_manually_changed, visible, sort_order
       )
       select $1, item.product_id, item.variant_id, item.custom_wholesale_price,
              item.discount_percent, item.price_manually_changed, item.visible, item.sort_order
       from incoming item
       where not exists (
         select 1 from wholesale_price_list_items existing
         where existing.price_list_id = $1 and existing.wholesale_product_id = item.product_id
           and existing.wholesale_variant_id is not distinct from item.variant_id
       )
       order by item.input_order
       returning id
       )
       select id from updated union all select id from inserted`,
      [id, JSON.stringify(batch)],
    );
    // A disappeared product or foreign/disappeared variant must roll back the whole price list.
    if (result.rowCount !== batch.length) throw new Error('Некоторые позиции каталога изменились. Обновите страницу и повторите сохранение прайса.');
  }
  // Only deliberately omitted logical positions are removed. Unchanged positions keep
  // their IDs, created_at and snapshot fields, so existing public baskets remain valid.
  // The enclosing transaction locks the price-list header for the entire reconciliation.
  await execute(
    `delete from wholesale_price_list_items existing
     where existing.price_list_id = $1 and not exists (
       select 1 from jsonb_to_recordset($2::jsonb) as item(product_id bigint, variant_id bigint)
       where existing.wholesale_product_id = item.product_id
         and existing.wholesale_variant_id is not distinct from item.variant_id
     )`,
    [id, JSON.stringify(items.map((item) => ({ product_id: item.productId, variant_id: item.variantId })))],
  );
}

export async function replaceWholesalePriceListGroupStockSettings(
  execute: PriceListWriteQuery,
  id: number,
  settings: WholesalePriceGroupStockSettingInput[],
) {
  await execute('delete from wholesale_price_list_group_stock_settings where price_list_id = $1', [id]);
  // Preserve ordered-upsert behavior when normalized names repeat: the last enabled entry wins.
  const normalized = new Map<string, WholesalePriceGroupStockSettingInput>();
  for (const setting of settings) {
    const priceGroup = setting.priceGroup.trim().slice(0, 180);
    if (priceGroup && (setting.showStock || setting.showStockText)) normalized.set(priceGroup, { ...setting, priceGroup });
  }
  const rows = [...normalized.values()];
  for (let offset = 0; offset < rows.length; offset += WHOLESALE_PRICE_WRITE_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + WHOLESALE_PRICE_WRITE_BATCH_SIZE).map((setting) => ({
      price_group: setting.priceGroup,
      show_stock_numbers: setting.showStock,
      show_stock_text: setting.showStockText,
    }));
    const result = await execute(
      `insert into wholesale_price_list_group_stock_settings (
         price_list_id, price_group, show_stock_numbers, show_stock_text
       )
       select $1, item.price_group, item.show_stock_numbers, item.show_stock_text
       from jsonb_to_recordset($2::jsonb) as item(price_group text, show_stock_numbers boolean, show_stock_text boolean)
       where true
       on conflict (price_list_id, price_group) do update
       set show_stock_numbers = excluded.show_stock_numbers,
           show_stock_text = excluded.show_stock_text,
           updated_at = now()`,
      [id, JSON.stringify(batch)],
    );
    if (result.rowCount !== batch.length) throw new Error('Не удалось сохранить настройки ценовых групп. Повторите сохранение прайса.');
  }
}
