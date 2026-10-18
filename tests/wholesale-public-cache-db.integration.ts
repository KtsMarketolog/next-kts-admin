/** Run only via scripts/test-wholesale-public-cache-postgres.sh; all fixtures are synthetic. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { Client } from 'pg';

import { query } from '../src/shared/lib/db/client';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import {
  getPublicWholesalePriceList,
  getPublicWholesalePriceListMetadata,
  getPublicWholesalePriceListRevision,
  type PublicWholesalePriceList,
} from '../src/shared/lib/db/wholesaleRepo';

function guard() {
  assert.equal(process.env.KTS_PUBLIC_CACHE_TEST, '1', 'Explicit isolated public-cache test flag is required');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_public_cache_integration');
  assert.equal(url.username, 'public_cache_app');
  assert.equal(url.password, '');
  for (const [key] of url.searchParams) assert.ok(['host', 'port'].includes(key));
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-public-cache-postgres\.[A-Za-z0-9]+\/socket$/);
  assert.equal(url.searchParams.get('port'), '55476');
}

const token = 'synthetic_public_cache_price';
const secondToken = 'synthetic_other_personal_price';
const productsOf = (price: PublicWholesalePriceList) => price.categories.flatMap((category) => category.products);

async function stateDigest() {
  const tables = [
    'wholesale_price_lists', 'wholesale_price_list_items', 'wholesale_products', 'wholesale_categories',
    'wholesale_product_variants', 'wholesale_product_images', 'wholesale_managers',
    'price_group_images', 'wholesale_price_list_group_stock_settings', 'wholesale_price_list_events',
    'wholesale_analytics_events',
  ];
  return Promise.all(tables.map(async (table) => {
    // Names are fixed locally, never user data or a production connection.
    const result = await query<{ checksum: string }>(`select md5(coalesce(string_agg(row_to_json(t)::text,',' order by row_to_json(t)::text),'')) as checksum from ${table} t`);
    return [table, result.rows[0].checksum];
  }));
}

test('public price version cache preserves prices in an isolated PostgreSQL database', { timeout: 180_000 }, async (t) => {
  guard();
  try {
    assert.equal((await query<{ present: string | null }>(`select to_regclass('public.wholesale_products')::text as present`)).rows[0].present, null,
      'Refuse a database with existing application tables');
    await ensureSiteSchema();
    assert.deepEqual((await query(`select rolsuper,rolcreatedb,rolcreaterole from pg_roles where rolname=current_user`)).rows[0],
      { rolsuper: false, rolcreatedb: false, rolcreaterole: false });
    const managers = (await query<{ id: string }>(`insert into wholesale_managers (login,name,email,role)
      values ('cache-development','Synthetic Development','development@example.test','manager'),
      ('cache-support','Synthetic Support','support@example.test','support_manager') returning id::text`)).rows;
    const managerId = Number(managers[0].id), supportId = Number(managers[1].id);
    const categoryId = Number((await query<{ id: string }>(`insert into wholesale_categories(title,slug)
      values ('Synthetic Category','public-cache-fixture') returning id::text`)).rows[0].id);
    const productIds = (await query<{ id: string }>(`insert into wholesale_products
      (category_id,title,model,sku,price_group,series_description,retail_price,wholesale_price,stock,sort_order)
      select $1,'Synthetic Product '||g,
        case g when 1 then 'YWF.A2S-200S-5DIA00' when 2 then 'YWF2E-200S-92/15-G' else '' end,
        '', 'Synthetic Group','Synthetic description',200,100,10,g
      from generate_series(1,7562) g returning id::text`, [categoryId])).rows.map((row) => Number(row.id));
    const variantId = Number((await query<{ id: string }>(`insert into wholesale_product_variants
      (product_id,title,retail_price,wholesale_price) values ($1,'Original variant',220,110) returning id::text`, [productIds[0]])).rows[0].id);
    const priceId = Number((await query<{ id: string }>(`insert into wholesale_price_lists
      (title,token,client_name,manager_id,support_manager_id,show_retail_prices)
      values ('Synthetic full price',$1,'Synthetic client A',$2,$3,true) returning id::text`, [token, managerId, supportId])).rows[0].id);
    const secondPriceId = Number((await query<{ id: string }>(`insert into wholesale_price_lists
      (title,token,client_name,manager_id,support_manager_id) values ('Synthetic other price',$1,'Synthetic client B',$2,$3) returning id::text`,
    [secondToken, managerId, supportId])).rows[0].id);
    const itemIds = (await query<{ id: string }>(`insert into wholesale_price_list_items
      (price_list_id,wholesale_product_id,wholesale_variant_id,sort_order,custom_wholesale_price,price_manually_changed)
      select $1,id,case when id=$2 then $3::bigint else null end,sort_order,case when id=$2 then 91 else null end,id=$2
      from wholesale_products order by id returning id::text`, [priceId, productIds[0], variantId])).rows.map((row) => Number(row.id));
    await query(`insert into wholesale_price_list_items(price_list_id,wholesale_product_id,custom_wholesale_price,price_manually_changed)
      values ($1,$2,33,true)`, [secondPriceId, productIds[0]]);
    const imageId = Number((await query<{ id: string }>(`insert into wholesale_product_images(product_id,image_url,sort_order)
      values ($1,'/synthetic-image-a.png',1) returning id::text`, [productIds[0]])).rows[0].id);
    const spareImageId = Number((await query<{ id: string }>(`insert into wholesale_product_images(product_id,image_url,sort_order,is_active)
      values ($1,'/synthetic-image-b.png',0,false) returning id::text`, [productIds[0]])).rows[0].id);
    await query(`insert into price_group_images(price_group,image_url) values ('Synthetic Group','/synthetic-group-a.png')`);
    await query(`insert into wholesale_price_list_group_stock_settings(price_list_id,price_group,show_stock_numbers,show_stock_text)
      values ($1,'Synthetic Group',true,false)`, [priceId]);
    const read = async (key = token) => {
      const result = await getPublicWholesalePriceList(key, { includeAnalogs: false });
      assert.ok(result);
      return result;
    };
    const first = (price: PublicWholesalePriceList) => {
      const value = productsOf(price).find((product) => product.id === productIds[0]);
      assert.ok(value);
      return value;
    };
    const mutate = async (sql: string, params: unknown[], check: (price: PublicWholesalePriceList) => void) => {
      const before = await getPublicWholesalePriceListRevision(token);
      assert.ok(before);
      await query(sql, params); // Deliberately do not touch updated_at: versioning must not depend on it.
      const after = await getPublicWholesalePriceListRevision(token);
      assert.ok(after);
      assert.notDeepEqual(after, before, 'Every relevant committed dependency change must change the revision');
      check(await read());
    };

    await t.test('all 7,562 products and saved item identities survive cold and warm cache reads', async () => {
      const before = await stateDigest();
      const start = performance.now();
      const cold = await read();
      const coldMs = performance.now() - start;
      const warmStart = performance.now();
      const warm = await read();
      const warmMs = performance.now() - warmStart;
      assert.equal(productsOf(cold).length, 7562);
      assert.deepEqual(productsOf(cold).map((product) => product.id), productIds);
      assert.deepEqual(productsOf(cold).flatMap((product) => product.variants.map((variant) => variant.priceItemId)), itemIds);
      assert.deepEqual(warm, cold);
      assert.equal(warm.cacheRevision, await getPublicWholesalePriceListRevision(token));
      assert.ok(productsOf(warm).every((product) => product.analogs.length === 0));
      assert.equal(first(warm).variants[0].wholesalePrice, '91.00');
      assert.deepEqual(await stateDigest(), before, 'Reading/cache warmup must not mutate prices, rows or analytics');
      t.diagnostic(`Synthetic 7,562-row no-analogs read: cold ${coldMs.toFixed(1)} ms, warm ${warmMs.toFixed(1)} ms (local sample, not production timing)`);
    });

    await t.test('full HTML retains analog links while exports skip them without changing products or prices', async () => {
      const plain = await read();
      const full = await getPublicWholesalePriceList(token);
      assert.ok(full);
      assert.equal(productsOf(full).length, 7562);
      assert.deepEqual(first(full).analogs.map((link) => link.productId), [productIds[1]]);
      assert.deepEqual(productsOf(full).find((product) => product.id === productIds[1])?.analogs.map((link) => link.productId), [productIds[0]]);
      const withoutAnalogs = (price: PublicWholesalePriceList) => price.categories.map((category) => ({ ...category,
        products: category.products.map((product) => ({ ...product, analogs: [] })),
      }));
      assert.deepEqual(withoutAnalogs(full), withoutAnalogs(plain));
      assert.ok(productsOf(await read()).every((product) => product.analogs.length === 0), 'The HTML cache must not contaminate export results');
    });

    await t.test('personalized prices cannot leak between two tokens referencing the same product', async () => {
      const other = await read(secondToken);
      assert.equal(other.id, secondPriceId);
      assert.equal(other.clientName, 'Synthetic client B');
      assert.equal(productsOf(other).length, 1);
      assert.equal(first(other).variants[0].wholesalePrice, '33.00');
      assert.equal(first(await read()).variants[0].wholesalePrice, '91.00');
    });

    await t.test('a concurrent atomic manager save never exposes uncommitted or mixed header/item values', async () => {
      const before = await read();
      const beforeRevision = await getPublicWholesalePriceListRevision(token);
      const writer = new Client({ connectionString: process.env.DATABASE_URL });
      await writer.connect();
      try {
        await writer.query('begin');
        await writer.query(`update wholesale_price_lists set title='Atomic committed header' where id=$1`, [priceId]);
        await writer.query(`update wholesale_price_list_items set custom_wholesale_price=88.88 where id=$1`, [itemIds[0]]);
        const during = await read();
        assert.equal(during.title, before.title);
        assert.equal(first(during).variants[0].wholesalePrice, first(before).variants[0].wholesalePrice);
        assert.equal(during.cacheRevision, beforeRevision);
        await writer.query('commit');
        const after = await read();
        assert.equal(after.title, 'Atomic committed header');
        assert.equal(first(after).variants[0].wholesalePrice, '88.88');
        assert.notEqual(after.cacheRevision, beforeRevision);
        assert.equal(after.cacheRevision, await getPublicWholesalePriceListRevision(token));
      } finally {
        await writer.query('rollback').catch(() => undefined);
        await writer.end();
      }
    });

    await t.test('list header and manager contacts invalidate without updated_at changes', async () => {
      await mutate(`update wholesale_price_lists set title='Changed header',show_retail_prices=false where id=$1`, [priceId],
        (price) => { assert.equal(price.title, 'Changed header'); assert.equal(price.showRetailPrices, false); });
      await mutate(`update wholesale_managers set name='Changed manager',phone='+70000000000' where id=$1`, [managerId],
        (price) => { assert.equal(price.managerName, 'Changed manager'); assert.equal(price.managerPhone, '+70000000000'); });
      await mutate(`update wholesale_managers set is_active=false where id=$1`, [supportId],
        (price) => assert.equal(price.supportManagerId, null));
      await mutate(`update wholesale_managers set is_active=true,name='Reactivated support' where id=$1`, [supportId],
        (price) => assert.equal(price.supportManagerName, 'Reactivated support'));
    });

    await t.test('item prices, snapshots and visibility invalidate without deleting saved items', async () => {
      await mutate(`update wholesale_price_list_items set custom_wholesale_price=77.12,snapshot_product_title='Saved snapshot title' where id=$1`,
        [itemIds[0]], (price) => { assert.equal(first(price).title, 'Saved snapshot title'); assert.equal(first(price).variants[0].wholesalePrice, '77.12'); });
      await mutate(`update wholesale_price_list_items set visible=false where id=$1`, [itemIds[1]],
        (price) => assert.equal(productsOf(price).length, 7561));
      assert.equal((await query<{ count: string }>(`select count(*)::text as count from wholesale_price_list_items where price_list_id=$1`, [priceId])).rows[0].count, '7562');
      await mutate(`update wholesale_price_list_items set visible=true where id=$1`, [itemIds[1]],
        (price) => assert.equal(productsOf(price).length, 7562));
      await query(`update wholesale_price_list_items set snapshot_product_title=null where id=$1`, [itemIds[0]]);
    });

    await t.test('catalogue descriptions, stock, currency prices and category labels invalidate', async () => {
      await mutate(`update wholesale_products set title='Changed product',series_description='Changed description',stock=73,
        stock_volzhsk=20,stock_moscow=53,unit='шт',is_expected=true,stock_updated_at='2026-10-18T12:00:00Z' where id=$1`, [productIds[0]],
      (price) => {
        const product = first(price);
        assert.equal(product.title, 'Changed product'); assert.equal(product.description, 'Changed description');
        assert.equal(product.stock, 73); assert.equal(product.stockVolzhsk, 20); assert.equal(product.stockMoscow, 53);
        assert.equal(product.unit, 'шт'); assert.equal(product.isExpected, true); assert.ok(product.stockUpdatedAt);
      });
      await mutate(`update wholesale_products set price_eur=42.75,price_rub=4000,price_cny=300 where id=$1`, [productIds[1]], (price) => {
        const variant = productsOf(price).find((product) => product.id === productIds[1])!.variants[0];
        assert.equal(variant.priceEur, '42.75'); assert.equal(variant.priceRub, '4000.00'); assert.equal(variant.priceCny, '300.00');
      });
      await mutate(`update wholesale_categories set title='Changed category' where id=$1`, [categoryId],
        (price) => assert.equal(price.categories[0].title, 'Changed category'));
    });

    await t.test('variant edits and deactivation/reactivation invalidate', async () => {
      await mutate(`update wholesale_product_variants set title='Changed variant',retail_price=500 where id=$1`, [variantId],
        (price) => { assert.equal(first(price).variants[0].title, 'Changed variant'); assert.equal(first(price).variants[0].retailPrice, '500.00'); });
      await mutate(`update wholesale_product_variants set is_active=false where id=$1`, [variantId],
        (price) => assert.equal(productsOf(price).some((product) => product.id === productIds[0]), false));
      await mutate(`update wholesale_product_variants set is_active=true where id=$1`, [variantId],
        (price) => assert.equal(first(price).variants[0].id, variantId));
    });

    await t.test('product deactivation and reactivation keep all stored price settings', async () => {
      const storedBefore = (await query(`select row_to_json(i) as item from wholesale_price_list_items i where id=$1`, [itemIds[0]])).rows[0];
      await mutate(`update wholesale_products set is_active=false where id=$1`, [productIds[0]],
        (price) => assert.equal(productsOf(price).length, 7561));
      await mutate(`update wholesale_products set is_active=true where id=$1`, [productIds[0]],
        (price) => { assert.equal(productsOf(price).length, 7562); assert.equal(first(price).variants[0].wholesalePrice, '77.12'); });
      assert.deepEqual((await query(`select row_to_json(i) as item from wholesale_price_list_items i where id=$1`, [itemIds[0]])).rows[0], storedBefore);
    });

    await t.test('image edits, earlier image activation and deletion invalidate the selected image', async () => {
      await mutate(`update wholesale_product_images set image_url='/synthetic-image-edited.png' where id=$1`, [imageId],
        (price) => assert.equal(first(price).imageUrl, '/synthetic-image-edited.png'));
      await mutate(`update wholesale_product_images set is_active=true where id=$1`, [spareImageId],
        (price) => assert.equal(first(price).imageUrl, '/synthetic-image-b.png'));
      await mutate(`delete from wholesale_product_images where id=$1`, [spareImageId],
        (price) => assert.equal(first(price).imageUrl, '/synthetic-image-edited.png'));
    });

    await t.test('group images and per-price stock display settings invalidate', async () => {
      await mutate(`update price_group_images set image_url='/synthetic-group-edited.png' where price_group='Synthetic Group'`, [],
        (price) => assert.equal(first(price).priceGroupImageUrl, '/synthetic-group-edited.png'));
      await mutate(`update wholesale_price_list_group_stock_settings set show_stock_numbers=false,show_stock_text=true where price_list_id=$1`, [priceId],
        (price) => assert.equal(first(price).stockDisplayMode, 'text'));
      await mutate(`delete from price_group_images where price_group='Synthetic Group'`, [],
        (price) => assert.equal(first(price).priceGroupImageUrl, null));
      await mutate(`insert into price_group_images(price_group,image_url) values ('Synthetic Group','/synthetic-group-new.png')`, [],
        (price) => assert.equal(first(price).priceGroupImageUrl, '/synthetic-group-new.png'));
    });

    await t.test('a committed synthetic item deletion changes membership but reads never delete additional rows', async () => {
      await mutate(`delete from wholesale_price_list_items where id=$1`, [itemIds.at(-1)],
        (price) => assert.equal(productsOf(price).length, 7561));
      const before = await stateDigest();
      await Promise.all(Array.from({ length: 12 }, () => read()));
      assert.deepEqual(await stateDigest(), before);
      assert.equal((await query<{ count: string }>(`select count(*)::text as count from wholesale_products`)).rows[0].count, '7562');
    });

    await t.test('revocation and token rotation cannot be served from a warm cache', async () => {
      await read();
      await query(`update wholesale_price_lists set is_active=false where id=$1`, [priceId]);
      assert.equal(await getPublicWholesalePriceListMetadata(token), null);
      assert.equal(await getPublicWholesalePriceListRevision(token), null);
      assert.equal(await getPublicWholesalePriceList(token), null);
      await query(`update wholesale_price_lists set is_active=true where id=$1`, [priceId]);
      assert.equal((await read()).id, priceId);
      const rotated = 'synthetic_rotated_public_cache_price';
      await query(`update wholesale_price_lists set token=$1 where id=$2`, [rotated, priceId]);
      assert.equal(await getPublicWholesalePriceListMetadata(token), null);
      assert.equal(await getPublicWholesalePriceListRevision(token), null);
      assert.equal(await getPublicWholesalePriceList(token), null);
      assert.equal((await read(rotated)).id, priceId);
      assert.equal((await read(secondToken)).id, secondPriceId, 'Independent existing price remains available');
      assert.equal((await query<{ count: string }>(`select count(*)::text as count from wholesale_price_lists`)).rows[0].count, '2');
    });
  } finally {
    await globalThis.__ktsPgPool?.end();
    globalThis.__ktsPgPool = undefined;
  }
});
