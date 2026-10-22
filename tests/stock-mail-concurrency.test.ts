import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as XLSX from 'xlsx';

import type { StockEmailImportResult, StockImportResult } from '../src/entities/catalog/api/stockImportTypes';

const require = createRequire(import.meta.url);
type Importer = {
  importStockFromEmail(): Promise<StockEmailImportResult>;
  importStockFromExcelBuffer(input: { buffer: Buffer; fileName: string }): Promise<StockImportResult>;
};
type Stage = 'connect' | 'mailbox' | 'search' | 'fetch' | 'parse' | 'write' | 'log' | 'receipt' | 'move' | 'flags' | 'logout' | 'close';
type Message = { uid: number; buffer: Buffer };

function workbook(quantityHeader = 'Сейчас') {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
    ['Артикул', quantityHeader], ['SYNTHETIC-SKU', 12],
  ]), 'Synthetic');
  return Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
}

function gate() {
  let enter!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const resumed = new Promise<void>((resolve) => { resume = resolve; });
  return { entered, resume, async wait() { enter(); await resumed; } };
}

let compiledImporter: Promise<string> | undefined;
async function harness(options: { fail?: Stage | 'constructor' | 'mailbox-release'; legacyBusy?: boolean; messages?: Message[]; failMoveAndFlags?: boolean; commitUnknownOnce?: boolean } = {}) {
  delete globalThis.__ktsStockImportSchemaReady;
  // Bundle only in memory. DB and mail dependencies are replaced at resolution,
  // not through environment credentials; the fixture cannot open a real socket.
  compiledImporter ??= build({
    entryPoints: [fileURLToPath(new URL('../src/entities/catalog/api/stockImport.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', logLevel: 'silent',
    define: { 'process.env': JSON.stringify({ STOCK_MAIL_HOST: 'mail.example.invalid', STOCK_MAIL_USER: 'fixture@example.invalid', STOCK_MAIL_PASSWORD: 'synthetic-password' }) },
    plugins: [{
      name: 'isolated-stock-services',
      setup(builder) {
        builder.onResolve({ filter: /^synthetic-stock-mail$/ }, ({ path }) => ({ path, external: true }));
        builder.onResolve({ filter: /^(@\/shared\/lib\/db(?:\/client)?|\.\/catalogDb)$/ }, () => ({ path: 'synthetic-stock-database', external: true }));
        builder.onResolve({ filter: /^(imapflow|mailparser)$/ }, ({ path }) => ({ path, namespace: 'synthetic-mail' }));
        builder.onLoad({ filter: /.*/, namespace: 'synthetic-mail' }, ({ path }) => ({
          contents: path === 'imapflow'
            ? "export const ImapFlow = require('synthetic-stock-mail').ImapFlow;"
            : "export const simpleParser = require('synthetic-stock-mail').simpleParser;",
          loader: 'js',
        }));
      },
    }],
  }).then((result) => result.outputFiles[0].text);
  const events: string[] = [];
  const hooks = new Map<Stage, () => Promise<void>>();
  const messages = new Map((options.messages ?? [{ uid: 101, buffer: workbook() }]).map((message) => [message.uid, message]));
  const moves: Array<{ uid: number; folder: string }> = [];
  const flags: number[] = [];
  const lockNames: string[] = [];
  let sessionHeld = false;
  let legacyHeld = options.legacyBusy === true;
  let legacyExpired = false;
  let sessionReleases = 0;
  let legacyReleases = 0;
  let clients = 0;
  let updates = 0;
  const receipts = new Map<string, number>();
  const logs = new Map<number, StockImportResult>();
  let commitUnknown = options.commitUnknownOnce === true;
  async function step(stage: Stage) {
    events.push(stage);
    await hooks.get(stage)?.();
    if (options.fail === stage || options.failMoveAndFlags && (stage === 'move' || stage === 'flags')) throw new Error(`Synthetic ${stage} failure`);
  }
  const query = async (sql: string, params: unknown[] = []) => {
    assert.doesNotMatch(sql, /\b(?:delete\s+from|update|insert\s+into)\s+wholesale_price_lists\b/i);
    if (sql.includes('from stock_import_mail_receipts receipts')) {
      const logId = receipts.get(String(params[0]));
      return { rowCount: logId ? 1 : 0, rows: logId ? [{ result: logs.get(logId) }] : [] };
    }
    if (/^\s*insert into stock_import_mail_receipts/.test(sql)) {
      await step('receipt');
      for (const key of params[0] as string[]) if (!receipts.has(key)) receipts.set(key, Number(params[1]));
    }
    if (/^\s*insert into stock_import_logs/.test(sql)) {
      await step('log');
      const id = logs.size + 1;
      logs.set(id, { logId: id, fileName: String(params[0]), emailFrom: String(params[1]), emailSubject: String(params[2]), status: params[3] as StockImportResult['status'], totalRows: Number(params[4]), updatedRows: Number(params[5]), notFoundRows: Number(params[6]), failedRows: Number(params[7]), errors: JSON.parse(String(params[8])) });
      return { rowCount: 1, rows: [{ id: String(id) }] };
    }
    if (/^\s*delete from stock_import_locks/.test(sql) && sql.includes('locked_at <')) {
      if (legacyExpired) legacyHeld = false;
    } else if (/^\s*insert into stock_import_locks/.test(sql)) {
      events.push('legacy-acquire');
      assert.equal(params[0], 'email');
      if (legacyHeld) return { rowCount: 0, rows: [] };
      legacyHeld = true;
    } else if (/^\s*delete from stock_import_locks/.test(sql) && !sql.includes('locked_at <')) {
      assert.equal(legacyHeld, true, 'only the owner may release the legacy lock');
      legacyHeld = false;
      legacyReleases += 1;
      events.push('legacy-release');
    } else if (sql.includes('select id::text') && sql.includes('from catalog_products')) {
      return { rowCount: 1, rows: [{ id: '42' }] };
    } else if (/^\s*update catalog_products/.test(sql)) {
      await step('write');
      updates += 1;
    }
    return { rowCount: 1, rows: [{ id: '1' }] };
  };
  const database = {
    query, ensureSiteSchema: async () => {}, ensureCatalogSchema: async () => {},
    withTransaction: async (callback: (client: { query: typeof query }) => Promise<unknown>, txOptions?: { trackCommitOutcome?: boolean; profile?: string }) => {
      const oldUpdates = updates;
      const oldReceipts = [...receipts.entries()];
      const oldLogs = [...logs.entries()];
      let result: unknown;
      try { result = await callback({ query }); }
      catch (error) {
        updates = oldUpdates;
        receipts.clear(); oldReceipts.forEach(([key, id]) => receipts.set(key, id));
        logs.clear(); oldLogs.forEach(([id, log]) => logs.set(id, log));
        throw error;
      }
      if (commitUnknown && txOptions?.trackCommitOutcome && txOptions.profile === 'import') {
        commitUnknown = false;
        throw new Error('Synthetic COMMIT result unknown');
      }
      return result;
    },
    async tryAcquireSessionAdvisoryLock(name: string) {
      lockNames.push(name);
      events.push('session-acquire');
      if (sessionHeld) return null;
      sessionHeld = true;
      return async () => {
        assert.equal(sessionHeld, true, 'lock cannot be released twice or by the loser');
        sessionHeld = false;
        sessionReleases += 1;
        events.push('session-release');
      };
    },
  };
  class ImapFlow {
    mailbox = { uidValidity: BigInt(123) };
    constructor() {
      clients += 1;
      events.push('constructor');
      if (options.fail === 'constructor') throw new Error('Synthetic constructor failure');
    }
    on() { return this; }
    connect() { return step('connect'); }
    async getMailboxLock(folder: string) {
      assert.equal(folder, 'INBOX');
      await step('mailbox');
      return { release() {
        events.push('mailbox-release');
        if (options.fail === 'mailbox-release') throw new Error('Synthetic mailbox release failure');
      } };
    }
    async search() { await step('search'); return [...messages.keys()]; }
    async *fetch() {
      await step('fetch');
      for (const { uid } of messages.values()) yield { uid, source: Buffer.from(String(uid)) };
    }
    async mailboxCreate() { events.push('mailbox-create'); }
    async messageMove(uid: string, folder: string, options: { uid: boolean }) {
      assert.equal(options.uid, true);
      await step('move');
      moves.push({ uid: Number(uid), folder });
      messages.delete(Number(uid));
    }
    async messageFlagsAdd(uid: string) { await step('flags'); flags.push(Number(uid)); }
    logout() { return step('logout'); }
    close() {
      events.push('close');
      if (options.fail === 'close') throw new Error('Synthetic close failure');
    }
  }
  const mail = {
    ImapFlow,
    async simpleParser(source: Buffer) {
      await step('parse');
      const message = messages.get(Number(source.toString()))!;
      return {
        from: { value: [{ address: 'fixture@example.invalid' }] }, subject: 'Synthetic stock',
        date: new Date(1_700_000_000_000 + message.uid),
        attachments: [{ filename: 'Остатки-synthetic.xlsx', content: message.buffer }],
      };
    },
  };
  function loadWorker(code: string): Importer {
    const loaded = { exports: {} as Importer };
    new Function('require', 'module', 'exports', code)((name: string) => {
      if (name === 'synthetic-stock-database') return database;
      if (name === 'synthetic-stock-mail') return mail;
      assert.ok(['xlsx', 'node:crypto'].includes(name), 'no unexpected dependency may reach real infrastructure');
      return require(name);
    }, loaded, loaded.exports);
    return loaded.exports;
  }
  const compiled = await compiledImporter;
  return {
    first: loadWorker(compiled), second: loadWorker(compiled), hooks, events, moves, flags, lockNames, messages, receipts, logs,
    get state() { return { sessionHeld, legacyHeld, sessionReleases, legacyReleases, clients, updates }; },
    expireLegacyRow() { legacyHeld = false; },
    ageLegacyRowPastTtl() { legacyExpired = true; },
  };
}

for (const stage of ['connect', 'fetch', 'parse', 'write', 'move', 'logout'] as const) {
  test(`concurrent stock mail worker safely skips while owner is at ${stage}`, { timeout: 5000 }, async (t) => {
    const h = await harness();
    const hold = gate();
    t.after(hold.resume);
    h.hooks.set(stage, hold.wait);
    const owner = h.first.importStockFromEmail();
    await hold.entered;
    const contender = await h.second.importStockFromEmail();
    assert.equal(contender.status, 'busy');
    assert.equal(contender.processed, 0);
    assert.equal(contender.result, null);
    assert.equal(contender.checkedMessages, 0);
    assert.equal(h.state.clients, 1, 'loser never constructs or connects a mail client');
    assert.equal(h.state.sessionReleases, 0, 'loser never releases owner lock');
    assert.equal(h.moves.some(({ folder }) => folder === 'ImportErrors'), false);
    hold.resume();
    assert.equal((await owner).status, 'completed');
    assert.deepEqual(h.moves, [{ uid: 101, folder: 'Processed' }]);
    assert.deepEqual(h.flags, []);
    assert.equal(h.state.updates, 1);
    assert.deepEqual(h.events.filter((event) => event !== 'session-acquire').slice(-4), ['mailbox-release', 'logout', 'close', 'session-release']);
    assert.equal(h.state.sessionHeld, false);
    assert.equal(h.state.legacyHeld, false);
    assert.equal(h.state.sessionReleases, 1);
    assert.equal(new Set(h.lockNames).size, 1);
  });
}

test('direct Excel and email imports share the same lock in both directions', { timeout: 5000 }, async (t) => {
  for (const mailFirst of [false, true]) {
    const h = await harness();
    const hold = gate();
    t.after(hold.resume);
    h.hooks.set('write', hold.wait);
    const input = { buffer: workbook(), fileName: 'Synthetic.xlsx' };
    const owner = mailFirst ? h.first.importStockFromEmail() : h.first.importStockFromExcelBuffer(input);
    await hold.entered;
    if (mailFirst) await assert.rejects(h.second.importStockFromExcelBuffer(input), /Импорт остатков уже выполняется/);
    else assert.equal((await h.second.importStockFromEmail()).status, 'busy');
    assert.equal(h.events.filter((event) => event === 'legacy-acquire').length, 1);
    hold.resume();
    await owner;
    assert.equal(h.state.updates, 1);
    assert.equal(new Set(h.lockNames).size, 1);
    assert.equal(h.state.sessionReleases, 1);
  }
});

test('a long new-worker run cannot lose exclusivity when the legacy row passes its TTL', { timeout: 5000 }, async (t) => {
  const h = await harness();
  const hold = gate();
  t.after(hold.resume);
  h.hooks.set('write', hold.wait);
  const owner = h.first.importStockFromEmail();
  await hold.entered;
  h.ageLegacyRowPastTtl();
  assert.equal((await h.second.importStockFromEmail()).status, 'busy');
  assert.equal(h.events.filter((event) => event === 'legacy-acquire').length, 1);
  assert.equal(h.state.legacyHeld, true, 'second worker cannot reach the legacy TTL cleanup');
  hold.resume();
  await owner;
  assert.equal(h.state.updates, 1);
  assert.equal(h.state.sessionReleases, 1);
});

test('legacy workbook contention returns busy without moving candidate or superseded email and permits retry', async () => {
  const h = await harness({ legacyBusy: true, messages: [{ uid: 100, buffer: workbook() }, { uid: 101, buffer: workbook() }] });
  const skipped = await h.first.importStockFromEmail();
  assert.equal(skipped.status, 'busy');
  assert.equal(skipped.checkedMessages, 2);
  assert.equal(skipped.processed, 0);
  assert.deepEqual(h.moves, []);
  assert.deepEqual(h.flags, []);
  assert.equal(h.state.updates, 0);
  assert.equal(h.state.legacyReleases, 0, 'legacy owner remains in charge of its row');
  assert.equal(h.state.sessionReleases, 1);
  h.expireLegacyRow();
  assert.equal((await h.second.importStockFromEmail()).processed, 1);
  assert.deepEqual(h.moves, [{ uid: 101, folder: 'Processed' }, { uid: 100, folder: 'Processed' }]);
});

for (const stage of ['constructor', 'connect', 'mailbox', 'search', 'fetch', 'parse', 'write', 'log', 'receipt'] as const) {
  test(`stock email releases the common lock after ${stage} failure`, async () => {
    const h = await harness({ fail: stage });
    await assert.rejects(h.first.importStockFromEmail(), /Synthetic/);
    assert.equal(h.state.sessionHeld, false);
    assert.equal(h.state.legacyHeld, false);
    assert.equal(h.state.sessionReleases, 1);
    if (stage !== 'constructor') assert.ok(h.events.includes('close'));
    if (['search', 'fetch', 'parse', 'write', 'mailbox-release', 'close'].includes(stage)) assert.ok(h.events.includes('mailbox-release'));
    assert.equal(h.moves.some(({ folder }) => folder === 'ImportErrors'), false, 'infrastructure failures must not classify a workbook as invalid');
    assert.equal(h.state.updates, 0);
  });
}

test('logout failure still closes the mail connection and releases the common lock', async () => {
  const h = await harness({ fail: 'logout' });
  assert.equal((await h.first.importStockFromEmail()).processed, 1);
  assert.equal(h.state.sessionHeld, false);
  assert.deepEqual(h.events.slice(-3), ['logout', 'close', 'session-release']);
});

for (const stage of ['mailbox-release', 'close'] as const) {
  test(`post-commit ${stage} failure reports a warning without losing successful import`, async () => {
    const h = await harness({ fail: stage });
    const result = await h.first.importStockFromEmail();
    assert.equal(result.result?.saved, true);
    assert.equal(result.result?.status, 'success');
    assert.equal(result.warnings?.length, 1);
    assert.equal(h.state.updates, 1);
    assert.equal(h.state.sessionHeld, false);
  });
}

test('failed MOVE and Seen after commit return saved warning and retry never reapplies selected or superseded snapshots', async () => {
  const h = await harness({ failMoveAndFlags: true, messages: [{ uid: 100, buffer: workbook() }, { uid: 101, buffer: workbook() }] });
  const first = await h.first.importStockFromEmail();
  assert.equal(first.result?.saved, true);
  assert.equal(first.warnings?.length, 2);
  assert.equal(h.state.updates, 1);
  assert.equal(h.logs.size, 1);
  assert.equal(h.receipts.size, 2);
  const second = await h.second.importStockFromEmail();
  assert.equal(second.result?.alreadyApplied, true);
  assert.equal(h.state.updates, 1);
  h.messages.delete(101); // simulate successful later archival of the newest mail
  const older = await h.first.importStockFromEmail();
  assert.equal(older.result?.alreadyApplied, true);
  assert.equal(h.state.updates, 1, 'superseded mail must not roll back a newer imported snapshot');
  assert.equal(h.logs.size, 1);
  assert.equal(h.state.sessionHeld, false);
});

test('a lost COMMIT acknowledgement leaves email intact and the next scan recovers its receipt without another stock update', async () => {
  const h = await harness({ commitUnknownOnce: true });
  await assert.rejects(h.first.importStockFromEmail(), /COMMIT result unknown/);
  assert.deepEqual(h.moves, [], 'uncertain commit is not a malformed file');
  assert.equal(h.state.sessionHeld, false);
  assert.equal(h.state.updates, 1, 'simulated database commit already persisted');
  const recovered = await h.second.importStockFromEmail();
  assert.equal(recovered.result?.alreadyApplied, true);
  assert.equal(recovered.result?.saved, true);
  assert.equal(h.state.updates, 1);
  assert.equal(h.logs.size, 1);
  assert.deepEqual(h.moves, [{ uid: 101, folder: 'Processed' }]);
});

test('an actually invalid workbook retains existing ImportErrors behavior and releases both locks', async () => {
  const h = await harness({ messages: [{ uid: 101, buffer: workbook('Unknown quantity') }] });
  await assert.rejects(h.first.importStockFromEmail(), /Остатки не изменены/);
  assert.deepEqual(h.moves, [{ uid: 101, folder: 'ImportErrors' }]);
  assert.equal(h.state.sessionHeld, false);
  assert.equal(h.state.legacyHeld, false);
  assert.equal(h.state.updates, 0);
});

test('a compact email workbook truncated before its later warehouse cannot save partial stock or a receipt', async () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Артикул', 'Сейчас'], ['ЛДМ 2'], ['SYNTHETIC-SKU', 3],
  ]);
  XLSX.utils.sheet_add_aoa(sheet, [['1Основной склад Волжск'], ['SYNTHETIC-SKU', 8]], { origin: 'A59999' });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Synthetic');
  const buffer = Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true }));
  assert.ok(buffer.byteLength < 15 * 1024, 'sparse attachment is small despite containing a warehouse at row 60000');
  const fullSheet = XLSX.read(buffer, { type: 'buffer' }).Sheets.Synthetic;
  assert.equal(fullSheet.B3.v, 3);
  assert.equal(fullSheet.B60000.v, 8, 'the second warehouse exists in the actual attachment');

  const h = await harness({ messages: [{ uid: 100, buffer: workbook() }, { uid: 101, buffer }] });
  await assert.rejects(h.first.importStockFromEmail(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /обрезан при чтении/);
    assert.match(error.message, /Остатки не изменены/);
    return true;
  });
  assert.equal(h.state.updates, 0);
  assert.equal(h.logs.size, 0);
  assert.equal(h.receipts.size, 0);
  assert.deepEqual(h.events.filter((event) => ['write', 'log', 'receipt'].includes(event)), [], 'validation must reject before attempting to save');
  assert.deepEqual(h.moves, [{ uid: 101, folder: 'ImportErrors' }]);
  assert.deepEqual(h.flags, []);
  assert.ok(h.messages.has(100), 'older mail must not be archived after an invalid newest snapshot');
  assert.equal(h.state.sessionHeld, false);
  assert.equal(h.state.legacyHeld, false);
  assert.equal(h.state.sessionReleases, 1);
  assert.equal(h.state.legacyReleases, 1);
  assert.deepEqual(h.events.slice(-4), ['mailbox-release', 'logout', 'close', 'session-release']);
});

test('mailbox MOVE fallback and an empty scan both release the common lock', async () => {
  const fallback = await harness({ fail: 'move' });
  assert.equal((await fallback.first.importStockFromEmail()).processed, 1);
  assert.deepEqual(fallback.flags, [101]);
  assert.equal(fallback.state.sessionHeld, false);
  const empty = await harness({ messages: [] });
  assert.equal((await empty.first.importStockFromEmail()).processed, 0);
  assert.equal(empty.state.sessionReleases, 1);
  assert.equal(empty.state.legacyReleases, 0);
});
