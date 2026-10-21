import { query, withTransaction } from './client';
import { ensureSiteSchema } from './schema';
import { normalizePublicWholesalePriceToken } from './wholesalePriceTelemetryRepo';
import { readPublicWholesalePriceRevision, type PriceReadQuery } from './wholesalePriceRevision';
import { createPriceReadCache } from '../priceReadCache';
import { createPricePerformanceTrace } from '../pricePerformance';
import { deserialize } from 'node:v8';
import { buildPublicWholesalePriceInWorker, freezePrice } from '../priceBuild/client';
import { runSharedPriceBuild } from '../priceBuild/coordinator';
import { createPriceSnapshotQuery } from '../priceBuild/snapshotDeadline';
import { PriceBuildError } from '../priceBuild/errors';
import type { PublicWholesalePriceList, PublicWholesalePriceMetadata, PriceItemRow } from '../priceBuild/types';
export type { PublicWholesaleVariant, PublicWholesaleProduct, PublicWholesaleCategory, PublicWholesalePriceList, PublicWholesalePriceMetadata } from '../priceBuild/types';

type PriceListRow = {
  id: string;
  client_company_id: string | null;
  title: string;
  token: string;
  client_name: string;
  manager_id: string | null;
  manager_name: string | null;
  manager_email: string | null;
  manager_phone: string | null;
  support_manager_id: string | null;
  support_manager_name: string | null;
  support_manager_email: string | null;
  support_manager_phone: string | null;
  valid_until: string | null;
  updated_at: string;
  show_retail_prices: boolean;
  show_stock: boolean;
  show_stock_text: boolean;
};

export type PublicWholesaleRequestItem = {
  id: number;
  productTitle: string;
  sku: string;
  model: string;
  variantTitle: string;
  wholesalePrice: string | null;
  priceEur: string | null;
  priceRub: string | null;
  priceCny: string | null;
};

export async function getPublicWholesalePriceListMetadata(token: string): Promise<PublicWholesalePriceMetadata | null> {
  const normalizedToken = normalizePublicWholesalePriceToken(token);
  if (!normalizedToken) return null;
  await ensureSiteSchema();
  return readPublicWholesalePriceMetadata(normalizedToken, query);
}

async function readPublicWholesalePriceMetadata(normalizedToken: string, runQuery: PriceReadQuery): Promise<PublicWholesalePriceMetadata | null> {
  const priceList = await runQuery<PriceListRow>(
    `select
       pl.id::text,
       pl.client_company_id::text,
       pl.title,
       pl.token,
       pl.client_name,
       pl.manager_id::text,
       m.name as manager_name,
       m.email as manager_email,
       m.phone as manager_phone,
       support.id::text as support_manager_id,
       support.name as support_manager_name,
       support.email as support_manager_email,
       support.phone as support_manager_phone,
       pl.valid_until::text,
       pl.updated_at::text,
       pl.show_retail_prices,
       pl.show_stock,
       pl.show_stock_text
     from wholesale_price_lists pl
     left join wholesale_managers m on m.id = pl.manager_id
     left join wholesale_managers support on support.id = pl.support_manager_id and support.role = 'support_manager' and support.is_active = true
     where pl.token = $1 and pl.is_active = true
     limit 1`,
    [normalizedToken],
  );

  const priceListRow = priceList.rows[0];
  if (!priceListRow) return null;

  return {
    id: Number(priceListRow.id),
    clientCompanyId: priceListRow.client_company_id ? Number(priceListRow.client_company_id) : null,
    title: priceListRow.title,
    token: priceListRow.token,
    clientName: priceListRow.client_name,
    managerId: priceListRow.manager_id ? Number(priceListRow.manager_id) : null,
    managerName: priceListRow.manager_name ?? '',
    managerEmail: priceListRow.manager_email ?? '',
    managerPhone: priceListRow.manager_phone ?? '',
    supportManagerId: priceListRow.support_manager_id ? Number(priceListRow.support_manager_id) : null,
    supportManagerName: priceListRow.support_manager_name ?? '',
    supportManagerEmail: priceListRow.support_manager_email ?? '',
    supportManagerPhone: priceListRow.support_manager_phone ?? '',
    validUntil: priceListRow.valid_until,
    updatedAt: priceListRow.updated_at,
    showRetailPrices: priceListRow.show_retail_prices,
    showStock: priceListRow.show_stock !== false,
    showStockText: priceListRow.show_stock_text === true,
  };
}

