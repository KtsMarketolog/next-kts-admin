/** Synthetic acceptance only. Run via scripts/test-atomic-saves-postgres.sh. */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';

import type { AdminSession } from '../src/shared/lib/adminAuth';
import { query, withTransaction } from '../src/shared/lib/db/client';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import { createClientCompany, updateClientCompany } from '../src/shared/lib/db/clientCompaniesRepo';
import type { ClientCompanyInput } from '../src/shared/lib/db/clientCompanyTypes';
import { createStoredClientSession, getStoredClientSession } from '../src/shared/lib/db/clientSessionsRepo';
import { ensureCatalogSchema } from '../src/entities/catalog/api/catalogDb';
import { getStockImportLogs, importStockFromExcelBuffer } from '../src/entities/catalog/api/stockImport';

function guard() {
  assert.equal(process.env.KTS_ATOMIC_SAVES_TEST, '1', 'Explicit isolated integration flag is required');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_atomic_integration');
  assert.equal(url.username, 'atomic_app');
  assert.equal(url.password, '', 'Test role has no application credentials');
  for (const [key] of url.searchParams) assert.ok(['host', 'port'].includes(key));
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-atomic-postgres\.[A-Za-z0-9]+\/socket$/);
  assert.equal(url.searchParams.get('port'), '55479');
}

function workbook(rows: unknown[][]) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Synthetic');
  return Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
}

const admin: AdminSession = { role: 'admin' };
type FaultTable = 'wholesale_price_lists' | 'client_sessions' | 'stock_import_logs' | 'wholesale_products' | 'stock_import_mail_receipts';

async function withWriteFault(table: FaultTable, operation: 'insert' | 'update', run: () => Promise<void>) {
  // Table and operation are fixed test literals, never application input.
  await query(`create function synthetic_atomic_fail() returns trigger language plpgsql as $$
    begin raise exception 'synthetic atomic-save failure'; end $$`);
  await query(`create trigger synthetic_atomic_fault before ${operation} on ${table}
    for each row execute function synthetic_atomic_fail()`);
  try {
    await run();
  } finally {
    await query(`drop trigger synthetic_atomic_fault on ${table}`);
    await query('drop function synthetic_atomic_fail()');
  }
}

