import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import test from 'node:test';
import ts from 'typescript';

import * as domain from '../src/shared/lib/managerDashboardDomain';
import * as limits from '../src/shared/lib/topDashboardLimits';

function compile<T>(filename: string, modules: Record<string, unknown>): T {
  const source = readFileSync(new URL(filename, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} as T };
  new Function('require', 'module', 'exports', code)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  return loaded.exports;
}
const state = { active_html_version_id: '8', previous_html_version_id: '7', active_snapshot_id: '4', previous_snapshot_id: '3' };
function day(offset = 0) {
  const date = new Date(`${domain.personalDashboardToday()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
function snapshot(email = 'shared@example.test', offset = 0, expires = day(40)) {
  return Buffer.from(JSON.stringify({ fmt: 'kts-personal', v: 1, gz: true,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: 200000, salt: Buffer.alloc(16).toString('base64') },
    iv: Buffer.alloc(12).toString('base64'), ct: Buffer.alloc(16, 1).toString('base64'),
    emailHash: domain.getManagerEmailHash(email), name: 'Shared', role: 'Support', issued: day(offset), expires }));
}
function snapshotRow() {
  const bytes = snapshot();
  const metadata = domain.inspectPersonalSnapshot(bytes, 'shared.ktsp');
  return { id: '4', original_name: metadata.originalName, file_size: String(bytes.length), sha256: metadata.sha256,
    recipient_email: 'shared@example.test', email_hash: metadata.emailHash, person_name: 'Shared', person_role: 'Support',
    issued: metadata.issued, expires: metadata.expires, uploaded_by: 'admin:test', received_at: new Date().toISOString(), encrypted_payload: bytes };
}
type Step = { sql: RegExp; rows: unknown[]; params?: unknown[]; count?: number };
function repository(steps: Step[] = [], options: {openFile?: () => Readable | Promise<Readable>; transactionError?: Error;
  domainOverrides?: Record<string, number | undefined>} = {}) {
  const queries: string[] = [];
  const fileReads: unknown[][] = [];
  const deletedFiles: string[][] = [];
  const queuedFiles: string[][] = [];
  let transactionActive = false;
  let schemaCalls = 0;
  let transactions = 0;
  const client = { query: async (sql: string, params: unknown[] = []) => {
    queries.push(sql);
    assert.doesNotMatch(sql, /\bpersonal_dashboard_/, 'The second report never reads or writes personal dashboard tables');
    const expected = steps.shift();
    assert.ok(expected, `Unexpected SQL: ${sql}`);
    assert.match(sql.replace(/\s+/g, ' ').trim(), expected.sql);
    if (expected.params) assert.deepEqual(params, expected.params);
    return { rows: expected.rows, rowCount: expected.count ?? expected.rows.length };
  } };
  const repo = compile<typeof import('../src/shared/lib/db/supportSharedDashboardRepo')>('../src/shared/lib/db/supportSharedDashboardRepo.ts', {
    'node:crypto': crypto, '../managerDashboardDomain': {...domain, ...options.domainOverrides},
    '../supportSharedRoutePlannerHtml': { detectSupportSharedHtmlFormat: () => 'ktsp' },
    '../supportSharedRoutePlannerData': { SUPPORT_SHARED_JSON_MAX_BYTES: 100 * 1024 * 1024,
      SUPPORT_SHARED_JSON_MAX_VERSIONS: 2, SUPPORT_SHARED_JSON_TOTAL_MAX_BYTES: 1024 * 1024 * 1024,
      openVerifiedSupportSharedRoutePlannerFile: async (...args: unknown[]) => {
        fileReads.push(args);
        return options.openFile ? options.openFile() : assert.fail('unexpected JSON file read');
      } },
    '../topDashboardDataStorage': { deleteTopDashboardDataFiles: async (paths: string[]) => { deletedFiles.push(paths); } },
    './dashboardFileCleanupRepo': { enqueueDashboardFilesForDeletion: async (connection: typeof client, paths: string[]) => {
      assert.equal(connection, client, 'Outbox uses the same transaction as snapshot/HTML pruning');
      assert.equal(transactionActive, true, 'Outbox is durable before COMMIT');
      queuedFiles.push(paths);
    } },
    './client': { withTransaction: async (callback: (value: typeof client) => unknown) => {
      transactions++;
      transactionActive = true;
      try {
        const result = await callback(client);
        if (options.transactionError) throw options.transactionError;
        return result;
      } finally { transactionActive = false; }
    } },
    './schema': { ensureSiteSchema: async () => { schemaCalls++; } },
  });
  return { repo, queries, fileReads, deletedFiles, queuedFiles, get schemaCalls() { return schemaCalls; }, get transactions() { return transactions; },
    done() { assert.deepEqual(steps, []); } };
}
const support = { sql: /^select role,is_active from wholesale_managers where id=\$1 for share$/, rows: [{ role: 'support_manager', is_active: true }], params: [20] };
const readState = { sql: /^select .* from support_shared_dashboard_state where id=1 for share$/, rows: [state] };
const lock = { sql: /^select pg_advisory_xact_lock\(hashtext\(\$1\)\)$/, params: ['kts-support-shared-dashboard'], rows: [] };
const writeState = { sql: /^select .* from support_shared_dashboard_state where id=1 for update$/, rows: [state] };

test('shared migration only creates new report tables and does not migrate or copy personal data', async () => {
  const statements: string[] = [];
  const migrations = compile<typeof import('../src/shared/lib/db/migrations')>('../src/shared/lib/db/migrations.ts', {
    '../topDashboardLimits': limits, './client': {},
  });
  await migrations.applySupportSharedDashboardMigration({ query: async (sql: string) => { statements.push(sql); } } as never);
  assert.equal(statements.length, 1);
  assert.doesNotMatch(statements[0], /(?:^|;)\s*(?:alter|drop|delete|update|truncate)\b|\bpersonal_dashboard_|\bwholesale_/i);
  assert.match(statements[0], /create table support_shared_dashboard_html_versions/);
  assert.match(statements[0], /create table support_shared_dashboard_snapshots/);
  assert.match(statements[0], /create table support_shared_dashboard_state/);
  assert.doesNotMatch(statements[0], /password|secret|decrypted/i);
});

test('all viewer reads recheck exact active support role under a manager-row share lock', async () => {
  for (const account of [{ role: 'manager', is_active: true }, { role: null, is_active: true },
    { role: ' support_manager ', is_active: true }, { role: 'support_manager', is_active: false }, null]) {
    for (const kind of ['overview', 'html', 'snapshot', 'json'] as const) {
      const db = repository([{ ...support, rows: account ? [account] : [] }]);
      await assert.rejects(() => kind === 'overview' ? db.repo.getSupportSharedDashboardOverview(20)
        : kind === 'html' ? db.repo.getSupportSharedDashboardHtml(undefined, false, 20)
          : kind === 'snapshot' ? db.repo.getSupportSharedDashboardSnapshot(20)
            : db.repo.getSupportSharedDashboardJsonSnapshot(20, 8), { code: 'NOT_FOUND' });
      assert.equal(db.transactions, 1);
      assert.equal(db.queries.length, 1, 'Denied accounts receive no shared metadata or encrypted bytes');
      db.done();
    }
  }
});

const previewJsonSelect = /from support_shared_dashboard_html_versions h join support_shared_dashboard_json_state st on st.html_version_id=h.id join support_shared_dashboard_json_snapshots s on s.html_version_id=st.html_version_id and s.id=st.active_snapshot_id where h.id=\$1 and h.format='route-planner-v1' and \(\$2::bigint is null or s.id=\$2::bigint\) for share of h,st,s$/;
function jsonRow(htmlVersionId = '7') {
  return {id: '91', html_version_id: htmlVersionId, original_name: 'shared.json', file_size: '18', sha256: 'a'.repeat(64),
    storage_path: 'private/shared.bin', saved_at: '2026-09-17T05:28:47.226Z', received_at: '2026-09-17', uploaded_by: 'admin:test',
    active_snapshot_id: '91', previous_snapshot_id: '90'};
}

test('administrator preview metadata selects only that HTML version active JSON without publication or file reads', async () => {
  for (const htmlVersionId of [7, 8]) {
    const db = repository([{sql: previewJsonSelect, rows: [jsonRow(String(htmlVersionId))], params: [htmlVersionId, null]}]);
    const result = await db.repo.getSupportSharedDashboardJsonPreviewMetadata(htmlVersionId);
    assert.equal(result?.id, 91);
    assert.equal(result?.htmlVersionId, htmlVersionId);
    assert.equal(result?.status, 'active');
    assert.equal('storage_path' in result!, false);
    assert.equal('stream' in result!, false);
    assert.deepEqual(db.fileReads, []);
    assert.doesNotMatch(db.queries.join(' '), /first_published_at|support_shared_dashboard_state|wholesale_managers/);
    db.done();
  }
});

test('preview stream uses version-bound active ID and verifies private file size and checksum', async () => {
  const stream = Readable.from([Buffer.from('{"synthetic":true}')]);
  const db = repository([{sql: previewJsonSelect, rows: [jsonRow()], params: [7, 91]}], {openFile: () => stream});
  const result = await db.repo.getSupportSharedDashboardJsonPreviewSnapshot(7, 91);
  assert.ok(result);
  assert.equal(result.stream, stream);
  assert.deepEqual(db.fileReads, [['private/shared.bin', 18, 'a'.repeat(64)]]);
  assert.equal(await new Response(Readable.toWeb(result.stream) as ReadableStream<Uint8Array>).text(), '{"synthetic":true}');
  db.done();
});

test('missing, foreign and stale preview JSON return null without opening a private file', async () => {
  for (const snapshotId of [undefined, 90, 999]) {
    const db = repository([{sql: previewJsonSelect, rows: [], params: [7, snapshotId ?? null]}]);
    assert.equal(await db.repo.getSupportSharedDashboardJsonPreviewSnapshot(7, snapshotId), null);
    assert.deepEqual(db.fileReads, []);
    db.done();
  }
  const db = repository([{sql: previewJsonSelect, rows: [], params: [8, null]}]);
  assert.equal(await db.repo.getSupportSharedDashboardJsonPreviewMetadata(8), null);
  db.done();
});

test('invalid preview IDs fail before database access and failed stream transactions close the file', async () => {
  const invalid = repository();
  await assert.rejects(() => invalid.repo.getSupportSharedDashboardJsonPreviewMetadata(0), {code: 'NOT_FOUND'});
  await assert.rejects(() => invalid.repo.getSupportSharedDashboardJsonPreviewSnapshot(7, -1), {code: 'NOT_FOUND'});
  assert.equal(invalid.schemaCalls, 0);
  const stream = Readable.from(['synthetic']);
  const error = new Error('Transaction failed');
  const db = repository([{sql: previewJsonSelect, rows: [jsonRow()], params: [7, null]}], {
    openFile: () => stream, transactionError: error,
  });
  await assert.rejects(() => db.repo.getSupportSharedDashboardJsonPreviewSnapshot(7), error);
  assert.equal(stream.destroyed, true);
  db.done();
});

test('manager JSON reads still require the active published route planner HTML', async () => {
  const archived = repository([support, readState]);
  await assert.rejects(() => archived.repo.getSupportSharedDashboardJsonSnapshot(20, 7), {code: 'STATE_CONFLICT'});
  assert.deepEqual(archived.fileReads, []);
  archived.done();
  const legacy = repository([support, readState, {
    sql: /^select format from support_shared_dashboard_html_versions where id=\$1 and first_published_at is not null$/,
    rows: [{format: 'ktsp'}], params: [8],
  }]);
  await assert.rejects(() => legacy.repo.getSupportSharedDashboardJsonSnapshot(20, 8), {code: 'HTML_FORMAT'});
  assert.deepEqual(legacy.fileReads, []);
  legacy.done();
});

test('viewer overview selects active published HTML only and hides previous HTML identity', async () => {
  const db = repository([support, readState,
    { sql: /from support_shared_dashboard_html_versions where id=\$1 and first_published_at is not null order by id desc$/, rows: [], params: ['8'] },
    { sql: /from support_shared_dashboard_snapshots order by issued desc,id desc limit 2$/, rows: [snapshotRow()] },
  ]);
  const overview = await db.repo.getSupportSharedDashboardOverview(20);
  assert.deepEqual(overview.htmlVersions, []);
  assert.equal(overview.previousHtmlVersionId, null);
  assert.equal(overview.snapshot?.email, 'shared@example.test');
  assert.equal('bytes' in overview.snapshot!, false);
  db.done();
});

test('draft/archive HTML ID requests fail closed after role recheck; managerId is mandatory for published reads', async () => {
  const db = repository([support, readState]);
  assert.equal(await db.repo.getSupportSharedDashboardHtml(7, false, 20), null);
  db.done();
  const anonymous = repository();
  await assert.rejects(() => anonymous.repo.getSupportSharedDashboardHtml(undefined, false), { code: 'NOT_FOUND' });
  assert.equal(anonymous.schemaCalls, 0);
});

test('snapshot access is shared across support accounts and checks expiry, bytes and recipient integrity', async () => {
  for (const corruption of ['none', 'bytes', 'size', 'recipient', 'expiry'] as const) {
    const row = snapshotRow();
    if (corruption === 'bytes') row.encrypted_payload = Buffer.alloc(row.encrypted_payload.length);
    if (corruption === 'size') row.file_size = '1';
    if (corruption === 'recipient') row.recipient_email = 'another@example.test';
    if (corruption === 'expiry') row.expires = day(-1);
    const db = repository([support, readState,
      { sql: /from support_shared_dashboard_snapshots where id=\$1$/, rows: [row], params: [4] }]);
    if (corruption === 'none') {
      const result = await db.repo.getSupportSharedDashboardSnapshot(20);
      assert.ok(result);
      assert.ok(result.bytes.equals(snapshot()));
      assert.equal(result.email, 'shared@example.test', 'Use shared recipient, not the viewing manager email');
    } else await assert.rejects(() => db.repo.getSupportSharedDashboardSnapshot(20),
      { code: corruption === 'expiry' ? 'EXPIRED' : 'SNAPSHOT_INTEGRITY' });
    db.done();
  }
});

test('invalid envelopes, recipient mismatch, dates, CAS tokens and writer identities fail before database access', async () => {
  const db = repository();
  const valid = { filename: 'shared.ktsp', bytes: snapshot(), email: 'shared@example.test', actorId: 'admin:test', expectedActiveSnapshotId: null };
  for (const [input, code] of [
    [{ ...valid, email: 'wrong@example.test' }, 'EMAIL_MISMATCH'],
    [{ ...valid, email: 'invalid' }, 'INVALID_EMAIL'],
    [{ ...valid, email: 'a\u0000@example.test' }, 'INVALID_EMAIL'],
    [{ ...valid, bytes: Buffer.from('invalid') }, 'INVALID_SNAPSHOT'],
    [{ ...valid, bytes: snapshot(valid.email, 1) }, 'FUTURE_SNAPSHOT'],
    [{ ...valid, bytes: snapshot(valid.email, -2, day(-1)) }, 'EXPIRED_SNAPSHOT'],
    [{ ...valid, expectedActiveSnapshotId: undefined }, 'NOT_FOUND'],
    [{ ...valid, actorId: 'manager:20' }, 'INVALID_ACTOR'],
  ] as const) await assert.rejects(() => db.repo.importSupportSharedDashboardSnapshot(input as typeof valid), { code });
  assert.equal(db.schemaCalls, 0);
  assert.deepEqual(db.queries, []);
});

test('mutations serialize on the single shared lock and reject stale CAS before writes', async () => {
  const db = repository([
    lock, writeState,
    { sql: /from support_shared_dashboard_snapshots order by issued desc,id desc$/, rows: [] },
  ]);
  await assert.rejects(() => db.repo.importSupportSharedDashboardSnapshot({ filename: 'shared.ktsp', bytes: snapshot(),
    email: 'shared@example.test', actorId: 'admintop:2', expectedActiveSnapshotId: null }), { code: 'STATE_CONFLICT' });
  assert.equal(db.queries.some((sql) => /^\s*(insert|update|delete)/.test(sql)), false);
  db.done();
});

test('duplicate content retries are idempotent and preserve the current shared state', async () => {
  const db = repository([lock, writeState,
    { sql: /from support_shared_dashboard_snapshots order by issued desc,id desc$/, rows: [snapshotRow()] },
  ]);
  const result = await db.repo.importSupportSharedDashboardSnapshot({ filename: 'shared.ktsp', bytes: snapshot(),
    email: '\u00a0SHARED@EXAMPLE.TEST\u00a0', actorId: 'admin:test', expectedActiveSnapshotId: null });
  assert.equal(result.status, 'duplicate');
  assert.equal(result.snapshot.id, 4);
  assert.equal(db.queries.some((sql) => /^\s*(insert|update|delete)/.test(sql)), false);
  db.done();
});

test('snapshot quota rejection leaves pointers and accumulated history unchanged', async () => {
  for (const domainOverrides of [{PERSONAL_DASHBOARD_MANAGER_MAX_VERSIONS: 1}, {PERSONAL_DASHBOARD_MANAGER_MAX_BYTES: 1}]) {
    const rows = Array.from({ length: 32 }, (_, index) => ({ ...snapshotRow(), id: String(index + 1),
      issued: day(-1), sha256: String(index).padStart(64, '0') }));
    const db = repository([lock, writeState,
      { sql: /from support_shared_dashboard_snapshots order by issued desc,id desc$/, rows },
    ], {domainOverrides});
    await assert.rejects(() => db.repo.importSupportSharedDashboardSnapshot({ filename: 'shared.ktsp', bytes: snapshot(),
      email: 'shared@example.test', actorId: 'admin:test', expectedActiveSnapshotId: 4 }), { code: 'SNAPSHOT_QUOTA' });
    assert.equal(db.queries.some((sql) => /^\s*(insert|update|delete)/.test(sql)), false);
    db.done();
  }
});

test('shared HTML pruning deletes associated files only after a confirmed transaction commit', async () => {
  for (const transactionError of [undefined, new Error('uncertain commit')]) {
    const db = repository([lock, writeState,
      {sql: /^select id from support_shared_dashboard_html_versions where id=\$1$/, rows: [{id: '9'}], params: [9]},
      {sql: /^update support_shared_dashboard_html_versions set first_published_at=/, rows: []},
      {sql: /^update support_shared_dashboard_state set previous_html_version_id=active_html_version_id,/, rows: []},
      {sql: /^select s.storage_path .*v.first_published_at is not null and v.id is distinct from st.active_html_version_id and v.id is distinct from st.previous_html_version_id$/, rows: [{storage_path: 'retired-json.bin'}]},
      {sql: /^delete from support_shared_dashboard_html_versions v using support_shared_dashboard_state st .*v.first_published_at is not null and v.id is distinct from st.active_html_version_id and v.id is distinct from st.previous_html_version_id$/, rows: []},
    ], {transactionError});
    const publish = () => db.repo.activateSupportSharedDashboardHtml({versionId: 9, expectedActiveVersionId: 8, actorId: 'admin:test'});
    if (transactionError) {
      await assert.rejects(publish, transactionError);
      assert.deepEqual(db.deletedFiles, []);
    } else {
      assert.deepEqual(await publish(), {activeHtmlVersionId: 9, previousHtmlVersionId: 8});
      assert.deepEqual(db.deletedFiles, [['retired-json.bin']]);
    }
    assert.deepEqual(db.queuedFiles, [['retired-json.bin']], 'Even an uncertain COMMIT has already included its cleanup outbox');
    db.done();
  }
});

test('JSON retention protects the actual prior active pointer instead of the latest inserted archive', async () => {
  const active = jsonRow('8');
  const previous = {...active, id: '90', sha256: 'b'.repeat(64), storage_path: 'old-previous.bin'};
  const legacy = {...active, id: '94', sha256: 'c'.repeat(64), storage_path: 'legacy-archive.bin'};
  const created = {...active, id: '95', sha256: 'd'.repeat(64), storage_path: `dd/${'d'.repeat(64)}-00000000-0000-0000-0000-000000000000.bin`, saved_at: '2026-09-18T00:00:00Z'};
  const db = repository([lock, writeState,
    {sql: /^select format from support_shared_dashboard_html_versions where id=\$1 and first_published_at is not null$/, rows: [{format: 'route-planner-v1'}], params: [8]},
    {sql: /from support_shared_dashboard_json_snapshots s .*where s.html_version_id=\$1 order by s.id desc$/, rows: [legacy, active, previous], params: [8]},
    {sql: /^select active_snapshot_id::text from support_shared_dashboard_json_state where html_version_id=\$1 for update$/, rows: [{active_snapshot_id: '91'}], params: [8]},
    {sql: /^select coalesce\(sum\(file_size\),0\)::text as bytes from support_shared_dashboard_json_snapshots$/, rows: [{bytes: '54'}]},
    {sql: /^insert into support_shared_dashboard_json_snapshots/, rows: [created]},
    {sql: /^update support_shared_dashboard_json_state set previous_snapshot_id=active_snapshot_id,/, rows: [], params: [8, '95', 'admin:test']},
    {sql: /^delete from support_shared_dashboard_json_snapshots where html_version_id=\$1 and id=any\(\$2::bigint\[\]\)$/, rows: [], params: [8, ['94', '90']]},
  ]);
  const result = await db.repo.importSupportSharedDashboardJson({htmlVersionId: 8, expectedActiveSnapshotId: 91,
    originalName: 'next.json', fileSize: 18, sha256: created.sha256, storagePath: created.storage_path,
    savedAt: created.saved_at, actorId: 'admin:test'});
  assert.equal(result.status, 'imported');
  assert.equal(result.snapshot.id, 95);
  assert.deepEqual(result.prunedStoragePaths, ['legacy-archive.bin', 'old-previous.bin']);
  assert.deepEqual(db.queuedFiles, [['legacy-archive.bin', 'old-previous.bin']]);
  assert.deepEqual(db.deletedFiles, [], 'The route owns confirmed-commit file cleanup for JSON imports');
  db.done();
});

test('manual shared HTML deletion records bound files in the same transaction before cleanup', async () => {
  for (const transactionError of [undefined, new Error('uncertain commit')]) {
    const db = repository([lock, writeState,
      {sql: /^select id,format from support_shared_dashboard_html_versions where id=\$1$/, rows: [{id: '7', format: 'route-planner-v1'}], params: [7]},
      {sql: /^select storage_path from support_shared_dashboard_json_snapshots where html_version_id=\$1$/, rows: [{storage_path: 'deleted-html-json.bin'}], params: [7]},
      {sql: /^update support_shared_dashboard_state set previous_html_version_id=case/, rows: []},
      {sql: /^delete from support_shared_dashboard_html_versions where id=\$1 returning id$/, rows: [{id: '7'}], params: [7]},
    ], {transactionError});
    const remove = () => db.repo.deleteSupportSharedDashboardHtml({versionId: 7, actorId: 'admin:test'});
    if (transactionError) {
      await assert.rejects(remove, transactionError);
      assert.deepEqual(db.deletedFiles, []);
    } else {
      assert.deepEqual(await remove(), {deletedVersionId: 7});
      assert.deepEqual(db.deletedFiles, [['deleted-html-json.bin']]);
    }
    assert.deepEqual(db.queuedFiles, [['deleted-html-json.bin']]);
    db.done();
  }
});

test('HTML quotas protect existing versions and publication under the same shared mutation lock', async () => {
  for (const [count, bytes] of [[50, 1000], [1, 100 * 1024 * 1024]]) {
    const db = repository([lock, writeState,
      { sql: /^select count\(\*\)::text as count, coalesce\(sum\(file_size\),0\)::text as bytes from support_shared_dashboard_html_versions$/,
        rows: [{ count: String(count), bytes: String(bytes) }] },
    ]);
    const htmlContent = '<html>Shared</html>';
    await assert.rejects(() => db.repo.createSupportSharedDashboardHtml({ originalName: 'shared.html', htmlContent,
      fileSize: Buffer.byteLength(htmlContent), sha256: crypto.createHash('sha256').update(htmlContent).digest('hex'), actorId: 'admin:test' }), { code: 'HTML_QUOTA' });
    assert.equal(db.queries.some((sql) => /^\s*(insert|update|delete)/.test(sql)), false);
    db.done();
  }
});