export async function getPublicWholesalePriceListRevision(token: string): Promise<string | null> {
  const normalizedToken = normalizePublicWholesalePriceToken(token);
  if (!normalizedToken) return null;
  await ensureSiteSchema();
  return readPublicWholesalePriceRevision(normalizedToken, query);
}

async function readPublicWholesalePriceItems(token: string, runQuery: PriceReadQuery) {
  const items = await runQuery<PriceItemRow>(
    `select
       i.id::text as item_id,
       c.id::text as category_id,
       coalesce(i.snapshot_category_title, c.title, 'Без категории') as category_title,
       p.id::text as product_id,
       coalesce(i.snapshot_product_title, p.title) as product_title,
       coalesce(i.snapshot_product_sku, p.sku) as sku,
       p.model,
       coalesce(i.snapshot_product_description, p.series_description) as series_description,
       p.price_group,
       pgi.image_url as price_group_image_url,
       img.image_url,
       p.stock::text,
       p.stock_volzhsk::text,
       p.stock_moscow::text,
       p.unit,
       p.is_expected,
       gs.show_stock_numbers as group_show_stock_numbers,
       gs.show_stock_text as group_show_stock_text,
       p.stock_updated_at::text,
       v.id::text as variant_id,
       coalesce(i.snapshot_variant_title, v.title, '') as variant_title,
       coalesce(v.retail_price, p.retail_price)::text as retail_price,
       p.price_eur::text as retail_price_eur,
       p.price_rub::text as retail_price_rub,
       p.price_cny::text as retail_price_cny,
       case
         when p.price_rub is not null or p.price_eur is not null or p.price_cny is not null then null
         when i.price_manually_changed = true and i.custom_wholesale_price is not null then i.custom_wholesale_price::text
         when i.price_manually_changed = false
          and i.discount_percent is not null
          and coalesce(v.wholesale_price, p.wholesale_price) is not null then round(coalesce(v.wholesale_price, p.wholesale_price) * (1 - i.discount_percent / 100), 2)::text
         else coalesce(i.custom_wholesale_price, v.wholesale_price, p.wholesale_price)::text
       end as wholesale_price,
       case
         when p.price_eur is null then null
         when i.price_manually_changed = true and i.custom_wholesale_price is not null then
           case when p.price_rub is null then i.custom_wholesale_price::text else null end
         when i.price_manually_changed = false and i.discount_percent is not null then round(p.price_eur * (1 - i.discount_percent / 100), 2)::text
         else p.price_eur::text
       end as price_eur,
       case
         when p.price_rub is null then null
         when i.price_manually_changed = true and i.custom_wholesale_price is not null then i.custom_wholesale_price::text
         when i.price_manually_changed = false and i.discount_percent is not null then round(p.price_rub * (1 - i.discount_percent / 100), 2)::text
         else p.price_rub::text
       end as price_rub,
       case
         when p.price_cny is null then null
         when i.price_manually_changed = true and i.custom_wholesale_price is not null then
           case when p.price_rub is null and p.price_eur is null then i.custom_wholesale_price::text else null end
         when i.price_manually_changed = false and i.discount_percent is not null then round(p.price_cny * (1 - i.discount_percent / 100), 2)::text
         else p.price_cny::text
       end as price_cny
     from wholesale_price_lists pl
     join wholesale_price_list_items i on i.price_list_id = pl.id
     join wholesale_products p on p.id = i.wholesale_product_id
     left join wholesale_categories c on c.id = p.category_id
     left join wholesale_product_variants v on v.id = i.wholesale_variant_id and v.product_id = p.id
     left join price_group_images pgi on pgi.price_group = coalesce(nullif(trim(p.price_group), ''), 'Без ценовой группы')
     left join wholesale_price_list_group_stock_settings gs
       on gs.price_list_id = pl.id
      and gs.price_group = coalesce(nullif(trim(p.price_group), ''), 'Без ценовой группы')
     left join lateral (
       select image_url
       from wholesale_product_images
       where product_id = p.id and is_active = true
       order by sort_order asc, id asc
       limit 1
     ) img on true
     where pl.token = $1
       and pl.is_active = true
       and i.visible = true
       and p.is_active = true
       and (v.id is null or v.is_active = true)
     order by c.sort_order asc nulls last, c.id asc nulls last, p.sort_order asc, p.id asc, i.sort_order asc, v.sort_order asc nulls last`,
    [token],
  );
  return items.rows;
}

