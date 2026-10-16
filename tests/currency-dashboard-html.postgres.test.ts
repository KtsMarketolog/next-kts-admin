import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { applyCurrencyDashboardHtmlMigration } from '../src/shared/lib/db/currencyDashboardHtmlMigration';
import { applyCurrencyDashboardMigration } from '../src/shared/lib/db/currencyDashboardMigration';
import { markSiteSchemaReady } from '../src/shared/lib/db/schema';
import { readCurrencySnapshot, rollbackCurrencySnapshot, writeCurrencySnapshot } from '../src/shared/lib/db/currencyDashboardRepo';
import {
  CurrencyHtmlConflictError, CurrencyHtmlError, createCurrencyDashboardHtmlVersion, ensureCurrencyDashboardHtmlSeed,
  getCurrencyDashboardHtmlState, getCurrencyDashboardHtmlVersion, getPublishedCurrencyDashboardHtml,
  publishCurrencyDashboardHtmlVersion, rollbackCurrencyDashboardHtmlVersion,
} from '../src/shared/lib/db/currencyDashboardHtmlRepo';

const testUrl = process.env.KTS_CURRENCY_HTML_TEST_DATABASE_URL;
const enabled = process.env.KTS_CURRENCY_HTML_POSTGRES_TEST === '1' && Boolean(testUrl);
test('currency HTML PostgreSQL migration, drafts, CAS, rollback and isolation', { skip: !enabled }, async (t) => {
  const url = new URL(testUrl!);
  assert.equal(url.pathname, '/kts_currency_html_integration');
  assert.equal(url.hostname, 'localhost');
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-currency-html-postgres\.[^/]+\/socket$/);
  process.env.DATABASE_URL = testUrl;
  const pool = new Pool({ connectionString: testUrl });
  const legacy = { htmlContent: '<!doctype html><title>V21 legacy</title>', originalName: 'builtin-v21.html', sourceVersion: 'V21' };
  const current = { htmlContent: '<!doctype html><title>V25 current</title>', originalName: 'builtin-v25.html', sourceVersion: 'V25' };
  const next = { htmlContent: '<!doctype html><title>V26 next</title>', originalName: 'uploaded-v26.html', sourceVersion: 'V26', actor: 'admin:1' };
  try {
    const client = await pool.connect();
    try {
      await applyCurrencyDashboardMigration(client);
      await client.query("update currency_dashboard_state set revision=9,current_snapshot='{\"saved\":true}',previous_snapshot='{\"previous\":true}' where id=1");
      await client.query("insert into currency_dashboard_cache(key,value,fetched_at) values('cbr:history','{\"history\":true}',now())");
      await applyCurrencyDashboardHtmlMigration(client);
    } finally { client.release(); }
    markSiteSchemaReady();
    const originalCurrency = (await pool.query('select * from currency_dashboard_state')).rows;
    const originalCache = (await pool.query('select * from currency_dashboard_cache')).rows;
    await t.test('concurrent seed preserves builtin V21 rollback and never replaces initialized publication', async () => {
      await Promise.all([1, 2, 3].map(() => ensureCurrencyDashboardHtmlSeed({ current, previous: legacy })));
      const before = await getCurrencyDashboardHtmlState();
      assert.equal(before.versions.length, 2); assert.equal(before.revision, 1);
      assert.equal((await getPublishedCurrencyDashboardHtml())!.htmlContent, current.htmlContent);
      assert.equal((await getCurrencyDashboardHtmlVersion(before.previousVersionId!))!.htmlContent, legacy.htmlContent);
      await ensureCurrencyDashboardHtmlSeed({ current: next });
      assert.deepEqual(await getCurrencyDashboardHtmlState(), before);
    });
    await t.test('upload only stages immutable bytes and duplicate retries reuse the same version', async () => {
      const before = await getCurrencyDashboardHtmlState();
      const created = await createCurrencyDashboardHtmlVersion(next);
      assert.equal(created.activeVersionId, before.activeVersionId); assert.equal(created.revision, before.revision);
      assert.equal((await getCurrencyDashboardHtmlVersion(created.version.id))!.htmlContent, next.htmlContent);
      const duplicate = await createCurrencyDashboardHtmlVersion({ ...next, originalName: 'renamed.html' });
      assert.equal(duplicate.version.id, created.version.id);
      assert.equal(duplicate.version.originalName, next.originalName);
      assert.equal(duplicate.versions.length, 3);
    });
    await t.test('simultaneous publishers serialize with one winner, preserve previous, reject stale clients', async () => {
      const before = await getCurrencyDashboardHtmlState();
      const draft = before.versions.find((item) => item.sourceVersion === 'V26')!;
      const attempts = await Promise.allSettled([1, 2, 3].map(() => publishCurrencyDashboardHtmlVersion(draft.id, before.revision, 'admin:1')));
      assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
      for (const result of attempts) if (result.status === 'rejected') assert.ok(result.reason instanceof CurrencyHtmlConflictError);
      const after = await getCurrencyDashboardHtmlState();
      assert.equal(after.activeVersionId, draft.id); assert.equal(after.previousVersionId, before.activeVersionId); assert.equal(after.revision, before.revision + 1);
      assert.deepEqual(await publishCurrencyDashboardHtmlVersion(draft.id, after.revision, 'admin:1'), after);
    });
    await t.test('rollback is an atomic new revision with displaced version preserved', async () => {
      const before = await getCurrencyDashboardHtmlState();
      const after = await rollbackCurrencyDashboardHtmlVersion(before.revision, 'admintop:2');
      assert.equal(after.activeVersionId, before.previousVersionId); assert.equal(after.previousVersionId, before.activeVersionId);
      assert.equal(after.revision, before.revision + 1);
      await assert.rejects(rollbackCurrencyDashboardHtmlVersion(before.revision, 'admin:1'), CurrencyHtmlConflictError);
      assert.deepEqual(await getCurrencyDashboardHtmlState(), after);
    });
    await t.test('validation, size limit and corrupt drafts cannot change publication', async () => {
      const before = await getCurrencyDashboardHtmlState();
      for (const input of [{ ...next, htmlContent: '' }, { ...next, htmlContent: 'x'.repeat(2 * 1024 * 1024 + 1) }, { ...next, originalName: '../bad.html' }]) {
        await assert.rejects(createCurrencyDashboardHtmlVersion(input), CurrencyHtmlError);
      }
      const damaged = await createCurrencyDashboardHtmlVersion({ ...next, htmlContent: 'immutable-check', originalName: 'damaged.html' });
      await pool.query('update currency_dashboard_html_versions set html_content=$2,file_size=octet_length($2::text) where id=$1', [damaged.version.id, 'changed-by-external-database-write']);
      await assert.rejects(publishCurrencyDashboardHtmlVersion(damaged.version.id, before.revision, 'admin:1'), { code: 'CURRENCY_HTML_INTEGRITY' });
      await assert.rejects(getCurrencyDashboardHtmlVersion(damaged.version.id), { code: 'CURRENCY_HTML_INTEGRITY' });
      assert.equal((await getCurrencyDashboardHtmlState()).activeVersionId, before.activeVersionId);
      assert.equal((await getCurrencyDashboardHtmlState()).revision, before.revision);
    });
    await t.test('foreign keys block deleting active releases and HTML operations never touch currency data/history', async () => {
      const state = await getCurrencyDashboardHtmlState();
      await assert.rejects(pool.query('delete from currency_dashboard_html_versions where id=$1', [state.activeVersionId]),
        (error: unknown) => ['23503', '23001'].includes((error as { code?: string }).code ?? ''));
      assert.deepEqual((await pool.query('select * from currency_dashboard_state')).rows, originalCurrency);
      assert.deepEqual((await pool.query('select * from currency_dashboard_cache')).rows, originalCache);
    });
    await t.test('an already open V21 client preserves V25/future shared fields, while explicit data rollback is exact', async () => {
      const first = await writeCurrencySnapshot({ at: '2026-10-16T10:00:00.000Z', version: 'V25', data: {
        kts_weights: { '2026': { USD: 30, EUR: 30, CNY: 30, KZT: 0, rev: 100 } },
        kts_f27: { upd: '16.10.2026', rows: ['Тест | 16.10.2026 | 90 | 95 | 12 | 10'] },
        kts_future: { nested: ['original'] },
      } }, 9, 'admin:1');
      const older = await writeCurrencySnapshot({ at: '2026-10-16T10:00:00.000Z', version: 'V21', data: {
        kts_an: { upd: '16.10.2026', rows: ['Тест | 90 | 13 | 2027 | 16.10.2026'] },
      } }, first.revision, 'admin:2');
      assert.deepEqual(older.current!.data.kts_weights, first.current!.data.kts_weights);
      assert.deepEqual(older.current!.data.kts_f27, first.current!.data.kts_f27);
      assert.deepEqual(older.current!.data.kts_future, first.current!.data.kts_future);
      const changed = await writeCurrencySnapshot({ at: '2026-10-16T10:00:00.000Z', version: 'V25', data: {
        kts_future: { nested: ['replacement'] },
      } }, older.revision, 'admin:1');
      assert.deepEqual(changed.current!.data.kts_future, { nested: ['replacement'] });
      assert.equal(changed.current!.data.kts_an, undefined);
      const reverted = await rollbackCurrencySnapshot(changed.revision, 'admin:1');
      assert.deepEqual(reverted.current!.data, older.current!.data);
      assert.deepEqual((await readCurrencySnapshot()).current!.data, older.current!.data);
    });
  } finally {
    await pool.end(); await globalThis.__ktsPgPool?.end(); globalThis.__ktsPgPool = undefined;
  }
});
