import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
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
function repository(steps: Step[] = []) {
  const queries: string[] = [];
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
    'node:crypto': crypto, '../managerDashboardDomain': domain,
    '../supportSharedRoutePlannerHtml': { detectSupportSharedHtmlFormat: () => 'ktsp' },
    '../supportSharedRoutePlannerData': { SUPPORT_SHARED_JSON_MAX_BYTES: 100 * 1024 * 1024,
      SUPPORT_SHARED_JSON_MAX_VERSIONS: 5, SUPPORT_SHARED_JSON_TOTAL_MAX_BYTES: 1024 * 1024 * 1024,
      openVerifiedSupportSharedRoutePlannerFile: async () => assert.fail('unexpected JSON file read') },
    '../topDashboardDataStorage': { deleteTopDashboardDataFiles: async () => {} },
    './client': { withTransaction: async (callback: (value: typeof client) => unknown) => { transactions++; return callback(client); } },
    './schema': { ensureSiteSchema: async () => { schemaCalls++; } },
  });
  return { repo, queries, get schemaCalls() { return schemaCalls; }, get transactions() { return transactions; },
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
    for (const kind of ['overview', 'html', 'snapshot'] as const) {
      const db = repository([{ ...support, rows: account ? [account] : [] }]);
      await assert.rejects(() => kind === 'overview' ? db.repo.getSupportSharedDashboardOverview(20)
        : kind === 'html' ? db.repo.getSupportSharedDashboardHtml(undefined, false, 20)
          : db.repo.getSupportSharedDashboardSnapshot(20), { code: 'NOT_FOUND' });
      assert.equal(db.transactions, 1);
      assert.equal(db.queries.length, 1, 'Denied accounts receive no shared metadata or encrypted bytes');
      db.done();
    }
  }
});

test('viewer overview selects active published HTML only and hides previous HTML identity', async () => {
  const db = repository([support, readState,
    { sql: /from support_shared_dashboard_html_versions where id=\$1 and first_published_at is not null order by id desc$/, rows: [], params: ['8'] },
    { sql: /from support_shared_dashboard_snapshots order by issued desc,id desc limit 32$/, rows: [snapshotRow()] },
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

test('snapshot version and byte quotas fail without pruning or overwriting current data', async () => {
  for (const [count, fileSize] of [[32, 1000], [16, 8 * 1024 * 1024]]) {
    const rows = Array.from({ length: count }, (_, index) => ({ ...snapshotRow(), id: String(index + 1),
      issued: day(-1), sha256: String(index).padStart(64, '0'), file_size: String(fileSize) }));
    const db = repository([lock, writeState,
      { sql: /from support_shared_dashboard_snapshots order by issued desc,id desc$/, rows },
    ]);
    await assert.rejects(() => db.repo.importSupportSharedDashboardSnapshot({ filename: 'shared.ktsp', bytes: snapshot(),
      email: 'shared@example.test', actorId: 'admin:test', expectedActiveSnapshotId: 4 }), { code: 'SNAPSHOT_QUOTA' });
    assert.equal(db.queries.some((sql) => /^\s*(insert|update|delete)/.test(sql)), false);
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