const cachedPriceSizes = new WeakMap<PublicWholesalePriceList, number>();
const publicPriceCache = createPriceReadCache<PublicWholesalePriceList | null>({
  maxEntries: 8, maxBytes: 32 * 1024 * 1024, ttlMs: 5 * 60_000,
  maxPending: 12,
  overloadError: () => new PriceBuildError('PRICE_BUILD_BUSY'),
  sizeOf: (price) => price ? (cachedPriceSizes.get(price) ?? Infinity) : 0,
  // A newer snapshot may legitimately be read after the initial revision check.
  // Return it, but never publish it as the result of the previous version.
  shouldCache: (price, key) => Boolean(price && key.startsWith(price.token + ':' + price.cacheRevision + ':')),
});

export async function getPublicWholesalePriceList(token: string, options: { includeAnalogs?: boolean } = {}): Promise<PublicWholesalePriceList | null> {
  const trace = createPricePerformanceTrace('price_read');
  try {
    const normalizedToken = normalizePublicWholesalePriceToken(token);
    if (!normalizedToken) { trace.finish(404); return null; }
    // Access is always checked live, including warm-cache hits and revoked links.
    const metadata = await trace.measure('access', () => getPublicWholesalePriceListMetadata(normalizedToken));
    if (!metadata) { trace.finish(404); return null; }
    const revision = await trace.measure('revision', () => getPublicWholesalePriceListRevision(normalizedToken));
    if (!revision) { trace.finish(404); return null; }
    const includeAnalogs = options.includeAnalogs !== false;
    const key = `${normalizedToken}:${revision}:${includeAnalogs ? 'page' : 'export'}`;
    const price = await publicPriceCache.read(key, () => trace.measure('build_coordinator', () => runSharedPriceBuild<PublicWholesalePriceList | null>({
      key: `price-build-v1:${metadata.id}:${key}`,
      onState: (state) => trace.measureSync(`shared_${state}`, () => undefined),
      decode: async (encoded, signal) => {
        const restored = trace.measureSync('cache_decode', () => deserialize(Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength))) as PublicWholesalePriceList;
        if (!restored || restored.id !== metadata.id || restored.token !== normalizedToken
          || restored.cacheRevision !== revision || !Array.isArray(restored.categories)) {
          throw new PriceBuildError('PRICE_BUILD_UNAVAILABLE');
        }
        await trace.measure('cache_freeze', () => freezePrice(restored, { signal }));
        cachedPriceSizes.set(restored, encoded.byteLength);
        return restored;
      },
      build: async ({ signal, deadlineAt }) => {
        if (signal.aborted) throw new PriceBuildError('PRICE_BUILD_ABORTED');
        const snapshot = await withTransaction(async (client) => {
          // No row locks or source writes. A concurrent manager save/import cannot
          // produce a half-old/half-new result stamped with the wrong revision.
          const runQuery: PriceReadQuery = createPriceSnapshotQuery(client, { signal, deadlineAt });
          await runQuery('set transaction isolation level repeatable read read only');
          const currentMetadata = await trace.measure('snapshot_access', () => readPublicWholesalePriceMetadata(normalizedToken, runQuery));
          if (!currentMetadata) return null;
          const currentRevision = await trace.measure('snapshot_revision', () => readPublicWholesalePriceRevision(normalizedToken, runQuery));
          if (!currentRevision) return null;
          const rows = await trace.measure('items', () => readPublicWholesalePriceItems(normalizedToken, runQuery));
          return { metadata: currentMetadata, revision: currentRevision, rows };
        }, { profile: 'read' });
        if (!snapshot) return { value: null, encoded: new Uint8Array(), cacheable: false };
        // No business-data connection remains held while the worker computes.
        const built = await trace.measure('worker', () => buildPublicWholesalePriceInWorker({
          ...snapshot, includeAnalogs,
        }, { signal, deadlineAt }));
        for (const [stage, wallMs] of Object.entries(built.timings)) trace.recordWorkerStage(stage, wallMs);
        for (const [stage, wallMs] of Object.entries(built.mainThreadTimings ?? {})) trace.recordMainStage(stage, wallMs);
        await trace.measure('freeze', () => freezePrice(built.price, { signal, deadlineAt }));
        cachedPriceSizes.set(built.price, built.cacheBytes);
        return { value: built.price, encoded: built.serialized,
          cacheable: snapshot.revision === revision && snapshot.metadata.id === metadata.id };
      },
    })), (state) => trace.measureSync(`cache_${state}`, () => undefined));
    // Also recheck after waiting for another request or a long cold calculation.
    const stillAccessible = await trace.measure('access_recheck', () => getPublicWholesalePriceListMetadata(normalizedToken));
    // A token may have been reassigned while the old price was being built.
    // Existence alone is not enough: never deliver the previous owner's data.
    const accessiblePrice = price && stillAccessible?.id === price.id && price.token === normalizedToken
      ? price : null;
    trace.finish(accessiblePrice ? 200 : 404);
    return accessiblePrice;
  } catch (error) {
    trace.finish('error');
    throw error;
  }
}