test('client and stock business saves are atomic in isolated PostgreSQL', { timeout: 180_000 }, async (t) => {
  guard();
  try {
    const existing = await query<{ present: string | null }>(`select to_regclass('public.client_companies')::text as present`);
    assert.equal(existing.rows[0].present, null, 'Refuse any pre-existing application schema');
    await ensureSiteSchema();
    await ensureCatalogSchema();
    await getStockImportLogs();
    const role = await query('select rolsuper,rolcreatedb,rolcreaterole from pg_roles where rolname=current_user');
    assert.deepEqual(role.rows[0], { rolsuper: false, rolcreatedb: false, rolcreaterole: false });

    const managers = await query<{ id: string }>(`insert into wholesale_managers (login,name,email,role)
      values ('atomic-first','Synthetic Manager A','atomic-a@example.test','manager'),
      ('atomic-second','Synthetic Manager B','atomic-b@example.test','manager'),
      ('atomic-support-a','Synthetic Support A','atomic-sa@example.test','support_manager'),
      ('atomic-support-b','Synthetic Support B','atomic-sb@example.test','support_manager') returning id::text`);
    const [managerA, managerB, supportA, supportB] = managers.rows.map((row) => Number(row.id));
    const originalInput: ClientCompanyInput = {
      title: 'Synthetic atomic client', inn: '', kpp: '', contactName: '', email: 'atomic-client@example.test',
      phone: '+0 synthetic', address: '', note: 'Original note', managerId: managerA, supportManagerId: supportA,
      requireTwoFactor: false, isActive: true, passwordHash: 'synthetic-old-hash', displayPassword: 'synthetic-old-password',
    };
    const company = await createClientCompany(originalInput, admin);
    assert.ok(company.clientUserId);
    await query(`update client_users set password_changed_at='2000-01-01' where id=$1`, [company.clientUserId]);
    const session = await createStoredClientSession({ clientUserId: company.clientUserId });
    await query(`update client_sessions set created_at='2001-01-01' where id=$1`, [session.sessionId]);
    assert.ok(await getStoredClientSession(session.token));
    const catalog = await query<{ id: string }>(`insert into catalog_products
      (slug,title,article,stock,stock_volzhsk,stock_moscow,is_expected,unit)
      values ('atomic-good','Synthetic good stock','GOOD-SKU',90,40,50,false,'old-good-unit'),
      ('atomic-bad','Synthetic invalid stock','BAD-SKU',30,10,20,true,'old-bad-unit') returning id::text`);
    const [goodProductId, badProductId] = catalog.rows.map((row) => Number(row.id));
    const products = await query<{ id: string }>(`insert into wholesale_products
      (catalog_product_id,title,sku,stock,stock_volzhsk,stock_moscow,is_expected,unit,wholesale_price)
      select id,title,article,stock,stock_volzhsk,stock_moscow,is_expected,unit,100 from catalog_products order by id returning id::text`);
    const price = await query<{ id: string }>(`insert into wholesale_price_lists
      (title,client_company_id,client_name,manager_id,support_manager_id,token,comment)
      values ('Synthetic durable price',$1,$2,$3,$4,'synthetic-atomic-price','Preserve this price') returning id::text`,
    [company.id, company.title, managerA, supportA]);
    const priceId = Number(price.rows[0].id);
    await query(`insert into wholesale_price_list_items
      (price_list_id,wholesale_product_id,custom_wholesale_price,discount_percent,price_manually_changed,visible,snapshot_product_title)
      values ($1,$2,123.45,7.50,true,true,'Synthetic preserved snapshot')`, [priceId, Number(products.rows[0].id)]);

    const clientState = async () => (await query(`select
      (select row_to_json(c.*) from client_companies c where id=$1) as company,
      (select json_agg(u order by u.id) from client_users u where company_id=$1) as users,
      (select json_agg(s order by s.id) from client_sessions s where client_user_id=$2) as sessions,
      (select json_agg(p order by p.id) from wholesale_price_lists p where client_company_id=$1) as prices,
      (select json_agg(i order by i.id) from wholesale_price_list_items i where price_list_id=$3) as items`,
    [company.id, company.clientUserId, priceId])).rows[0];
    const proposed: ClientCompanyInput = {
      ...originalInput, title: 'Synthetic changed client', note: 'Changed note', phone: '+1 synthetic',
      managerId: managerB, supportManagerId: supportB, passwordHash: 'synthetic-new-hash', displayPassword: 'synthetic-new-password',
    };

    await t.test('price assignment failure rolls back company, password, sessions and every price field', async () => {
      const before = await clientState();
      await withWriteFault('wholesale_price_lists', 'update', async () => {
        await assert.rejects(updateClientCompany(company.id, proposed, admin));
      });
      assert.deepEqual(await clientState(), before);
      assert.ok(await getStoredClientSession(session.token), 'An uncommitted password change cannot invalidate the old session');
    });

    await t.test('session revocation failure rolls back the whole client save, including price assignments', async () => {
      const before = await clientState();
      await withWriteFault('client_sessions', 'update', async () => {
        await assert.rejects(updateClientCompany(company.id, proposed, admin));
      });
      assert.deepEqual(await clientState(), before);
      assert.ok(await getStoredClientSession(session.token));
    });

    await t.test('unrelated employee is denied without changing client data', async () => {
      const before = await clientState();
      await assert.rejects(updateClientCompany(company.id, proposed, { role: 'manager', managerId: managerB }));
      assert.deepEqual(await clientState(), before);
    });

    await t.test('successful client save commits assignments and password without touching prices or positions', async () => {
      const before = await clientState();
      const saved = await updateClientCompany(company.id, proposed, admin);
      assert.equal(saved.title, proposed.title);
      assert.equal(saved.managerId, managerB);
      assert.equal(saved.supportManagerId, supportB);
      const after = await clientState();
      assert.equal(after.company.note, proposed.note);
      assert.equal(after.users[0].password_hash, proposed.passwordHash);
      assert.equal(after.users[0].display_password, proposed.displayPassword);
      assert.ok(after.sessions.every((row: { revoked_at: string | null }) => row.revoked_at));
      assert.equal(after.prices[0].manager_id, managerB);
      assert.equal(after.prices[0].support_manager_id, supportB);
      assert.ok(BigInt(after.prices[0].revision) > BigInt(before.prices[0].revision));
      assert.deepEqual(after.items, before.items, 'Item IDs, negotiated prices and saved snapshots must be unchanged');
      for (const key of ['id', 'title', 'token', 'comment', 'client_company_id', 'is_active']) {
        assert.equal(after.prices[0][key], before.prices[0][key], `Price field ${key} must survive`);
      }
      assert.equal(await getStoredClientSession(session.token), null);
    });

    await t.test('password-change date independently blocks an old session even if its revoked marker is absent', async () => {
      await query('update client_sessions set revoked_at=null where id=$1', [session.sessionId]);
      assert.equal(await getStoredClientSession(session.token), null);
      const old = await query('select revoked_at from client_sessions where id=$1', [session.sessionId]);
      assert.ok(old.rows[0].revoked_at);
      const fresh = await createStoredClientSession({ clientUserId: company.clientUserId! });
      assert.ok(await getStoredClientSession(fresh.token));
    });

    await t.test('comment-only client save keeps unchanged price revisions and active sessions', async () => {
      const before = await clientState();
      await updateClientCompany(company.id, { ...proposed, note: 'Comment-only edit', passwordHash: undefined, displayPassword: undefined }, admin);
      const after = await clientState();
      assert.deepEqual(after.prices, before.prices);
      assert.deepEqual(after.items, before.items);
      assert.deepEqual(after.sessions, before.sessions);
      assert.equal(after.users[0].password_changed_at, before.users[0].password_changed_at);
    });

    const stockState = async () => (await query(`select
      (select json_agg(c order by c.id) from catalog_products c) as catalog,
      (select json_agg(p order by p.id) from wholesale_products p) as wholesale,
      (select coalesce(json_agg(l order by l.id),'[]'::json) from stock_import_logs l) as logs,
      (select coalesce(json_agg(r order by r.receipt_key),'[]'::json) from stock_import_mail_receipts r) as receipts,
      (select json_agg(p order by p.id) from wholesale_price_lists p) as prices,
      (select json_agg(i order by i.id) from wholesale_price_list_items i) as items`)).rows[0];
    const runStock = (rows: unknown[][], fileName = 'Synthetic.xlsx') => importStockFromExcelBuffer({ buffer: workbook(rows), fileName });
    const validRows: unknown[][] = [['Артикул', 'Сейчас', 'Ед. изм.'], ['GOOD-SKU', 11, 'new-good-unit'], ['BAD-SKU', 22, 'new-bad-unit']];
    const assertImportReleased = async () => {
      const locks = await query(`select count(*)::int as n from stock_import_locks`);
      assert.equal(locks.rows[0].n, 0);
      await withTransaction(async (client) => {
        const lock = await client.query<{ acquired: boolean }>(`select pg_try_advisory_xact_lock(hashtext('kts-stock-import')) as acquired`);
        assert.equal(lock.rows[0].acquired, true);
      });
    };

    await t.test('result-log failure rolls back catalog and wholesale inventory and leaves no success log', async () => {
      const before = await stockState();
      await withWriteFault('stock_import_logs', 'insert', async () => {
        await assert.rejects(runStock(validRows));
      });
      assert.deepEqual(await stockState(), before);
      await assertImportReleased();
    });

    await t.test('wholesale inventory failure also rolls back the preceding catalog updates', async () => {
      const before = await stockState();
      await withWriteFault('wholesale_products', 'update', async () => {
        await assert.rejects(runStock(validRows));
      });
      assert.deepEqual(await stockState(), before);
      await assertImportReleased();
    });

    await t.test('successful retry commits matching stock and result log without deleting prices', async () => {
      const before = await stockState();
      const result = await runStock(validRows, 'Synthetic-success.xlsx');
      assert.equal(result.status, 'success');
      assert.equal(result.updatedRows, 2);
      assert.ok(result.logId);
      const after = await stockState();
      assert.deepEqual(after.catalog.map((row: { stock: number }) => row.stock), [11, 22]);
      assert.deepEqual(after.wholesale.map((row: { stock: number }) => row.stock), [11, 22]);
      const log = after.logs.find((row: { id: number }) => Number(row.id) === result.logId);
      assert.equal(log.status, result.status);
      assert.equal(log.updated_rows, result.updatedRows);
      assert.equal(log.file_name, result.fileName);
      assert.deepEqual(after.prices, before.prices);
      assert.deepEqual(after.items, before.items);
      await assertImportReleased();
    });

    const partialRows: unknown[][] = [
      ['1Основной склад Волжск'], ['Артикул', 'Сейчас'], ['BAD-SKU', 5], ['GOOD-SKU', 8],
      ['ЛДМ 2'], ['Артикул', 'Сейчас'], ['bad-sku', 'invalid'], ['GOOD-SKU', 2], ['MISSING-SKU', 3],
    ];
    await t.test('partial-success log failure rolls back valid rows too', async () => {
      const before = await stockState();
      await withWriteFault('stock_import_logs', 'insert', async () => {
        await assert.rejects(runStock(partialRows));
      });
      assert.deepEqual(await stockState(), before);
      await assertImportReleased();
    });

    await t.test('partial import preserves the entire invalid SKU and records exactly the committed valid rows', async () => {
      const before = await stockState();
      const result = await runStock(partialRows, 'Synthetic-partial.xlsx');
      assert.equal(result.status, 'partial_success');
      assert.equal(result.updatedRows, 1);
      assert.equal(result.failedRows, 1);
      assert.equal(result.notFoundRows, 1);
      const after = await stockState();
      const badBefore = before.catalog.find((row: { id: number }) => Number(row.id) === badProductId);
      const badAfter = after.catalog.find((row: { id: number }) => Number(row.id) === badProductId);
      assert.deepEqual(badAfter, badBefore);
      assert.deepEqual(after.wholesale[1], before.wholesale[1]);
      const good = after.catalog.find((row: { id: number }) => Number(row.id) === goodProductId);
      assert.equal(good.stock, 10);
      assert.equal(good.stock_volzhsk, 8);
      assert.equal(good.stock_moscow, 2);
      const log = after.logs.find((row: { id: number }) => Number(row.id) === result.logId);
      assert.equal(log.status, result.status);
      assert.equal(log.updated_rows, 1);
      assert.equal(log.failed_rows, 1);
      assert.equal(log.not_found_rows, 1);
      assert.deepEqual(log.errors_json, result.errors);
      assert.deepEqual(after.prices, before.prices);
      assert.deepEqual(after.items, before.items);
    });

    await t.test('mail receipt failure rolls back inventory and its success log together', async () => {
      const before = await stockState();
      await withWriteFault('stock_import_mail_receipts', 'insert', async () => {
        await assert.rejects(importStockFromExcelBuffer({
          buffer: workbook(validRows), fileName: 'Synthetic-mail.xlsx', mailReceiptKeys: ['synthetic-mail-receipt'],
        }));
      });
      assert.deepEqual(await stockState(), before);
      await assertImportReleased();
    });

    await t.test('retrying a committed mail receipt does not reapply an old snapshot over newer stock', async () => {
      const mailInput = { buffer: workbook(validRows), fileName: 'Synthetic-mail.xlsx', mailReceiptKeys: ['synthetic-mail-receipt'] };
      const original = await importStockFromExcelBuffer(mailInput);
      assert.equal(original.status, 'success');
      await runStock([['Артикул', 'Сейчас'], ['GOOD-SKU', 77]], 'Synthetic-newer-manual.xlsx');
      const beforeRetry = await stockState();
      const repeated = await importStockFromExcelBuffer(mailInput);
      assert.equal(repeated.logId, original.logId);
      assert.equal(repeated.alreadyApplied, true);
      assert.deepEqual(await stockState(), beforeRetry);
      await assertImportReleased();
    });

    await t.test('a failed newest mail does not mark older valid workbooks as already processed', async () => {
      const failedInput = {
        buffer: workbook([['Артикул', 'Сейчас'], ['BAD-SKU', 'invalid']]),
        fileName: 'Synthetic-invalid-mail.xlsx', mailReceiptKeys: ['failed-primary', 'older-valid'],
      };
      const failed = await importStockFromExcelBuffer(failedInput);
      assert.equal(failed.status, 'failed');
      const repeated = await importStockFromExcelBuffer({ ...failedInput, mailReceiptKeys: ['failed-primary', 'another-older-valid'] });
      assert.equal(repeated.alreadyApplied, true);
      const older = await query(`select receipt_key from stock_import_mail_receipts where receipt_key in ('older-valid','another-older-valid')`);
      assert.equal(older.rowCount, 0, 'Unapplied older mail remains retryable after the newest workbook failed');
      const next = await importStockFromExcelBuffer({
        buffer: workbook([['Артикул', 'Сейчас'], ['GOOD-SKU', 33]]),
        fileName: 'Synthetic-older-valid.xlsx', mailReceiptKeys: ['older-valid'],
      });
      assert.equal(next.status, 'success');
      assert.equal(next.updatedRows, 1);
      assert.notEqual(next.logId, failed.logId);
      assert.equal((await query('select stock from catalog_products where id=$1', [goodProductId])).rows[0].stock, 33);
    });
  } finally {
    await globalThis.__ktsPgPool?.end();
    globalThis.__ktsPgPool = undefined;
  }
});
