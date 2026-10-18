/** Synthetic PostgreSQL acceptance only. Run via scripts/test-wholesale-price-postgres.sh. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client } from 'pg';

import type { AdminSession } from '../src/shared/lib/adminAuth';
import { query } from '../src/shared/lib/db/client';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import { createWholesalePriceList, getWholesaleCatalog, getWholesalePriceListEditor, updateWholesalePriceList } from '../src/shared/lib/db/wholesaleAdminRepo/core';
import type { WholesalePriceListEditor, WholesalePriceListItemInput } from '../src/shared/lib/db/wholesaleAdminRepo/types';
import { getPublicWholesalePriceList, getPublicWholesaleRequestItems } from '../src/shared/lib/db/wholesaleRepo';
import { parseWholesalePriceItems, readWholesalePriceSaveBody } from '../src/shared/lib/wholesalePriceSave';

function guard() {
  assert.equal(process.env.KTS_WHOLESALE_TEST, '1', 'Explicit isolated wholesale integration flag is required');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_wholesale_integration');
  assert.equal(url.username, 'wholesale_app');
  assert.equal(url.password, '', 'Test role has no application credentials');
  for (const [key] of url.searchParams) assert.ok(['host', 'port'].includes(key));
  const socket = url.searchParams.get('host') ?? '';
  assert.match(socket, /^\/(?:private\/)?tmp\/kts-wholesale-postgres\.[A-Za-z0-9]+\/socket$/);
  assert.equal(url.searchParams.get('port'), '55474');
}

type SaveInput = Omit<WholesalePriceListEditor, 'id'>;
const admin: AdminSession = { role: 'admin' };
async function normalized(items: WholesalePriceListItemInput[]) {
  const request = new Request('http://localhost/api/test-price', {
    method: 'POST', body: JSON.stringify({ items }), headers: { 'content-type': 'application/json' },
  });
  const body = await readWholesalePriceSaveBody(request);
  return parseWholesalePriceItems(body.items);
}
async function stableState(id: number) {
  const result = await query<{ header: unknown; items: string; groups: string; events: string }>(`select
    row_to_json(p.*) as header,
    (select md5(coalesce(string_agg(row_to_json(i.*)::text,',' order by i.id),'')) from wholesale_price_list_items i where i.price_list_id=p.id) as items,
    (select md5(coalesce(string_agg(row_to_json(g.*)::text,',' order by g.id),'')) from wholesale_price_list_group_stock_settings g where g.price_list_id=p.id) as groups,
    (select count(*)::text from wholesale_price_list_events e where e.price_list_id=p.id) as events
    from wholesale_price_lists p where p.id=$1`, [id]);
  return result.rows[0];
}
function canonical(items: WholesalePriceListItemInput[]) {
  return items.map((row) => ({ ...row,
    customWholesalePrice: (row.priceManuallyChanged || row.discountPercent) && row.customWholesalePrice !== null
      ? Number(row.customWholesalePrice).toFixed(2) : null,
    discountPercent: row.discountPercent === null ? null : Number(row.discountPercent).toFixed(2),
  }));
}

test('wholesale full-catalogue saves in isolated PostgreSQL', { timeout: 180_000 }, async (t) => {
  guard();
  try {
    const empty = await query<{ present: string | null }>(`select to_regclass('public.wholesale_products')::text as present`);
    assert.equal(empty.rows[0].present, null, 'Refuse any pre-existing application schema');
    await ensureSiteSchema();
    const role = await query<{ rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>(
      `select rolsuper,rolcreatedb,rolcreaterole from pg_roles where rolname=current_user`);
    assert.deepEqual(role.rows[0], { rolsuper: false, rolcreatedb: false, rolcreaterole: false });
    const managers = await query<{ id: string; role: string }>(`insert into wholesale_managers (login,name,email,role)
      values ('test-development','Synthetic Development','development@example.test','manager'),
      ('test-support','Synthetic Support','support@example.test','support_manager'),
      ('test-other','Synthetic Other','other@example.test','manager') returning id::text,role`);
    const managerId = Number(managers.rows[0].id);
    const supportManagerId = Number(managers.rows[1].id);
    const otherManagerId = Number(managers.rows[2].id);
    const company = await query<{ id: string }>(`insert into client_companies (title,manager_id,support_manager_id)
      values ('Synthetic Wholesale Acceptance',$1,$2) returning id::text`, [managerId, supportManagerId]);
    const category = await query<{ id: string }>(`insert into wholesale_categories (title,slug)
      values ('Synthetic Catalogue','synthetic-wholesale-acceptance') returning id::text`);
    const products = await query<{ id: string }>(`insert into wholesale_products
      (category_id,title,sku,series_description,price_group,retail_price,wholesale_price,sort_order)
      select $1,'Synthetic Product '||g,'SYNTHETIC-'||g,'Synthetic description '||g,
      'Synthetic Group',400,200,g from generate_series(1,20001) g returning id::text`, [Number(category.rows[0].id)]);
    const productIds = products.rows.map((row) => Number(row.id));
    assert.equal(productIds.length, 20001);
    const variants = await query<{ id: string; product_id: string }>(`insert into wholesale_product_variants
      (product_id,title,size_key,wholesale_price,retail_price) values ($1,'Synthetic Variant 7474','A',200,400),
      ($2,'Synthetic Variant 20000','B',200,400) returning id::text,product_id::text`, [productIds[7474], productIds[20000]]);
    const variantByProduct = new Map(variants.rows.map((row) => [Number(row.product_id), Number(row.id)]));
    const makeItems = (count: number): WholesalePriceListItemInput[] => productIds.slice(0, count).map((productId, index) => ({
      productId, variantId: variantByProduct.get(productId) ?? null, customWholesalePrice: null,
      discountPercent: null, priceManuallyChanged: false, visible: false, sortOrder: index + 1,
    }));
    const input = (items: WholesalePriceListItemInput[], title = 'Synthetic complete price'): SaveInput => ({
      title, clientCompanyId: Number(company.rows[0].id), clientName: 'ignored supplied client title',
      managerId, supportManagerId, token: `test_${randomUUID().replaceAll('-', '')}`,
      validUntil: null, comment: 'Synthetic acceptance data only', workflowStatus: 'not_sent',
      showRetailPrices: true, showStock: true, showStockText: false, isActive: true, items,
      priceGroupStockSettings: [{ priceGroup: 'Synthetic Group', showStock: false, showStockText: true }],
    });
    let priceId = 0;
    let savedInput: SaveInput;
    const companyId = Number(company.rows[0].id);
    const companyState = async () => (await query(`select row_to_json(c.*) as company from client_companies c where id=$1`, [companyId])).rows[0];
    const totals = async () => (await query(`select
      (select count(*)::text from wholesale_price_lists) as prices,
      (select count(*)::text from wholesale_price_list_items) as items,
      (select count(*)::text from wholesale_price_list_events) as events,
      (select count(*)::text from wholesale_analytics_events) as analytics`)).rows[0];
    const waitForLock = async (fragment: string) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        const blocked = await query<{ n: string }>(`select count(*)::text as n from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock' and query like $1`, [`%${fragment}%`]);
        if (Number(blocked.rows[0].n) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.fail('Expected the synthetic price save to wait for its row lock');
    };

    await t.test('create stores 7475 rows including hidden rows and the last manual/discount/variant item', async () => {
      const rows = makeItems(7475);
      rows[0].visible = true;
      Object.assign(rows[5000], { visible: false, customWholesalePrice: '999.00', priceManuallyChanged: true });
      Object.assign(rows[7474], { visible: true, customWholesalePrice: '321.09', discountPercent: '9.50', priceManuallyChanged: true });
      savedInput = input(await normalized(rows));
      priceId = await createWholesalePriceList(savedInput, admin);
      const editor = await getWholesalePriceListEditor(priceId, admin);
      assert.ok(editor);
      assert.equal(editor.items.length, 7475);
      assert.deepEqual(editor.items, canonical(savedInput.items));
      assert.deepEqual(editor.priceGroupStockSettings, savedInput.priceGroupStockSettings);
      assert.equal(editor.clientName, 'Synthetic Wholesale Acceptance');
      const publicPrice = await getPublicWholesalePriceList(savedInput.token);
      assert.ok(publicPrice);
      const shown = publicPrice.categories.flatMap((entry) => entry.products);
      assert.deepEqual(shown.map((row) => row.id), [productIds[0], productIds[7474]]);
      assert.equal(shown[1].variants[0].wholesalePrice, '321.09', 'manual price must win over discount');
      assert.equal(shown[1].variants[0].id, variantByProduct.get(productIds[7474]));
      assert.equal(shown[1].stockDisplayMode, 'text');
    });

    await t.test('update expands to 20001 rows and preserves late discounts/manual prices and changed visibility', async () => {
      const rows = makeItems(20001);
      Object.assign(rows[5000], { visible: false, customWholesalePrice: '777.00', priceManuallyChanged: true });
      Object.assign(rows[7474], { visible: true, customWholesalePrice: '987.65', discountPercent: '10', priceManuallyChanged: true });
      Object.assign(rows[19999], { visible: true, customWholesalePrice: '1.00' });
      Object.assign(rows[20000], { visible: true, customWholesalePrice: '163.50', discountPercent: '18.25', priceManuallyChanged: false });
      savedInput = { ...savedInput, title: 'Synthetic updated 20001', items: await normalized(rows),
        workflowStatus: 'sent', priceGroupStockSettings: [{ priceGroup: 'Synthetic Group', showStock: true, showStockText: false }] };
      await updateWholesalePriceList(priceId, savedInput, admin);
      const editor = await getWholesalePriceListEditor(priceId, admin);
      assert.ok(editor);
      assert.equal(editor.items.length, 20001);
      assert.deepEqual(editor.items, canonical(savedInput.items));
      assert.deepEqual(editor.priceGroupStockSettings, savedInput.priceGroupStockSettings);
      assert.equal(editor.workflowStatus, 'sent');
      const publicPrice = await getPublicWholesalePriceList(savedInput.token);
      assert.ok(publicPrice);
      const shown = publicPrice.categories.flatMap((entry) => entry.products);
      assert.deepEqual(shown.map((row) => row.id), [productIds[7474], productIds[19999], productIds[20000]]);
      assert.equal(shown[0].variants[0].wholesalePrice, '987.65');
      assert.equal(shown[1].variants[0].wholesalePrice, '200.00', 'non-manual price with no discount must use the catalogue');
      assert.equal(shown[2].variants[0].wholesalePrice, '163.50');
    });

    await t.test('editor JSON roundtrip retains the entire 20001-row saved configuration', async () => {
      const before = await getWholesalePriceListEditor(priceId, admin);
      assert.ok(before);
      await updateWholesalePriceList(priceId, { ...before, items: await normalized(before.items) }, admin);
      const after = await getWholesalePriceListEditor(priceId, admin);
      assert.deepEqual(after, before);
    });

    await t.test('resaving preserves old prices, tokens, item IDs, snapshots and an already open basket', async () => {
      const historical = input(makeItems(2), 'Historical price must survive');
      historical.items[0] = { ...historical.items[0], visible: true, discountPercent: '25', customWholesalePrice: '150.00' };
      const historicalId = await createWholesalePriceList(historical, admin);
      const historicalBefore = await stableState(historicalId);
      await query(`update wholesale_price_list_items set snapshot_product_title='Retained snapshot'
        where price_list_id=$1 and wholesale_product_id=$2`, [priceId, productIds[7474]]);
      const identities = async () => (await query(`select id::text, wholesale_product_id::text,
        wholesale_variant_id::text, created_at::text, snapshot_product_title
        from wholesale_price_list_items where price_list_id=$1 order by id`, [priceId])).rows;
      const oldIdentities = await identities();
      const basketIds = (await query<{ id: string }>(`select id::text from wholesale_price_list_items
        where price_list_id=$1 and visible=true order by id`, [priceId])).rows.map((row) => Number(row.id));
      const oldBasket = await getPublicWholesaleRequestItems(savedInput.token, basketIds);
      assert.equal(oldBasket.length, basketIds.length);
      const editor = await getWholesalePriceListEditor(priceId, admin);
      assert.ok(editor);
      await updateWholesalePriceList(priceId, { ...editor, comment: 'Only changed a comment' }, admin);
      assert.deepEqual(await identities(), oldIdentities, 'public item identity and historical snapshots must not change');
      assert.deepEqual(await getPublicWholesaleRequestItems(savedInput.token, basketIds), oldBasket);
      assert.deepEqual(await stableState(historicalId), historicalBefore, 'another existing price is byte-for-byte untouched');
      assert.equal((await getWholesalePriceListEditor(priceId, admin))!.token, savedInput.token);
      assert.equal((await query(`select count(*)::text as n from wholesale_price_lists`)).rows[0].n, '2');
    });

    await t.test('empty item payload preserves every stored row and reports no item removals', async () => {
      const before = await getWholesalePriceListEditor(priceId, admin);
      assert.ok(before);
      const rowState = async () => (await stableState(priceId)).items;
      const itemsBefore = await rowState();
      const basketIds = (await query<{ id: string }>(`select id::text from wholesale_price_list_items
        where price_list_id=$1 and visible=true order by id`, [priceId])).rows.map((row) => Number(row.id));
      const basketBefore = await getPublicWholesaleRequestItems(before.token, basketIds);
      const removalCount = async () => (await query<{ n: string }>(`select count(*)::text as n
        from wholesale_analytics_events where price_list_id=$1 and event_type='price_items_removed'`, [priceId])).rows[0].n;
      const removalsBefore = await removalCount();

      await updateWholesalePriceList(priceId, { ...before, comment: 'Metadata-only save after an empty item payload', items: [] }, admin);

      const after = await getWholesalePriceListEditor(priceId, admin);
      assert.ok(after);
      assert.deepEqual(after.items, before.items);
      assert.equal(await rowState(), itemsBefore, 'empty payload must not even touch stored item timestamps/snapshots');
      assert.equal(after.token, before.token);
      assert.equal(await removalCount(), removalsBefore, 'omitted visible rows are not removals');
      assert.deepEqual(await getPublicWholesaleRequestItems(before.token, basketIds), basketBefore);
    });

    await t.test('partial saves retain inactive products/variants and their settings on reactivation; hiding remains explicit', async () => {
      const candidates = makeItems(20001);
      const rows = [candidates[0], candidates[1], candidates[7474], candidates[20000], candidates[2]];
      Object.assign(rows[0], { visible: true, customWholesalePrice: '75.00', priceManuallyChanged: true });
      Object.assign(rows[1], { visible: true, customWholesalePrice: '123.45', discountPercent: '17.25', priceManuallyChanged: true });
      Object.assign(rows[2], { visible: true, customWholesalePrice: '150.00', discountPercent: '25', priceManuallyChanged: false });
      Object.assign(rows[3], { visible: false, customWholesalePrice: '42.50', discountPercent: '9', priceManuallyChanged: true });
      rows[4].visible = true;
      const data = input(rows, 'Inactive items keep all settings');
      const testPriceId = await createWholesalePriceList(data, admin);
      await query(`update wholesale_price_list_items set snapshot_product_title='Retained inactive snapshot'
        where price_list_id=$1 and wholesale_product_id in ($2,$3)`, [testPriceId, rows[1].productId, rows[2].productId]);
      // Legacy databases can have an override without today's manual/discount
      // flags. Re-serializing that unavailable row would normalize its price to
      // null. An omitted key must preserve the historical row exactly instead.
      await query(`update wholesale_price_list_items set custom_wholesale_price=78.90,
        price_manually_changed=false, discount_percent=null
        where price_list_id=$1 and wholesale_product_id=$2`, [testPriceId, rows[4].productId]);
      const retainedRows = async () => (await query(`select row_to_json(i.*) as item
        from wholesale_price_list_items i where price_list_id=$1 and wholesale_product_id <> $2 order by id`,
      [testPriceId, rows[0].productId])).rows;
      const before = await retainedRows();
      await query('update wholesale_products set is_active=false where id in ($1,$2)', [rows[1].productId, rows[4].productId]);
      await query('update wholesale_product_variants set is_active=false where id=$1', [rows[2].variantId]);
      try {
        const catalog = await getWholesaleCatalog();
        const products = catalog.flatMap((category) => category.products);
        assert.ok(!products.some((product) => product.id === rows[1].productId));
        assert.ok(!products.some((product) => product.id === rows[4].productId));
        assert.ok(!products.some((product) => product.variants.some((variant) => variant.id === rows[2].variantId)));

        // The editor only sends a remaining active position, deliberately hidden.
        // All omitted visible/inactive/hidden positions are independent stored state.
        await updateWholesalePriceList(testPriceId, { ...data, items: [{ ...rows[0], visible: false }] }, admin);
        assert.deepEqual(await retainedRows(), before, 'omission must preserve IDs, timestamps, prices, discounts and snapshot fields');
        await updateWholesalePriceList(testPriceId, { ...data, items: [] }, admin);
        assert.deepEqual(await retainedRows(), before, 'a later empty payload must also retain the legacy override verbatim');
        const editor = await getWholesalePriceListEditor(testPriceId, admin);
        assert.ok(editor);
        assert.equal(editor.items.length, 5);
        assert.equal(editor.items.find((item) => item.productId === rows[0].productId)!.visible, false);
        assert.equal(editor.items.find((item) => item.productId === rows[0].productId)!.customWholesalePrice, '75.00');
        const legacy = editor.items.find((item) => item.productId === rows[4].productId)!;
        assert.equal(legacy.customWholesalePrice, '78.90');
        assert.equal(legacy.priceManuallyChanged, false);
        assert.equal(legacy.discountPercent, null);
        assert.deepEqual(editor.priceGroupStockSettings, data.priceGroupStockSettings);
        const publicWhileInactive = await getPublicWholesalePriceList(data.token);
        assert.ok(publicWhileInactive);
        assert.equal(publicWhileInactive.categories.flatMap((category) => category.products).length, 0);
        const removals = await query<{ metadata: { removed: number; from: number; to: number } }>(`select metadata
          from wholesale_analytics_events where price_list_id=$1 and event_type='price_items_removed'`, [testPriceId]);
        assert.equal(removals.rows.length, 1);
        assert.equal(removals.rows[0].metadata.removed, 1, 'only the explicit visibility change counts as removal');
        assert.equal(removals.rows[0].metadata.from, 4);
        assert.equal(removals.rows[0].metadata.to, 3);
      } finally {
        await query('update wholesale_products set is_active=true where id in ($1,$2)', [rows[1].productId, rows[4].productId]);
        await query('update wholesale_product_variants set is_active=true where id=$1', [rows[2].variantId]);
      }
      const publicAfterReactivation = await getPublicWholesalePriceList(data.token);
      assert.ok(publicAfterReactivation);
      const restored = publicAfterReactivation.categories.flatMap((category) => category.products);
      assert.deepEqual(restored.map((product) => product.id), [rows[1].productId, rows[4].productId, rows[2].productId]);
      assert.deepEqual(restored.map((product) => product.variants[0].wholesalePrice), ['123.45', '78.90', '150.00']);
      assert.deepEqual(await retainedRows(), before);
    });

    await t.test('invalid product in the final batch rolls back header/items/groups/events on update', async () => {
      const before = await stableState(priceId);
      const rows = makeItems(20001);
      rows[20000].productId = 2_000_000_000;
      rows[20000].variantId = null;
      await assert.rejects(updateWholesalePriceList(priceId, { ...savedInput, title: 'MUST ROLLBACK', items: rows,
        priceGroupStockSettings: [] }, admin));
      assert.deepEqual(await stableState(priceId), before);
    });

    await t.test('a variant belonging to another product cannot silently drop the late item', async () => {
      const before = await stableState(priceId);
      const rows = makeItems(20001);
      rows[20000].variantId = variantByProduct.get(productIds[7474])!;
      await assert.rejects(updateWholesalePriceList(priceId, { ...savedInput, title: 'MISMATCH MUST ROLLBACK', items: rows }, admin));
      assert.deepEqual(await stableState(priceId), before);
    });

    await t.test('duplicate logical product/variant keys across batches fail without replacing the old price', async () => {
      const before = await stableState(priceId);
      const rows = [...makeItems(20001), { ...makeItems(1)[0], sortOrder: 20002 }];
      await assert.rejects(updateWholesalePriceList(priceId, { ...savedInput, title: 'DUPLICATE MUST ROLLBACK', items: rows }, admin));
      assert.deepEqual(await stableState(priceId), before);
    });

    await t.test('failed create leaves no partial header, items or events after a late invalid reference', async () => {
      const totals = () => query(`select (select count(*)::text from wholesale_price_lists) as prices,
        (select count(*)::text from wholesale_price_list_items) as items,
        (select count(*)::text from wholesale_price_list_events) as events`);
      const before = (await totals()).rows[0];
      const rows = makeItems(7475);
      rows[7474].productId = 2_000_000_000;
      rows[7474].variantId = null;
      await assert.rejects(createWholesalePriceList(input(rows, 'FAILED CREATE'), admin));
      assert.deepEqual((await totals()).rows[0], before);
    });

    await t.test('scope-denied manager update fails and cannot mutate someone else’s complete price', async () => {
      const before = await stableState(priceId);
      const outsider: AdminSession = { role: 'manager', managerId: otherManagerId };
      assert.equal(await getWholesalePriceListEditor(priceId, outsider), null);
      await assert.rejects(updateWholesalePriceList(priceId, { ...savedInput, title: 'FORBIDDEN', items: makeItems(1) }, outsider));
      assert.deepEqual(await stableState(priceId), before);
    });

    await t.test('concurrent updates serialize overlapping keys without deleting rows omitted by a partial payload', async () => {
      const first = { ...savedInput, title: 'Concurrent A', items: makeItems(7475).map((row) => ({ ...row, visible: true })) };
      const second = { ...savedInput, title: 'Concurrent B', items: makeItems(20001).map((row) => ({ ...row, visible: false })) };
      await Promise.all([updateWholesalePriceList(priceId, first, admin), updateWholesalePriceList(priceId, second, admin)]);
      const editor = await getWholesalePriceListEditor(priceId, admin);
      assert.ok(editor);
      assert.ok(['Concurrent A', 'Concurrent B'].includes(editor.title));
      const expected = editor.title === first.title
        ? [...first.items, ...second.items.slice(first.items.length)] : second.items;
      assert.deepEqual(editor.items, canonical(expected));
      assert.equal(editor.items.length, 20001, 'the shorter update cannot delete the other stored keys');
    });

    await t.test('wrong, missing and inactive manager assignments reject create/update without any partial price', async () => {
      const beforePrice = await stableState(priceId), beforeCompany = await companyState(), beforeTotals = await totals();
      const rejectBoth = async (changes: Partial<SaveInput>) => {
        await assert.rejects(createWholesalePriceList({ ...input(makeItems(1)), ...changes }, admin));
        await assert.rejects(updateWholesalePriceList(priceId, { ...savedInput, title: 'MUST NOT CHANGE', ...changes }, admin));
        assert.deepEqual(await stableState(priceId), beforePrice);
        assert.deepEqual(await companyState(), beforeCompany);
        assert.deepEqual(await totals(), beforeTotals);
      };
      await rejectBoth({ managerId: supportManagerId });
      await rejectBoth({ supportManagerId: managerId });
      await rejectBoth({ managerId: 2_000_000_000 });
      await rejectBoth({ managerId: null });
      await rejectBoth({ supportManagerId: null });
      for (const id of [managerId, supportManagerId]) {
        await query('update wholesale_managers set is_active=false where id=$1', [id]);
        try { await rejectBoth({}); }
        finally { await query('update wholesale_managers set is_active=true where id=$1', [id]); }
      }
    });

    await t.test('missing/inactive/inaccessible companies fail before changing prices or assignments', async () => {
      const beforePrice = await stableState(priceId), beforeTotals = await totals();
      for (const id of [null, 2_000_000_000]) {
        await assert.rejects(createWholesalePriceList({ ...input(makeItems(1)), clientCompanyId: id }, admin));
        await assert.rejects(updateWholesalePriceList(priceId, { ...savedInput, clientCompanyId: id }, admin));
      }
      await query('update client_companies set is_active=false where id=$1', [companyId]);
      try {
        await assert.rejects(createWholesalePriceList(input(makeItems(1)), admin));
        await assert.rejects(updateWholesalePriceList(priceId, savedInput, admin));
      } finally { await query('update client_companies set is_active=true where id=$1', [companyId]); }
      await assert.rejects(createWholesalePriceList(input(makeItems(1)), { role: 'manager', managerId: otherManagerId }));
      assert.deepEqual(await stableState(priceId), beforePrice);
      assert.deepEqual(await totals(), beforeTotals);
    });

    await t.test('late company assignment write failure rolls back price header/items/events on POST and PUT', async () => {
      const beforePrice = await stableState(priceId), beforeCompany = await companyState(), beforeTotals = await totals();
      await query(`create function synthetic_reject_assignment() returns trigger language plpgsql as
        $$ begin raise exception 'Synthetic assignment write failure'; end $$`);
      await query(`create trigger synthetic_reject_assignment before update on client_companies
        for each row execute function synthetic_reject_assignment()`);
      try {
        // Run twice: retrying a failed create cannot leave a partial duplicate.
        for (let i=0; i<2; i++) await assert.rejects(createWholesalePriceList(input(makeItems(2)), admin));
        await assert.rejects(updateWholesalePriceList(priceId, { ...savedInput, title: 'ROLL BACK LATE ASSIGNMENT', items: makeItems(2) }, admin));
      } finally {
        await query('drop trigger synthetic_reject_assignment on client_companies');
        await query('drop function synthetic_reject_assignment()');
      }
      assert.deepEqual(await stableState(priceId), beforePrice);
      assert.deepEqual(await companyState(), beforeCompany);
      assert.deepEqual(await totals(), beforeTotals);
    });

    await t.test('a concurrently disabled manager is revalidated after waiting, not accepted from an old read', async () => {
      const beforePrice = await stableState(priceId), beforeCompany = await companyState();
      const blocker = new Client({ connectionString: process.env.DATABASE_URL });
      await blocker.connect();
      try {
        await blocker.query('begin');
        await blocker.query('update wholesale_managers set is_active=false where id=$1', [managerId]);
        const saving = assert.rejects(updateWholesalePriceList(priceId, savedInput, admin), /Менеджер по развитию/);
        try { await waitForLock('select id::text, role, is_active from wholesale_managers'); }
        finally { await blocker.query('commit'); }
        await saving;
      } finally {
        await blocker.end();
        await query('update wholesale_managers set is_active=true where id=$1', [managerId]);
      }
      assert.deepEqual(await stableState(priceId), beforePrice);
      assert.deepEqual(await companyState(), beforeCompany);
    });

    await t.test('company access revoked during save is rechecked under its lock', async () => {
      const beforePrice = await stableState(priceId);
      const blocker = new Client({ connectionString: process.env.DATABASE_URL });
      await blocker.connect();
      try {
        await blocker.query('begin');
        await blocker.query('update client_companies set manager_id=$2 where id=$1', [companyId, otherManagerId]);
        const saving = assert.rejects(updateWholesalePriceList(priceId, savedInput, { role: 'manager', managerId }), /Клиент/);
        try { await waitForLock('select id::text, title from client_companies'); }
        finally { await blocker.query('commit'); }
        await saving;
        assert.equal((await query('select manager_id::text from client_companies where id=$1', [companyId])).rows[0].manager_id, String(otherManagerId));
      } finally {
        await blocker.end();
        await query('update client_companies set manager_id=$2 where id=$1', [companyId, managerId]);
      }
      assert.deepEqual(await stableState(priceId), beforePrice);
    });

    await t.test('successful saves commit both assignments and leave all other existing price lists intact', async () => {
      const priorPrices = await query('select id::text from wholesale_price_lists order by id');
      const priorStates = await Promise.all(priorPrices.rows.map((row) => stableState(Number(row.id))));
      const newInput = { ...input(makeItems(2), 'Atomic company assignment'), managerId: otherManagerId };
      const newId = await createWholesalePriceList(newInput, admin);
      assert.equal((await getWholesalePriceListEditor(newId, admin))!.managerId, otherManagerId);
      assert.equal((await query('select manager_id::text from client_companies where id=$1', [companyId])).rows[0].manager_id, String(otherManagerId));
      await updateWholesalePriceList(newId, { ...newInput, managerId }, admin);
      assert.equal((await getWholesalePriceListEditor(newId, admin))!.managerId, managerId);
      assert.equal((await query('select manager_id::text from client_companies where id=$1', [companyId])).rows[0].manager_id, String(managerId));
      assert.deepEqual(await Promise.all(priorPrices.rows.map((row) => stableState(Number(row.id)))), priorStates);
    });
  } finally {
    await globalThis.__ktsPgPool?.end();
    globalThis.__ktsPgPool = undefined;
  }
});