export async function getPublicWholesaleRequestItems(token: string, itemIds: number[]) {
  await ensureSiteSchema();
  const normalizedToken = token.trim();
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(normalizedToken)) return [];
  if (itemIds.length === 0) return [];

  const result = await query<{
    id: string;
    product_title: string;
    sku: string;
    model: string | null;
    variant_title: string | null;
    wholesale_price: string | null;
    price_eur: string | null;
    price_rub: string | null;
    price_cny: string | null;
  }>(
    `select
       i.id::text,
       coalesce(i.snapshot_product_title, p.title) as product_title,
       coalesce(i.snapshot_product_sku, p.sku) as sku,
       p.model,
       coalesce(i.snapshot_variant_title, v.title, '') as variant_title,
       case
         when p.price_rub is not null or p.price_eur is not null or p.price_cny is not null then null
         when i.price_manually_changed = true and i.custom_wholesale_price is not null then i.custom_wholesale_price::text
         when i.price_manually_changed = false
          and i.discount_percent is not null
          and coalesce(v.wholesale_price, p.wholesale_price) is not null then round(coalesce(v.wholesale_price, p.wholesale_price) * (1 - i.discount_percent / 100), 2)::text
         else coalesce(i.custom_wholesale_price, v.wholesale_price, p.wholesale_price)::text
       end as wholesale_price,
       case
         when p.price_eur is null then null
         when i.price_manually_changed = true and i.custom_wholesale_price is not null then
           case when p.price_rub is null then i.custom_wholesale_price::text else null end
         when i.price_manually_changed = false and i.discount_percent is not null then round(p.price_eur * (1 - i.discount_percent / 100), 2)::text
         else p.price_eur::text
       end as price_eur,
       case
         when p.price_rub is null then null
         when i.price_manually_changed = true and i.custom_wholesale_price is not null then i.custom_wholesale_price::text
         when i.price_manually_changed = false and i.discount_percent is not null then round(p.price_rub * (1 - i.discount_percent / 100), 2)::text
         else p.price_rub::text
       end as price_rub,
       case
         when p.price_cny is null then null
         when i.price_manually_changed = true and i.custom_wholesale_price is not null then
           case when p.price_rub is null and p.price_eur is null then i.custom_wholesale_price::text else null end
         when i.price_manually_changed = false and i.discount_percent is not null then round(p.price_cny * (1 - i.discount_percent / 100), 2)::text
         else p.price_cny::text
       end as price_cny
     from wholesale_price_lists pl
     join wholesale_price_list_items i on i.price_list_id = pl.id
     join wholesale_products p on p.id = i.wholesale_product_id
     left join wholesale_product_variants v on v.id = i.wholesale_variant_id and v.product_id = p.id
     where pl.token = $1
       and pl.is_active = true
       and i.visible = true
       and p.is_active = true
       and (v.id is null or v.is_active = true)
       and i.id = any($2::bigint[])
     order by i.sort_order asc, i.id asc`,
    [normalizedToken, itemIds],
  );

  return result.rows.map((row): PublicWholesaleRequestItem => ({
    id: Number(row.id),
    productTitle: row.product_title,
    sku: row.sku,
    model: row.model ?? '',
    variantTitle: row.variant_title || 'Цена',
    wholesalePrice: row.wholesale_price,
    priceEur: row.price_eur,
    priceRub: row.price_rub,
    priceCny: row.price_cny,
  }));
}
