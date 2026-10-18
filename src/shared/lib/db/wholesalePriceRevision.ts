import type { QueryResult, QueryResultRow } from 'pg';

export type PriceReadQuery = <T extends QueryResultRow>(sql: string, params?: unknown[]) => Promise<QueryResult<T>>;

/**
 * Read-only dependency version. xmin changes even where legacy importers omit
 * updated_at; ordered IDs also detect inserts/deletes. Only compact tuple
 * identities reach the aggregate, never full descriptions, prices or images.
 * Use the SAME repeatable-read snapshot as the payload on a cache miss.
 * Include the database start epoch: persistent export caches must not reuse
 * tuple transaction IDs from a restored/restarted database instance.
 */
export async function readPublicWholesalePriceRevision(token: string, runQuery: PriceReadQuery): Promise<string | null> {
  const result = await runQuery<{ revision: string }>(
    `with target as materialized (
       select id, manager_id, support_manager_id, xmin::text as version
       from wholesale_price_lists where token = $1 and is_active = true
     ), items as materialized (
       select i.id, i.wholesale_product_id, i.wholesale_variant_id, i.xmin::text as version
       from wholesale_price_list_items i join target t on t.id = i.price_list_id
     ), products as materialized (
       select p.id, p.category_id, p.price_group, p.xmin::text as version
       from wholesale_products p where p.id in (select wholesale_product_id from items)
     ), dependencies as (
       select 'list' as kind, id::text as id, version from target
       union all select 'item', id::text, version from items
       union all select 'product', id::text, version from products
       union all select 'category', c.id::text, c.xmin::text from wholesale_categories c
         where c.id in (select category_id from products)
       union all select 'variant', v.id::text, v.xmin::text from wholesale_product_variants v
         where v.id in (select wholesale_variant_id from items)
       union all select 'image', i.id::text, i.xmin::text from wholesale_product_images i
         where i.product_id in (select id from products)
       union all select 'group_image', g.price_group, g.xmin::text from price_group_images g
         where g.price_group in (select coalesce(nullif(trim(price_group), ''), 'Без ценовой группы') from products)
       union all select 'stock_setting', g.id::text, g.xmin::text from wholesale_price_list_group_stock_settings g
         where g.price_list_id in (select id from target)
       union all select 'manager', m.id::text, m.xmin::text from wholesale_managers m
         where m.id in (select manager_id from target union select support_manager_id from target)
     )
     select md5(current_database() || ':' || pg_postmaster_start_time()::text || ':' ||
       string_agg(json_build_array(kind, id, version)::text, ',' order by kind, id)) as revision
     from dependencies having exists(select 1 from target)`,
    [token],
  );
  return result.rows[0]?.revision ?? null;
}
