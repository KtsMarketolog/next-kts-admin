/** Explicit isolated PostgreSQL test only; never run with application/production credentials.
 * Run through scripts/test-personal-dashboard-postgres.sh (isolated local Unix socket only).
 * node --import tsx --test tests/manager-dashboard-db.integration.ts
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { query } from '../src/shared/lib/db/client';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import {
  activatePersonalDashboardHtml, createPersonalDashboardHtml, getPersonalDashboardHtml,
  getPersonalDashboardSnapshot, getPersonalDashboardStatus, importPersonalDashboardSnapshot,
  listPersonalDashboardAdmin, recordPersonalDashboardImportFailure,
} from '../src/shared/lib/db/managerDashboardRepo';
import { getManagerEmailHash, personalDashboardToday } from '../src/shared/lib/managerDashboardDomain';

function guard() {
  assert.equal(process.env.KTS_PERSONAL_TEST, '1', 'Isolated integration tests require KTS_PERSONAL_TEST=1');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['localhost', '127.0.0.1', '[::1]', ''].includes(url.hostname), 'Only local isolated PostgreSQL is permitted');
  assert.equal(url.pathname, '/kts_personal_integration', 'Use the dedicated disposable test database');
  assert.equal(url.username, 'personal_app', 'Use the isolated unprivileged test role');
  for (const [key] of url.searchParams) assert.ok(['host', 'port'].includes(key), 'Unexpected database option');
  const socket = url.searchParams.get('host');
  assert.ok(socket && (socket.startsWith('/tmp/kts-personal-postgres.') || socket.startsWith('/private/tmp/kts-personal-postgres.'))
    && socket.endsWith('/socket'), 'Only the private temporary integration socket is permitted');
}
function day(offset: number) {
  const today = new Date(`${personalDashboardToday()}T12:00:00Z`);
  today.setUTCDate(today.getUTCDate() + offset);
  return today.toISOString().slice(0, 10);
}
function bytes(email: string, offset = 0, token = 1, expires = day(45)) {
  return Buffer.from(JSON.stringify({
    fmt: 'kts-personal', v: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iter: 200000, salt: Buffer.alloc(16, 2).toString('base64') },
    iv: Buffer.alloc(12, 3).toString('base64'), gz: true, emailHash: getManagerEmailHash(email),
    name: 'Synthetic Integration Manager', role: 'Development manager', issued: day(offset), expires,
    ct: Buffer.alloc(32, token).toString('base64'),
  }));
}
async function manager(label: string, role = 'manager', active = true, emailOverride?: string) {
  const suffix = randomUUID();
  const email = emailOverride ?? `${label}-${suffix}@example.test`;
  const result = await query<{ id: string }>(`insert into wholesale_managers (login,email,name,role,is_active)
    values ($1,$2,$3,$4,$5) returning id::text`, [`test-${suffix}`, email, `Synthetic ${label}`, role, active]);
  return { id: Number(result.rows[0].id), email };
}
const importFile = (data: Buffer, key = randomUUID()) => importPersonalDashboardSnapshot({
  filename: 'personal.ktsp', bytes: data, sourceKey: key, sender: 'synthetic@example.test', messageId: 'test-message',
});
const html = (label: string) => {
  const content = `<!doctype html><html><body>${label}</body></html>`;
  return createPersonalDashboardHtml({ originalName: `${label}.html`, htmlContent: content,
    fileSize: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'), actorId: 'admin:integration-test' });
};

test('personal dashboards isolated PostgreSQL acceptance', async (t) => {
  guard();
  // Never accept an existing production schema even if someone renamed a connection variable.
  try {
    const existing = await query<{ present: string | null }>(`select to_regclass('public.wholesale_managers')::text as present`);
    assert.equal(existing.rows[0].present, null, 'The test database must be fresh and empty');
    await ensureSiteSchema();
    const baseline = await query<{ id: string }>(`select id from schema_migrations where id='202609140001_personal_manager_dashboards'`);
    assert.equal(baseline.rowCount, 1);

    await t.test('eleven attachments map independently; one broken file does not prevent ten good ones', async () => {
      const recipients = await Promise.all(Array.from({ length: 11 }, (_, index) => manager(`batch-${index}`)));
      const results = [];
      for (let index = 0; index < recipients.length; index++) {
        results.push(await importFile(index === 5 ? Buffer.from('invalid json') : bytes(recipients[index].email)));
      }
      assert.equal(results.filter((item) => item.status === 'imported').length, 10);
      assert.equal(results[5].status, 'invalid');
      for (let index = 0; index < recipients.length; index++) {
        const status = await getPersonalDashboardStatus(recipients[index].id);
        assert.equal(status.snapshot?.managerId ?? null, index === 5 ? null : recipients[index].id);
      }
    });

    await t.test('snapshot bytes require owner and CURRENT unique active development email binding', async () => {
      const owner = await manager('owner');
      const other = await manager('other');
      const data = bytes(owner.email);
      const imported = await importFile(data);
      assert.ok(imported.snapshotId);
      const snapshotId = imported.snapshotId;
      assert.equal((await getPersonalDashboardSnapshot(owner.id, imported.snapshotId))?.bytes.equals(data), true);
      assert.equal(await getPersonalDashboardSnapshot(other.id, imported.snapshotId), null);
      await query(`update wholesale_managers set email=$2 where id=$1`, [owner.id, 'changed@example.test']);
      assert.equal(await getPersonalDashboardSnapshot(owner.id, imported.snapshotId), null);
      assert.equal((await getPersonalDashboardStatus(owner.id)).history.length, 0);
      await query(`update wholesale_managers set email=$2 where id=$1`, [owner.id, owner.email]);
      const duplicate = await manager('duplicate', 'manager', true, `  ${owner.email.toUpperCase()}  `);
      await assert.rejects(() => getPersonalDashboardSnapshot(owner.id, snapshotId), { code: 'AMBIGUOUS_EMAIL' });
      assert.equal((await importFile(bytes(owner.email, 0, 2))).status, 'ambiguous');
      await query(`update wholesale_managers set is_active=false where id=$1`, [duplicate.id]);
      assert.ok(await getPersonalDashboardSnapshot(owner.id, imported.snapshotId));
      await query(`update wholesale_managers set role='support_manager' where id=$1`, [owner.id]);
      await assert.rejects(() => getPersonalDashboardSnapshot(owner.id, snapshotId), { code: 'NOT_FOUND' });
      await query(`update wholesale_managers set role='manager',is_active=false where id=$1`, [owner.id]);
      await assert.rejects(() => getPersonalDashboardStatus(owner.id), { code: 'NOT_FOUND' });
    });

    await t.test('duplicate files and concurrent imports are idempotent', async () => {
      const recipient = await manager('concurrent');
      const data = bytes(recipient.email);
      const key = randomUUID();
      const repeatedKey = await Promise.all([importFile(data, key), importFile(data, key)]);
      assert.deepEqual(repeatedKey.map((item) => item.status).sort(), ['duplicate', 'imported']);
      const repeatedContent = await Promise.all([importFile(data), importFile(data)]);
      assert.equal(repeatedContent.every((item) => item.status === 'duplicate'), true);
      assert.equal((await getPersonalDashboardStatus(recipient.id)).history.length, 1);
    });

    await t.test('unknown and ambiguous imports retry after an administrator fixes recipient binding', async () => {
      const email = `unknown-${randomUUID()}@example.test`;
      const data = bytes(email);
      const key = randomUUID();
      const unknown = await importFile(data, key);
      assert.equal(unknown.status, 'unknown');
      const found = await manager('now-known', 'manager', true, email);
      const retried = await importFile(data, key);
      assert.equal(retried.status, 'imported');
      assert.equal(retried.id, unknown.id);
      assert.equal(retried.managerId, found.id);
      const support = await manager('support', 'support_manager');
      const inactive = await manager('inactive', 'manager', false);
      assert.equal((await importFile(bytes(support.email))).status, 'unknown');
      assert.equal((await importFile(bytes(inactive.email))).status, 'unknown');
    });

    await t.test('old, expired, future and same-day conflicting snapshots never replace the good copy', async () => {
      const recipient = await manager('ordering');
      const good = await importFile(bytes(recipient.email, -1));
      assert.equal((await importFile(bytes(recipient.email, -2))).status, 'stale');
      assert.equal((await importFile(bytes(recipient.email, -1, 2))).status, 'conflict');
      assert.equal((await importFile(bytes(recipient.email, -30, 2, day(-2)))).status, 'expired');
      assert.equal((await importFile(bytes(recipient.email, 1))).status, 'invalid');
      assert.equal((await getPersonalDashboardStatus(recipient.id)).snapshot?.id, good.snapshotId);
      const fresh = await importFile(bytes(recipient.email, 0));
      assert.equal(fresh.status, 'imported');
      const status = await getPersonalDashboardStatus(recipient.id);
      assert.equal(status.history.find((item) => item.status === 'previous')?.id, good.snapshotId);
      // Expiry before issued is also prevented at the SQL boundary.
      await assert.rejects(() => query(`update personal_dashboard_snapshots set expires=$2 where id=$1`, [fresh.snapshotId, day(-1)]), { code: '23514' });
      assert.equal((await getPersonalDashboardStatus(recipient.id)).snapshot?.id, fresh.snapshotId);
      await query(`update personal_dashboard_snapshots set expires=$2 where id=$1`, [good.snapshotId, day(-1)]);
      await assert.rejects(() => getPersonalDashboardSnapshot(recipient.id, good.snapshotId!), { code: 'EXPIRED' });
    });

    await t.test('HTML draft/activation/rollback never exposes draft to managers or resets personal snapshots', async () => {
      const recipient = await manager('html-owner');
      const good = await importFile(bytes(recipient.email));
      const first = await html('one');
      const second = await html('two');
      assert.equal(await getPersonalDashboardHtml(first.id), null);
      assert.ok(await getPersonalDashboardHtml(first.id, true));
      await activatePersonalDashboardHtml({ versionId: first.id, expectedActiveVersionId: null, actorId: 'admin:integration-test' });
      assert.equal((await getPersonalDashboardHtml())?.id, first.id);
      await assert.rejects(() => activatePersonalDashboardHtml({ versionId: second.id, expectedActiveVersionId: null, actorId: 'admin:integration-test' }), { code: 'STATE_CONFLICT' });
      await activatePersonalDashboardHtml({ versionId: second.id, expectedActiveVersionId: first.id, actorId: 'admin:integration-test' });
      assert.equal(await getPersonalDashboardHtml(first.id), null);
      assert.ok(await getPersonalDashboardHtml(first.id, true));
      await activatePersonalDashboardHtml({ versionId: first.id, expectedActiveVersionId: second.id, actorId: 'admin:integration-test' });
      assert.equal((await getPersonalDashboardStatus(recipient.id)).snapshot?.id, good.snapshotId);
    });

    await t.test('fourteen-day cleanup preserves the newest two and is atomic with accepted import', async () => {
      const recipient = await manager('retention');
      for (const offset of [-3, -2, -1]) assert.equal((await importFile(bytes(recipient.email, offset))).status, 'imported');
      await query(`update personal_dashboard_snapshots set received_at=now()-interval '15 days' where manager_id=$1`, [recipient.id]);
      assert.equal((await importFile(bytes(recipient.email))).status, 'imported');
      const state = await getPersonalDashboardStatus(recipient.id);
      assert.equal(state.history.length, 2);
      assert.equal(state.history[0].status, 'active');
      assert.equal(state.history[1].status, 'previous');
    });

    await t.test('version quota rejects a new import without deleting the current good copy', async () => {
      const recipient = await manager('quota');
      for (let offset = -32; offset < 0; offset++) {
        assert.equal((await importFile(bytes(recipient.email, offset, offset + 40))).status, 'imported');
      }
      const before = await getPersonalDashboardStatus(recipient.id);
      assert.equal(before.history.length, 32);
      assert.equal((await importFile(bytes(recipient.email))).status, 'quota');
      const after = await getPersonalDashboardStatus(recipient.id);
      assert.equal(after.snapshot?.id, before.snapshot?.id);
      assert.equal(after.history.length, 32);
    });

    await t.test('transport failures are safe and visible in the administrator import journal', async () => {
      const result = await recordPersonalDashboardImportFailure({ filename: 'bad.ktsp', sourceKey: randomUUID(),
        code: 'arbitrary SMTP response with credentials must never enter the journal' });
      assert.equal(result.code, 'ATTACHMENT_FAILED');
      const overview = await listPersonalDashboardAdmin();
      assert.ok(overview.imports.some((item) => item.id === result.id && item.code === 'ATTACHMENT_FAILED'));
      assert.equal(overview.managers.some((item) => 'bytes' in item), false);
      assert.ok(overview.htmlVersions.every((item) => !('htmlContent' in item)));
    });

    await t.test('existing manager deletion safely cascades only that manager personal state', async () => {
      const recipient = await manager('delete-only-synthetic');
      const imported = await importFile(bytes(recipient.email));
      const before = await query<{ count: string }>(`select count(*)::text from personal_dashboard_snapshots`);
      await query(`delete from wholesale_managers where id=$1`, [recipient.id]);
      const after = await query<{ count: string }>(`select count(*)::text from personal_dashboard_snapshots`);
      assert.equal(Number(after.rows[0].count), Number(before.rows[0].count) - 1);
      const log = await query<{ manager_id: string | null; snapshot_id: string | null }>(
        `select manager_id::text,snapshot_id::text from personal_dashboard_imports where id=$1`, [imported.id]);
      assert.equal(log.rows[0].manager_id, null);
      assert.equal(log.rows[0].snapshot_id, null);
    });
  } finally {
    await globalThis.__ktsPgPool?.end();
    globalThis.__ktsPgPool = undefined;
  }
});
