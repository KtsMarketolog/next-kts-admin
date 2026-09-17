/** Explicit isolated PostgreSQL test only; never run with application/production credentials.
 * Run through scripts/test-personal-dashboard-postgres.sh (isolated local Unix socket only).
 * node --import tsx --test tests/manager-dashboard-db.integration.ts
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import test from 'node:test';

import { query, withTransaction } from '../src/shared/lib/db/client';
import { applyPersonalDashboardAudienceMigration } from '../src/shared/lib/db/migrations';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import {
  activatePersonalDashboardHtml, createPersonalDashboardHtml, deletePersonalDashboardHtml, getPersonalDashboardHtml,
  getPersonalDashboardSnapshot, getPersonalDashboardStatus, importPersonalDashboardSnapshot,
  listPersonalDashboardAdmin, listPersonalDashboardImports, recordPersonalDashboardImportFailure,
} from '../src/shared/lib/db/managerDashboardRepo';
import { getManagerEmailHash, inspectPersonalSnapshot, personalDashboardToday } from '../src/shared/lib/managerDashboardDomain';
import type { PersonalDashboardAudience } from '../src/shared/lib/managerDashboardAudience';
import { getPersonalDashboardMailReceipt, recordPersonalDashboardMailReceipt, prunePersonalDashboardMailReceipts } from '../src/shared/lib/db/managerDashboardMailReceipts';
import {
  activateSupportSharedDashboardHtml, createSupportSharedDashboardHtml, deleteSupportSharedDashboardHtml,
  getSupportSharedDashboardHtml, getSupportSharedDashboardOverview, getSupportSharedDashboardSnapshot,
  importSupportSharedDashboardSnapshot,
  assertSupportSharedJsonUploadTarget, importSupportSharedDashboardJson, getSupportSharedDashboardJsonSnapshot,
  getSupportSharedDashboardJsonPreviewMetadata, getSupportSharedDashboardJsonPreviewSnapshot,
} from '../src/shared/lib/db/supportSharedDashboardRepo';
import { prepareSupportSharedRoutePlannerUpload } from '../src/shared/lib/supportSharedRoutePlannerData';
import { deleteTopDashboardDataFiles } from '../src/shared/lib/topDashboardDataStorage';
import { drainDashboardFileCleanup } from '../src/shared/lib/dashboardFileCleanup';

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
const html = (label: string, audience?: PersonalDashboardAudience) => {
  const content = `<!doctype html><html><body>${label}</body></html>`;
  return createPersonalDashboardHtml({ originalName: `${label}.html`, htmlContent: content,
    fileSize: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'), actorId: 'admin:integration-test', audience });
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

    await t.test('additive audience migration preserves legacy development publications and unrelated data', async () => {
      // Temporary legacy tables shadow public tables only on this connection and disappear at commit.
      await withTransaction(async (client) => {
        await client.query(`
          create temp table personal_dashboard_html_versions (
            id bigint primary key, html_content text not null, created_at text not null
          ) on commit drop;
          create temp table personal_dashboard_html_state (
            id smallint primary key check (id=1),
            active_version_id bigint references personal_dashboard_html_versions(id),
            previous_version_id bigint references personal_dashboard_html_versions(id),
            updated_by text,
            check (active_version_id is null or previous_version_id is null or active_version_id<>previous_version_id)
          ) on commit drop;
          create temp table personal_dashboard_snapshots (payload text) on commit drop;
          create temp table wholesale_price_lists (payload text) on commit drop;
          insert into personal_dashboard_html_versions values (91,'legacy current','unchanged'),(90,'legacy previous','unchanged');
          insert into personal_dashboard_html_state values (1,91,90,'admin:legacy');
          insert into personal_dashboard_snapshots values ('encrypted sentinel unchanged');
          insert into wholesale_price_lists values ('price sentinel unchanged');
        `);
        await applyPersonalDashboardAudienceMigration(client);
        assert.deepEqual((await client.query(`select id,audience,active_version_id::text,previous_version_id::text,updated_by
          from personal_dashboard_html_state order by id`)).rows, [
          { id: 1, audience: 'development', active_version_id: '91', previous_version_id: '90', updated_by: 'admin:legacy' },
          { id: 2, audience: 'support', active_version_id: null, previous_version_id: null, updated_by: null },
        ]);
        assert.deepEqual((await client.query(`select id::text,html_content,created_at,audience from personal_dashboard_html_versions order by id`)).rows, [
          { id: '90', html_content: 'legacy previous', created_at: 'unchanged', audience: 'development' },
          { id: '91', html_content: 'legacy current', created_at: 'unchanged', audience: 'development' },
        ]);
        assert.equal((await client.query(`select payload from personal_dashboard_snapshots`)).rows[0].payload, 'encrypted sentinel unchanged');
        assert.equal((await client.query(`select payload from wholesale_price_lists`)).rows[0].payload, 'price sentinel unchanged');
      });
    });

    await t.test('mixed-role attachments map independently; one broken file does not prevent ten good ones', async () => {
      const recipients = await Promise.all(Array.from({ length: 11 }, (_, index) => manager(`batch-${index}`, index % 2 ? 'support_manager' : 'manager')));
      const results = [];
      for (let index = 0; index < recipients.length; index++) {
        results.push(await importFile(index === 5 ? Buffer.from('invalid json') : bytes(recipients[index].email)));
      }
      assert.equal(results.filter((item) => item.status === 'imported').length, 10);
      assert.equal(results[5].status, 'invalid');
      for (let index = 0; index < recipients.length; index++) {
        const status = await getPersonalDashboardStatus(recipients[index].id);
        assert.equal(status.audience, index % 2 ? 'support' : 'development');
        assert.equal(status.snapshot?.managerId ?? null, index === 5 ? null : recipients[index].id);
        if (index !== 5) assert.equal((await importFile(bytes(recipients[index].email))).status, 'duplicate');
      }
    });

    await t.test('snapshot bytes require owner and CURRENT unique active email across both manager roles', async () => {
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
      const duplicate = await manager('duplicate', 'support_manager', true, `  ${owner.email.toUpperCase()}  `);
      await assert.rejects(() => getPersonalDashboardSnapshot(owner.id, snapshotId), { code: 'AMBIGUOUS_EMAIL' });
      assert.equal((await importFile(bytes(owner.email, 0, 2))).status, 'ambiguous');
      await query(`update wholesale_managers set is_active=false where id=$1`, [duplicate.id]);
      assert.ok(await getPersonalDashboardSnapshot(owner.id, imported.snapshotId));
      await query(`update wholesale_managers set role='support_manager' where id=$1`, [owner.id]);
      assert.equal((await getPersonalDashboardStatus(owner.id)).audience, 'support');
      assert.equal((await getPersonalDashboardSnapshot(owner.id, snapshotId))?.bytes.equals(data), true,
        'Current account role selects the HTML audience without discarding this manager snapshot');
      await query(`update wholesale_managers set role='top' where id=$1`, [owner.id]);
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
      const found = await manager('now-known', 'support_manager', true, email);
      const retried = await importFile(data, key);
      assert.equal(retried.status, 'imported');
      assert.equal(retried.id, unknown.id);
      assert.equal(retried.managerId, found.id);
      const support = await manager('support', 'support_manager');
      const inactive = await manager('inactive', 'manager', false);
      assert.equal((await importFile(bytes(support.email))).status, 'imported');
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

    await t.test('support publication and rollback are independent and cross-audience references fail closed', async () => {
      const development = await getPersonalDashboardHtml();
      assert.ok(development);
      assert.equal(development.audience, 'development');
      const recipient = await manager('support-publication-owner', 'support_manager');
      const good = await importFile(bytes(recipient.email));
      const first = await html('support-one', 'support');
      const second = await html('support-two', 'support');
      assert.equal(first.audience, 'support');
      assert.equal(await getPersonalDashboardHtml(undefined, false, 'support'), null, 'No fallback to development HTML');
      assert.equal(await getPersonalDashboardHtml(first.id, false, 'support'), null);
      assert.ok(await getPersonalDashboardHtml(first.id, true, 'support'));
      assert.equal(await getPersonalDashboardHtml(first.id, true), null, 'Preview also stays in its audience');
      assert.equal(await getPersonalDashboardHtml(development.id, true, 'support'), null);
      await assert.rejects(() => activatePersonalDashboardHtml({
        versionId: development.id, expectedActiveVersionId: null, actorId: 'admin:integration-test', audience: 'support',
      }), { code: 'NOT_FOUND' });
      await activatePersonalDashboardHtml({ versionId: first.id, expectedActiveVersionId: null, actorId: 'admin:integration-test', audience: 'support' });
      const before = await listPersonalDashboardAdmin();
      assert.deepEqual(before.groups.map((group) => group.audience), ['development', 'support']);
      const developmentState = before.groups[0];
      await activatePersonalDashboardHtml({ versionId: second.id, expectedActiveVersionId: first.id, actorId: 'admin:integration-test', audience: 'support' });
      await assert.rejects(() => activatePersonalDashboardHtml({
        versionId: first.id, expectedActiveVersionId: first.id, actorId: 'admin:integration-test', audience: 'support',
      }), { code: 'STATE_CONFLICT' });
      const rolledBack = await activatePersonalDashboardHtml({ versionId: first.id, expectedActiveVersionId: second.id, actorId: 'admin:integration-test', audience: 'support' });
      assert.equal(rolledBack.previousHtmlVersionId, second.id);
      assert.equal((await getPersonalDashboardHtml(undefined, false, 'support'))?.id, first.id);
      assert.equal(await getPersonalDashboardHtml(second.id, false, 'support'), null);
      await assert.rejects(() => activatePersonalDashboardHtml({
        versionId: first.id, expectedActiveVersionId: development.id, actorId: 'admin:integration-test',
      }), { code: 'NOT_FOUND' });
      for (const column of ['active_version_id', 'previous_version_id']) {
        await assert.rejects(() => query(`update personal_dashboard_html_state set ${column}=$1 where id=1`, [first.id]), { code: '23503' });
        await assert.rejects(() => query(`update personal_dashboard_html_state set ${column}=$1 where id=2`, [development.id]), { code: '23503' });
      }
      await assert.rejects(() => query(`update personal_dashboard_html_state set id=3 where id=2`), { code: '23514' });
      await assert.rejects(() => query(`update personal_dashboard_html_versions set audience='other' where id=$1`, [second.id]), { code: '23514' });
      const after = await listPersonalDashboardAdmin();
      assert.deepEqual(after.groups[0], developmentState, 'Support publish and rollback leave development completely unchanged');
      assert.equal(after.groups[1].managers.find((item) => item.id === recipient.id)?.snapshot?.id, good.snapshotId);
      assert.equal(after.groups[0].managers.some((item) => item.id === recipient.id), false);
      assert.equal((await getPersonalDashboardStatus(recipient.id)).snapshot?.id, good.snapshotId);
      assert.equal((await getPersonalDashboardStatus(recipient.id)).audience, 'support');
    });

    await t.test('publication prunes only older published HTML in its audience, preserves every draft, and rolls back cleanup failures', async () => {
      for (const audience of ['development', 'support'] as const) {
        const before = await listPersonalDashboardAdmin();
        const group = before.groups.find((item) => item.audience === audience)!;
        const other = before.groups.find((item) => item.audience !== audience)!;
        const olderDraft = await html('retention-older-draft', audience);
        const laterDraft = await html('retention-later-draft', audience);
        const legacy = await html('retention-legacy-published', audience);
        await query(`update personal_dashboard_html_versions set first_published_at=now()-interval '400 days' where id=$1`, [legacy.id]);
        const unchanged = (await query(`select * from personal_dashboard_html_state where audience=$1`, [audience])).rows;
        assert.ok(await getPersonalDashboardHtml(legacy.id, true, audience), 'Reads do not prune accumulated history');
        await assert.rejects(() => activatePersonalDashboardHtml({versionId: olderDraft.id, expectedActiveVersionId: null,
          actorId: 'admin:integration-test', audience}), {code: 'STATE_CONFLICT'});
        assert.ok(await getPersonalDashboardHtml(legacy.id, true, audience), 'A rejected publication does not prune history');
        await query(`create function kts_test_reject_retention() returns trigger language plpgsql as
          $$ begin raise exception 'synthetic retention failure'; end $$`);
        try {
          await query(`create trigger kts_test_reject_retention before delete on personal_dashboard_html_versions
            for each row execute function kts_test_reject_retention()`);
          try {
            await assert.rejects(() => activatePersonalDashboardHtml({versionId: olderDraft.id, expectedActiveVersionId: group.activeHtmlVersionId,
              actorId: 'admin:integration-test', audience}), {code: 'P0001'});
            assert.deepEqual((await query(`select * from personal_dashboard_html_state where audience=$1`, [audience])).rows, unchanged);
            assert.equal((await getPersonalDashboardHtml(olderDraft.id, true, audience))?.firstPublishedAt, null);
            assert.ok(await getPersonalDashboardHtml(legacy.id, true, audience));
          } finally { await query(`drop trigger kts_test_reject_retention on personal_dashboard_html_versions`); }
        } finally { await query(`drop function kts_test_reject_retention()`); }
        await activatePersonalDashboardHtml({versionId: olderDraft.id, expectedActiveVersionId: group.activeHtmlVersionId,
          actorId: 'admin:integration-test', audience});
        assert.equal(await getPersonalDashboardHtml(legacy.id, true, audience), null);
        assert.equal(await getPersonalDashboardHtml(group.previousHtmlVersionId!, true, audience), null);
        assert.equal((await getPersonalDashboardHtml(laterDraft.id, true, audience))?.status, 'draft');
        await activatePersonalDashboardHtml({versionId: group.activeHtmlVersionId!, expectedActiveVersionId: olderDraft.id,
          actorId: 'admin:integration-test', audience});
        const after = await listPersonalDashboardAdmin();
        const retained = after.groups.find((item) => item.audience === audience)!;
        assert.deepEqual(retained.htmlVersions.filter((item) => item.firstPublishedAt).map((item) => item.id).sort((a,b) => a-b),
          [group.activeHtmlVersionId!, olderDraft.id].sort((a,b) => a-b));
        assert.equal(retained.previousHtmlVersionId, olderDraft.id, 'Rollback preserves the version just replaced');
        assert.deepEqual(after.groups.find((item) => item.audience !== audience), other);
      }
    });

    await t.test('HTML deletion is audience-scoped, protects active publication, and clears previous foreign keys atomically', async () => {
      const snapshotRows = (await query(`select id::text,manager_id::text,sha256 from personal_dashboard_snapshots order by id`)).rows;
      for (const audience of ['development', 'support'] as const) {
        const before = await listPersonalDashboardAdmin();
        const group = before.groups.find((item) => item.audience === audience)!;
        const other = before.groups.find((item) => item.audience !== audience)!;
        assert.ok(group.activeHtmlVersionId);
        assert.ok(group.previousHtmlVersionId);
        const activeId = group.activeHtmlVersionId;
        const previousId = group.previousHtmlVersionId;
        await assert.rejects(() => deletePersonalDashboardHtml({ versionId: activeId, actorId: 'admin:integration-test', audience }),
          { code: 'ACTIVE_VERSION_CONFLICT' });
        await assert.rejects(() => deletePersonalDashboardHtml({ versionId: other.activeHtmlVersionId!, actorId: 'admin:integration-test', audience }),
          { code: 'NOT_FOUND' });
        assert.deepEqual(await deletePersonalDashboardHtml({ versionId: previousId, actorId: 'admintop:integration-delete', audience }),
          { deletedVersionId: previousId, audience });
        assert.equal(await getPersonalDashboardHtml(previousId, true, audience), null);
        assert.equal((await getPersonalDashboardHtml(undefined, false, audience))?.id, activeId);
        await assert.rejects(() => deletePersonalDashboardHtml({ versionId: previousId, actorId: 'admin:integration-test', audience }), { code: 'NOT_FOUND' });
        const firstDraft = await html('delete-same-name', audience);
        const secondDraft = await html('delete-same-name', audience);
        await deletePersonalDashboardHtml({ versionId: firstDraft.id, actorId: 'admin:integration-test', audience });
        assert.equal(await getPersonalDashboardHtml(firstDraft.id, true, audience), null);
        assert.ok(await getPersonalDashboardHtml(secondDraft.id, true, audience), 'An identically named HTML is not the delete target');
        const after = await listPersonalDashboardAdmin();
        assert.equal(after.groups.find((item) => item.audience === audience)!.previousHtmlVersionId, null);
        assert.deepEqual(after.groups.find((item) => item.audience !== audience), other);
        assert.deepEqual((await query(`select id::text,manager_id::text,sha256 from personal_dashboard_snapshots order by id`)).rows,
          snapshotRows, 'HTML deletion never modifies encrypted snapshots or their ownership');
      }
    });

    await t.test('failed SQL deletion rolls back the previous publication pointer and actor', async () => {
      const audience = 'development';
      const current = await getPersonalDashboardHtml();
      assert.ok(current);
      const temporary = await html('delete-rollback-target', audience);
      await activatePersonalDashboardHtml({ versionId: temporary.id, expectedActiveVersionId: current.id, actorId: 'admin:integration-test', audience });
      await activatePersonalDashboardHtml({ versionId: current.id, expectedActiveVersionId: temporary.id, actorId: 'admin:integration-test', audience });
      const stateBefore = (await query(`select * from personal_dashboard_html_state where audience=$1`, [audience])).rows;
      // This database is disposable and guarded above. The trigger injects a failure after pointer UPDATE.
      await query(`create function kts_personal_test_fail_html_delete() returns trigger language plpgsql as
        $$ begin raise exception 'synthetic delete failure'; end $$`);
      try {
        await query(`create trigger kts_personal_test_fail_html_delete before delete on personal_dashboard_html_versions
          for each row execute function kts_personal_test_fail_html_delete()`);
        try {
          await assert.rejects(() => deletePersonalDashboardHtml({ versionId: temporary.id, actorId: 'admintop:failed-delete', audience }),
            { code: 'P0001' });
          assert.deepEqual((await query(`select * from personal_dashboard_html_state where audience=$1`, [audience])).rows, stateBefore);
          assert.ok(await getPersonalDashboardHtml(temporary.id, true, audience));
          assert.equal((await getPersonalDashboardHtml())?.id, current.id);
        } finally {
          await query(`drop trigger kts_personal_test_fail_html_delete on personal_dashboard_html_versions`);
        }
      } finally {
        await query(`drop function kts_personal_test_fail_html_delete()`);
      }
      await deletePersonalDashboardHtml({ versionId: temporary.id, actorId: 'admin:integration-test', audience });
    });

    await t.test('publication and HTML deletion serialize both orders and concurrent requests without losing the active version', async () => {
      for (const audience of ['development', 'support'] as const) {
        const current = await getPersonalDashboardHtml(undefined, false, audience);
        assert.ok(current);
        const deleteFirst = await html('delete-before-publication', audience);
        await deletePersonalDashboardHtml({ versionId: deleteFirst.id, actorId: 'admin:integration-test', audience });
        await assert.rejects(() => activatePersonalDashboardHtml({ versionId: deleteFirst.id, expectedActiveVersionId: current.id, actorId: 'admin:integration-test', audience }),
          { code: 'NOT_FOUND' });
        const publishFirst = await html('publication-before-delete', audience);
        await activatePersonalDashboardHtml({ versionId: publishFirst.id, expectedActiveVersionId: current.id, actorId: 'admin:integration-test', audience });
        await assert.rejects(() => deletePersonalDashboardHtml({ versionId: publishFirst.id, actorId: 'admin:integration-test', audience }),
          { code: 'ACTIVE_VERSION_CONFLICT' });
        await activatePersonalDashboardHtml({ versionId: current.id, expectedActiveVersionId: publishFirst.id, actorId: 'admin:integration-test', audience });
        await deletePersonalDashboardHtml({ versionId: publishFirst.id, actorId: 'admin:integration-test', audience });

        for (let iteration = 0; iteration < 4; iteration++) {
          const target = await html(`concurrent-delete-publication-${iteration}`, audience);
          const [deletion, publication]: [PromiseSettledResult<Awaited<ReturnType<typeof deletePersonalDashboardHtml>>>,
            PromiseSettledResult<Awaited<ReturnType<typeof activatePersonalDashboardHtml>>>] = await Promise.allSettled([
            deletePersonalDashboardHtml({ versionId: target.id, actorId: 'admin:integration-test', audience }),
            activatePersonalDashboardHtml({ versionId: target.id, expectedActiveVersionId: current.id, actorId: 'admin:integration-test', audience }),
          ]);
          assert.notEqual(deletion.status, publication.status, 'Exactly one competing operation succeeds');
          if (publication.status === 'fulfilled') {
            assert.ok(deletion.status === 'rejected');
            assert.equal(deletion.reason.code, 'ACTIVE_VERSION_CONFLICT');
            assert.equal((await getPersonalDashboardHtml(undefined, false, audience))?.id, target.id);
            await activatePersonalDashboardHtml({ versionId: current.id, expectedActiveVersionId: target.id, actorId: 'admin:integration-test', audience });
            await deletePersonalDashboardHtml({ versionId: target.id, actorId: 'admin:integration-test', audience });
          } else {
            assert.equal(publication.reason.code, 'NOT_FOUND');
            assert.equal(await getPersonalDashboardHtml(target.id, true, audience), null);
          }
          assert.equal((await getPersonalDashboardHtml(undefined, false, audience))?.id, current.id);
        }
      }
    });

    await t.test('published HTML stays available when an active manager has no snapshot or no unique email binding', async () => {
      const published = await getPersonalDashboardHtml();
      assert.ok(published, 'The previous test published a shared HTML version');
      const noSnapshot = await manager('empty-dashboard');
      assert.deepEqual(await getPersonalDashboardStatus(noSnapshot.id), {
        audience: 'development', snapshot: null, history: [], bindingStatus: 'matched',
      });
      assert.equal((await getPersonalDashboardHtml())?.id, published.id);
      assert.equal(await getPersonalDashboardSnapshot(noSnapshot.id), null);

      const owner = await manager('binding-overview-owner');
      const imported = await importFile(bytes(owner.email));
      assert.ok(imported.snapshotId);
      const snapshotId = imported.snapshotId;
      for (const blankEmail of ['', ' \t\u00a0\n']) {
        await query(`update wholesale_managers set email=$2 where id=$1`, [owner.id, blankEmail]);
        assert.deepEqual(await getPersonalDashboardStatus(owner.id), {
          audience: 'development', snapshot: null, history: [], bindingStatus: 'missing_email',
        });
        assert.equal((await getPersonalDashboardHtml())?.id, published.id);
        await assert.rejects(() => getPersonalDashboardSnapshot(owner.id, snapshotId), { code: 'NOT_FOUND' });
        await assert.rejects(() => getPersonalDashboardSnapshot(owner.id), { code: 'NOT_FOUND' });
      }

      await query(`update wholesale_managers set email=$2 where id=$1`, [owner.id, owner.email]);
      const duplicate = await manager('binding-overview-duplicate', 'manager', true, owner.email.toUpperCase());
      for (const recipient of [owner, duplicate]) {
        assert.deepEqual(await getPersonalDashboardStatus(recipient.id), {
          audience: 'development', snapshot: null, history: [], bindingStatus: 'ambiguous_email',
        });
        assert.equal((await getPersonalDashboardHtml())?.id, published.id);
        await assert.rejects(() => getPersonalDashboardSnapshot(recipient.id, snapshotId), { code: 'AMBIGUOUS_EMAIL' });
        await assert.rejects(() => getPersonalDashboardSnapshot(recipient.id), { code: 'AMBIGUOUS_EMAIL' });
      }

      await query(`update wholesale_managers set is_active=false where id=$1`, [duplicate.id]);
      const restored = await getPersonalDashboardStatus(owner.id);
      assert.equal(restored.bindingStatus, 'matched');
      assert.equal(restored.snapshot?.id, snapshotId);
      assert.ok(await getPersonalDashboardSnapshot(owner.id, snapshotId));
      await assert.rejects(() => getPersonalDashboardStatus(duplicate.id), { code: 'NOT_FOUND' });
      await query(`update wholesale_managers set email='',role='support_manager' where id=$1`, [owner.id]);
      assert.deepEqual(await getPersonalDashboardStatus(owner.id), {
        audience: 'support', snapshot: null, history: [], bindingStatus: 'missing_email',
      });
      await assert.rejects(() => getPersonalDashboardSnapshot(owner.id, snapshotId), { code: 'NOT_FOUND' });
    });

    await t.test('each accepted personal import keeps current and previous regardless of age', async () => {
      const recipient = await manager('retention');
      for (const offset of [-3, -2, -1]) assert.equal((await importFile(bytes(recipient.email, offset))).status, 'imported');
      await query(`update personal_dashboard_snapshots set received_at=now()-interval '15 days' where manager_id=$1`, [recipient.id]);
      assert.equal((await importFile(bytes(recipient.email))).status, 'imported');
      const state = await getPersonalDashboardStatus(recipient.id);
      assert.equal(state.history.length, 2);
      assert.equal(state.history[0].status, 'active');
      assert.equal(state.history[1].status, 'previous');
    });

    await t.test('personal history changes only with a committed import and protects the actual prior active snapshot', async () => {
      const recipient = await manager('legacy-history');
      const first = await importFile(bytes(recipient.email, -5));
      const active = await importFile(bytes(recipient.email, -4));
      const legacyBytes = bytes(recipient.email, -3, 42);
      const metadata = inspectPersonalSnapshot(legacyBytes, 'legacy.ktsp');
      const legacy = await query<{id: string}>(`insert into personal_dashboard_snapshots
        (manager_id,original_name,encrypted_payload,file_size,sha256,email_hash,person_name,person_role,issued,expires,source_key)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id::text`,
      [recipient.id, metadata.originalName, legacyBytes, metadata.fileSize, metadata.sha256, metadata.emailHash,
        metadata.name, metadata.role, metadata.issued, metadata.expires, randomUUID()]);
      const before = (await query(`select * from personal_dashboard_snapshots where manager_id=$1 order by id`, [recipient.id])).rows;
      const stateBefore = (await query(`select * from personal_dashboard_snapshot_state where manager_id=$1`, [recipient.id])).rows;
      assert.equal((await getPersonalDashboardStatus(recipient.id)).history.length, 3);
      assert.equal((await importFile(legacyBytes)).status, 'duplicate');
      assert.equal((await importFile(bytes(recipient.email, -6))).status, 'stale');
      assert.equal((await importFile(bytes(recipient.email, -4, 2))).status, 'conflict');
      assert.deepEqual((await query(`select * from personal_dashboard_snapshots where manager_id=$1 order by id`, [recipient.id])).rows, before);
      await query(`create function kts_test_reject_snapshot_retention() returns trigger language plpgsql as
        $$ begin raise exception 'synthetic retention failure'; end $$`);
      const sourceKey = randomUUID();
      try {
        await query(`create trigger kts_test_reject_snapshot_retention before delete on personal_dashboard_snapshots
          for each row execute function kts_test_reject_snapshot_retention()`);
        try {
          await assert.rejects(() => importFile(bytes(recipient.email, -2), sourceKey), {code: 'P0001'});
          assert.deepEqual((await query(`select * from personal_dashboard_snapshots where manager_id=$1 order by id`, [recipient.id])).rows, before);
          assert.deepEqual((await query(`select * from personal_dashboard_snapshot_state where manager_id=$1`, [recipient.id])).rows, stateBefore);
          assert.equal((await query(`select id from personal_dashboard_imports where source_key=$1`, [sourceKey])).rowCount, 0);
        } finally { await query(`drop trigger kts_test_reject_snapshot_retention on personal_dashboard_snapshots`); }
      } finally { await query(`drop function kts_test_reject_snapshot_retention()`); }
      const imported = await importFile(bytes(recipient.email, -2), sourceKey);
      assert.equal(imported.status, 'imported');
      const after = await getPersonalDashboardStatus(recipient.id);
      assert.deepEqual(after.history.map((item) => item.id), [imported.snapshotId, active.snapshotId]);
      assert.equal(await getPersonalDashboardSnapshot(recipient.id, first.snapshotId!), null);
      assert.equal(await getPersonalDashboardSnapshot(recipient.id, Number(legacy.rows[0].id)), null);
    });

    await t.test('ongoing imports never fill a history quota and preserve only the working pair', async () => {
      const recipient = await manager('continuous-import');
      for (let offset = -32; offset < 0; offset++) {
        assert.equal((await importFile(bytes(recipient.email, offset, offset + 40))).status, 'imported');
      }
      const before = await getPersonalDashboardStatus(recipient.id);
      assert.equal(before.history.length, 2);
      assert.equal((await importFile(bytes(recipient.email))).status, 'imported');
      const after = await getPersonalDashboardStatus(recipient.id);
      assert.equal(after.history.find((item) => item.status === 'previous')?.id, before.snapshot?.id);
      assert.equal(after.history.length, 2);
    });

    await t.test('transport failures are safe and visible in the administrator import journal', async () => {
      const result = await recordPersonalDashboardImportFailure({ filename: 'bad.ktsp', sourceKey: randomUUID(),
        code: 'arbitrary SMTP response with credentials must never enter the journal' });
      assert.equal(result.code, 'ATTACHMENT_FAILED');
      const overview = await listPersonalDashboardAdmin();
      assert.ok(overview.imports.some((item) => item.id === String(result.id) && item.code === 'ATTACHMENT_FAILED'));
      assert.equal(overview.groups.some((group) => group.managers.some((item) => 'bytes' in item)), false);
      assert.ok(overview.groups.every((group) => group.htmlVersions.every((item) => !('htmlContent' in item))));
      assert.equal('managers' in overview || 'htmlVersions' in overview, false);
    });

    await t.test('journal uses five-row BIGINT keyset pages across concurrent new deliveries', async () => {
      const prefix = `synthetic-pagination:${randomUUID()}:`;
      // Cross a decimal-width boundary as well as 2^53: ORDER BY id::text would misorder these.
      const largest = BigInt('10000000000000003');
      const ids = Array.from({ length: 13 }, (_, index) => String(largest - BigInt(index)));
      const newerId = String(largest + BigInt(1));
      const allKeys = [...ids, newerId].map((id) => `${prefix}${id}`);
      const insertRows = (values: string[]) => query(`insert into personal_dashboard_imports
        (id,source_key,original_name,status,code)
        select id,$2 || id::text,'synthetic-' || id::text || '.ktsp','invalid','INVALID_ATTACHMENT'
        from unnest($1::bigint[]) as item(id)`, [values, prefix]);
      try {
        await insertRows(ids);
        const overview = await listPersonalDashboardAdmin();
        assert.deepEqual(overview.imports.map((row) => row.id), ids.slice(0, 5));
        assert.equal(overview.importsNextCursor, ids[4]);
        const first = await listPersonalDashboardImports();
        assert.deepEqual(first, { imports: overview.imports, nextCursor: overview.importsNextCursor });
        await insertRows([newerId]);
        const second = await listPersonalDashboardImports(first.nextCursor);
        assert.deepEqual(second.imports.map((row) => row.id), ids.slice(5, 10));
        assert.equal(second.nextCursor, ids[9]);
        const third = await listPersonalDashboardImports(second.nextCursor);
        assert.deepEqual(third.imports.slice(0, 3).map((row) => row.id), ids.slice(10));
        const seen = [...first.imports, ...second.imports, ...third.imports].map((row) => row.id);
        assert.equal(new Set(seen).size, seen.length, 'BIGINT identities and page boundaries must not collide');
        assert.equal(seen.includes(newerId), false);
        assert.deepEqual(await listPersonalDashboardImports('1'), { imports: [], nextCursor: null });
      } finally {
        // Only explicitly named synthetic rows; preserve all other imports and their sequence.
        await query(`delete from personal_dashboard_imports where source_key=any($1::text[])`, [allKeys]);
      }
    });

    await t.test('durable mail receipts require committed success and preserve data while expiring metadata', async () => {
      const recipient = await manager('mail-checkpoint', 'support_manager');
      const key = `imap-part:v1:${createHash('sha256').update(randomUUID()).digest('hex')}`;
      const source = randomUUID();
      await recordPersonalDashboardMailReceipt(key, source);
      assert.equal(await getPersonalDashboardMailReceipt(key), null, 'no speculative checkpoint before successful import');
      const imported = await importFile(bytes(recipient.email), source);
      assert.equal(imported.status, 'imported');
      await recordPersonalDashboardMailReceipt(key, source);
      assert.deepEqual(await getPersonalDashboardMailReceipt(key), { managerId: recipient.id });
      const collision = await manager('mail-collision', 'manager', true, recipient.email);
      assert.equal(await getPersonalDashboardMailReceipt(key), null, 'ambiguous binding must not be skipped');
      const ambiguous = await listPersonalDashboardAdmin();
      for (const [audience, managerId] of [['development', collision.id], ['support', recipient.id]] as const) {
        const item = ambiguous.groups.find((group) => group.audience === audience)?.managers.find((entry) => entry.id === managerId);
        assert.equal(item?.bindingStatus, 'ambiguous');
        assert.equal(item?.snapshot, null);
        assert.equal((await getPersonalDashboardStatus(managerId)).bindingStatus, 'ambiguous_email');
      }
      await query(`update wholesale_managers set is_active=false where id=$1`, [collision.id]);
      assert.deepEqual(await getPersonalDashboardMailReceipt(key), { managerId: recipient.id });
      await query(`update wholesale_managers set role='manager' where id=$1`, [recipient.id]);
      assert.deepEqual(await getPersonalDashboardMailReceipt(key), { managerId: recipient.id }, 'A role change alone does not repeat a committed import');
      assert.equal((await getPersonalDashboardStatus(recipient.id)).audience, 'development');
      await query(`update wholesale_managers set role='top' where id=$1`, [recipient.id]);
      assert.equal(await getPersonalDashboardMailReceipt(key), null, 'A role outside both personal groups cannot use a receipt');
      await query(`update wholesale_managers set role='support_manager' where id=$1`, [recipient.id]);
      await query(`update personal_dashboard_mail_receipts set completed_at=now()-interval '31 days' where transport_key=$1`, [key]);
      await prunePersonalDashboardMailReceipts();
      assert.equal(await getPersonalDashboardMailReceipt(key), null);
      const preserved = await getPersonalDashboardStatus(recipient.id);
      assert.equal(preserved.snapshot?.id, imported.snapshotId, 'receipt cleanup never removes the saved snapshot');
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

    await t.test('HTML version quotas are atomic per audience and never discard existing publications', async () => {
      const before = await listPersonalDashboardAdmin();
      for (const audience of ['development', 'support'] as const) {
        const group = (await listPersonalDashboardAdmin()).groups.find((entry) => entry.audience === audience)!;
        for (let count = group.htmlVersions.length; count < 49; count++) await html(`quota-${audience}-${count}`, audience);
        const results = await Promise.allSettled([html(`quota-${audience}-last-a`, audience), html(`quota-${audience}-last-b`, audience)]);
        assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
        const rejected = results.find((result) => result.status === 'rejected');
        assert.ok(rejected && rejected.status === 'rejected');
        assert.equal(rejected.reason.code, 'HTML_QUOTA');
        const latest = (await listPersonalDashboardAdmin()).groups.find((entry) => entry.audience === audience)!;
        assert.equal(latest.htmlVersions.length, 50);
        assert.equal(latest.activeHtmlVersionId, before.groups.find((entry) => entry.audience === audience)!.activeHtmlVersionId);
        assert.equal(latest.previousHtmlVersionId, before.groups.find((entry) => entry.audience === audience)!.previousHtmlVersionId);
      }
    });
    await t.test('second shared support report is isolated, manually published, role protected and concurrency safe', async () => {
      const personalState = () => query(`select
        (select json_agg(v order by v.id) from personal_dashboard_html_versions v) as html,
        (select json_agg(st order by st.id) from personal_dashboard_html_state st) as html_state,
        (select json_agg(s order by s.id) from personal_dashboard_snapshots s) as snapshots,
        (select json_agg(st order by st.manager_id) from personal_dashboard_snapshot_state st) as snapshot_state,
        (select json_agg(i order by i.id) from personal_dashboard_imports i) as imports`);
      const before = (await personalState()).rows;
      const supportA = await manager('shared-a', 'support_manager', true, '');
      const supportB = await manager('shared-b', 'support_manager');
      const development = await manager('shared-denied-development');
      const inactive = await manager('shared-denied-inactive', 'support_manager', false);
      const sharedEmail = 'shared-report@example.test';
      const upload = (data: Buffer, expectedActiveSnapshotId: number | null, email = sharedEmail) => importSupportSharedDashboardSnapshot({
        filename: 'shared.ktsp', bytes: data, email, actorId: 'admin:integration-test', expectedActiveSnapshotId,
      });
      const uploadHtml = (label: string) => {
        const htmlContent = `<!doctype html><html><body>Shared ${label}<input id="fileInp"><script>
          let FILE=null; const emailHash='kts-personal'; function gate(){} function tryOpen(){} function decryptFile(){}</script></body></html>`;
        return createSupportSharedDashboardHtml({ originalName: `shared-${label}.html`, htmlContent,
          fileSize: Buffer.byteLength(htmlContent), sha256: createHash('sha256').update(htmlContent).digest('hex'), actorId: 'admin:integration-test' });
      };
      assert.equal((await getSupportSharedDashboardOverview()).snapshot, null);
      const firstHtml = await uploadHtml('first');
      const secondHtml = await uploadHtml('second');
      assert.deepEqual((await getSupportSharedDashboardOverview(supportA.id)).htmlVersions, []);
      assert.equal(await getSupportSharedDashboardHtml(firstHtml.id, false, supportA.id), null);
      assert.equal((await getSupportSharedDashboardHtml(firstHtml.id, true))?.id, firstHtml.id);

      const first = await upload(bytes(sharedEmail, -3), null, `  ${sharedEmail.toUpperCase()}  `);
      assert.equal(first.snapshot.email, sharedEmail);
      for (const viewer of [supportA, supportB]) {
        assert.equal((await getSupportSharedDashboardSnapshot(viewer.id))?.bytes.equals(bytes(sharedEmail, -3)), true);
        assert.equal((await getSupportSharedDashboardOverview(viewer.id)).snapshot?.id, first.snapshot.id);
      }
      assert.equal((await upload(bytes(sharedEmail, -3), null)).status, 'duplicate', 'Idempotent retry cannot overwrite newer state');
      await assert.rejects(() => upload(bytes(sharedEmail, -4), first.snapshot.id), { code: 'STALE_SNAPSHOT' });
      await assert.rejects(() => upload(bytes(sharedEmail, -3, 2), first.snapshot.id), { code: 'SAME_DAY_CONFLICT' });
      await assert.rejects(() => upload(bytes(sharedEmail), first.snapshot.id, 'wrong@example.test'), { code: 'EMAIL_MISMATCH' });

      const race = await Promise.allSettled([upload(bytes(sharedEmail, -2, 2), first.snapshot.id), upload(bytes(sharedEmail, -2, 3), first.snapshot.id)]);
      assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
      const rejected = race.find((result) => result.status === 'rejected');
      assert.ok(rejected?.status === 'rejected');
      assert.equal(rejected.reason.code, 'STATE_CONFLICT');
      const secondId = (await getSupportSharedDashboardOverview()).snapshot!.id;
      const duplicates = await Promise.all([upload(bytes(sharedEmail, -1), secondId), upload(bytes(sharedEmail, -1), secondId)]);
      assert.deepEqual(duplicates.map((result) => result.status).sort(), ['duplicate', 'imported']);
      const thirdId = duplicates[0].snapshot.id;
      assert.equal((await getSupportSharedDashboardOverview()).history.length, 2);
      assert.equal(await getSupportSharedDashboardSnapshot(supportB.id, first.snapshot.id), null);

      for (const denied of [development, inactive]) {
        await assert.rejects(() => getSupportSharedDashboardOverview(denied.id), { code: 'NOT_FOUND' });
        await assert.rejects(() => getSupportSharedDashboardHtml(undefined, false, denied.id), { code: 'NOT_FOUND' });
        await assert.rejects(() => getSupportSharedDashboardSnapshot(denied.id), { code: 'NOT_FOUND' });
      }
      await query(`update wholesale_managers set role='manager' where id=$1`, [supportB.id]);
      await assert.rejects(() => getSupportSharedDashboardOverview(supportB.id), { code: 'NOT_FOUND' });
      await query(`update wholesale_managers set role='support_manager',is_active=false where id=$1`, [supportB.id]);
      await assert.rejects(() => getSupportSharedDashboardSnapshot(supportB.id), { code: 'NOT_FOUND' });
      await query(`update wholesale_managers set is_active=true where id=$1`, [supportB.id]);

      await activateSupportSharedDashboardHtml({ versionId: firstHtml.id, expectedActiveVersionId: null, actorId: 'admin:integration-test' });
      assert.deepEqual((await getSupportSharedDashboardOverview(supportA.id)).htmlVersions.map((version) => version.id), [firstHtml.id]);
      const publishRace = await Promise.allSettled([
        activateSupportSharedDashboardHtml({ versionId: secondHtml.id, expectedActiveVersionId: firstHtml.id, actorId: 'admin:integration-test' }),
        activateSupportSharedDashboardHtml({ versionId: secondHtml.id, expectedActiveVersionId: firstHtml.id, actorId: 'admin:integration-test' }),
      ]);
      assert.equal(publishRace.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(await getSupportSharedDashboardHtml(firstHtml.id, false, supportA.id), null);
      assert.equal((await getSupportSharedDashboardHtml(undefined, false, supportA.id))?.id, secondHtml.id);
      assert.equal((await getSupportSharedDashboardOverview(supportA.id)).previousHtmlVersionId, null);
      await assert.rejects(() => deleteSupportSharedDashboardHtml({ versionId: secondHtml.id, actorId: 'admin:integration-test' }), { code: 'ACTIVE_VERSION_CONFLICT' });
      await deleteSupportSharedDashboardHtml({ versionId: firstHtml.id, actorId: 'admin:integration-test' });
      assert.equal((await getSupportSharedDashboardOverview()).previousHtmlVersionId, null);
      assert.equal((await getSupportSharedDashboardOverview()).snapshot!.id, thirdId);

      await query(`update support_shared_dashboard_snapshots set expires=$2 where id=$1`, [secondId, day(-1)]);
      await assert.rejects(() => getSupportSharedDashboardSnapshot(supportA.id, secondId), { code: 'EXPIRED' });
      const originalThird = bytes(sharedEmail, -1);
      await query(`update support_shared_dashboard_snapshots set encrypted_payload=$2 where id=$1`, [thirdId, Buffer.alloc(originalThird.length)]);
      await assert.rejects(() => getSupportSharedDashboardSnapshot(supportA.id), { code: 'SNAPSHOT_INTEGRITY' });
      await query(`update support_shared_dashboard_snapshots set encrypted_payload=$2 where id=$1`, [thirdId, originalThird]);

      await query(`update support_shared_dashboard_snapshots set received_at=now()-interval '31 days'`);
      const snapshotStateBefore = (await query(`select * from support_shared_dashboard_state`)).rows;
      const snapshotsBefore = (await query(`select * from support_shared_dashboard_snapshots order by id`)).rows;
      await query(`create function kts_test_reject_shared_retention() returns trigger language plpgsql as
        $$ begin raise exception 'synthetic retention failure'; end $$`);
      try {
        await query(`create trigger kts_test_reject_shared_retention before delete on support_shared_dashboard_snapshots
          for each row execute function kts_test_reject_shared_retention()`);
        try {
          await assert.rejects(() => upload(bytes(sharedEmail), thirdId), {code: 'P0001'});
          assert.deepEqual((await query(`select * from support_shared_dashboard_state`)).rows, snapshotStateBefore);
          assert.deepEqual((await query(`select * from support_shared_dashboard_snapshots order by id`)).rows, snapshotsBefore);
        } finally { await query(`drop trigger kts_test_reject_shared_retention on support_shared_dashboard_snapshots`); }
      } finally { await query(`drop function kts_test_reject_shared_retention()`); }
      const latest = await upload(bytes(sharedEmail), thirdId);
      const retained = await getSupportSharedDashboardOverview();
      assert.equal(retained.snapshot?.id, latest.snapshot.id);
      assert.deepEqual(retained.history.map((item) => item.id), [latest.snapshot.id, thirdId]);
      assert.equal(retained.history[1].status, 'previous', 'Retain the previous working copy regardless of age');
      assert.equal(await getSupportSharedDashboardSnapshot(supportA.id, first.snapshot.id), null);

      for (let count = retained.htmlVersions.length; count < 49; count++) await uploadHtml(`quota-${count}`);
      const quotaRace = await Promise.allSettled([uploadHtml('quota-last-a'), uploadHtml('quota-last-b')]);
      assert.equal(quotaRace.filter((result) => result.status === 'fulfilled').length, 1);
      const quotaRejected = quotaRace.find((result) => result.status === 'rejected');
      assert.ok(quotaRejected?.status === 'rejected');
      assert.equal(quotaRejected.reason.code, 'HTML_QUOTA');
      assert.equal((await getSupportSharedDashboardOverview()).htmlVersions.length, 50);
      assert.equal((await getSupportSharedDashboardOverview()).activeHtmlVersionId, secondHtml.id);
      assert.deepEqual((await personalState()).rows, before, 'Shared report writes and retention must preserve every personal HTML, snapshot, state and import');
    });
    await t.test('route planner JSON binds exact HTML, streams verified private bytes, preserves KTSP, and serializes CAS/retention', async () => {
      const storageDirectory = await mkdtemp(path.join(tmpdir(), 'kts-shared-json-db-'));
      const previousDirectory = process.env.TOP_DASHBOARD_DATA_DIR;
      process.env.TOP_DASHBOARD_DATA_DIR = storageDirectory;
      const preserved = async () => (await query(`select
        (select json_agg(s order by s.id) from personal_dashboard_snapshots s) as personal,
        (select json_agg(s order by s.id) from support_shared_dashboard_snapshots s) as shared_ktsp`)).rows;
      const before = await preserved();
      try {
        const overview = await getSupportSharedDashboardOverview();
        const legacyHtmlId = overview.activeHtmlVersionId!;
        assert.equal(overview.htmlVersions.every((version) => version.format === 'ktsp'), true);
        assert.deepEqual(overview.jsonHistory, []);
        assert.equal(overview.jsonSnapshot, null);
        for (const draft of overview.htmlVersions.filter((version) => version.id !== legacyHtmlId).slice(0, 2)) {
          await deleteSupportSharedDashboardHtml({versionId: draft.id, actorId: 'admin:integration-test'});
        }
        const plannerHtml = async (label: string) => {
          const htmlContent = `<html><body>${label}<input id="snapIn"><script>
            function loadSnapshot(j){S.orders=revive(j.orders)} function handleFiles(list){}
            window.UI={}; const example={app:'компоновщик'};</script></body></html>`;
          return createSupportSharedDashboardHtml({originalName: 'planner.html', htmlContent, fileSize: Buffer.byteLength(htmlContent),
            sha256: createHash('sha256').update(htmlContent).digest('hex'), actorId: 'admin:integration-test'});
        };
        const firstHtml = await plannerHtml('first');
        const secondHtml = await plannerHtml('second');
        assert.equal(firstHtml.format, 'route-planner-v1');
        assert.equal(await getSupportSharedDashboardJsonPreviewMetadata(firstHtml.id), null, 'A draft without JSON has no preview data');
        assert.equal(await getSupportSharedDashboardJsonPreviewMetadata(legacyHtmlId), null, 'KTSP stays outside JSON preview');
        const support = await manager('json-support', 'support_manager', true, '');
        const developer = await manager('json-development');
        await assert.rejects(() => assertSupportSharedJsonUploadTarget(firstHtml.id, null), {code: 'STATE_CONFLICT'});
        await activateSupportSharedDashboardHtml({versionId: firstHtml.id, expectedActiveVersionId: legacyHtmlId, actorId: 'admin:integration-test'});
        await assertSupportSharedJsonUploadTarget(firstHtml.id, null);
        const source = (number: number) => Buffer.from(JSON.stringify({snapshot: true, app: 'компоновщик',
          savedAt: new Date(Date.UTC(2026, 8, 17, 5, number)).toISOString(), orders: [{id: `synthetic-${number}`}],
          confirmed: [], zones: [], addrs: [], aliases: {}, contacts: [], tk: [], nomen: [], depots: [],
          opt: {maxPoints: 8, maxWeight: 1000, maxVol: 10, innerKm: 5, splitByOrg: false, splitByWh: true}, winding: 1, rate: 1,
          f: {from: '', to: '', ordFrom: '', ordTo: '', zone: [], org: [], dir: [], wh: [], author: [], onlyConfirmed: false}, files: [], diag: {}}));
        const upload = async (number: number, expectedActiveSnapshotId: number | null, htmlVersionId = firstHtml.id, deferCleanup = false) => {
          const body = gzipSync(source(number));
          const prepared = await prepareSupportSharedRoutePlannerUpload(new Request('http://localhost/synthetic', {
            method: 'POST', headers: {'content-type': 'application/gzip'}, body,
          }));
          const storagePath = await prepared.pending.commit();
          try {
            const result = await importSupportSharedDashboardJson({htmlVersionId, expectedActiveSnapshotId, originalName: 'synthetic.json',
              savedAt: prepared.savedAt, fileSize: prepared.pending.fileSize, sha256: prepared.pending.sha256, storagePath, actorId: 'admin:integration-test'});
            if (result.status === 'imported') prepared.pending.preserve();
            if (!deferCleanup) await deleteTopDashboardDataFiles(result.prunedStoragePaths);
            return {...result, storagePath};
          } finally { await prepared.pending.discard(); }
        };
        const first = await upload(1, null);
        assert.equal(first.status, 'imported');
        assert.equal((await getSupportSharedDashboardJsonPreviewMetadata(firstHtml.id))?.id, first.snapshot.id);
        const preview = await getSupportSharedDashboardJsonPreviewSnapshot(firstHtml.id, first.snapshot.id);
        assert.ok(preview);
        assert.equal(await new Response(Readable.toWeb(preview.stream) as ReadableStream<Uint8Array>).text(), source(1).toString());
        const read = await getSupportSharedDashboardJsonSnapshot(support.id, firstHtml.id);
        assert.ok(read);
        assert.equal(await new Response(Readable.toWeb(read.stream) as ReadableStream<Uint8Array>).text(), source(1).toString());
        assert.equal(read.htmlVersionId, firstHtml.id);
        const firstStoredPath = path.join(storageDirectory, first.storagePath);
        await writeFile(firstStoredPath, Buffer.alloc(source(1).length));
        await assert.rejects(() => getSupportSharedDashboardJsonSnapshot(support.id, firstHtml.id), {code: 'SNAPSHOT_INTEGRITY'});
        await assert.rejects(() => getSupportSharedDashboardJsonPreviewSnapshot(firstHtml.id), {code: 'SNAPSHOT_INTEGRITY'});
        await writeFile(firstStoredPath, source(1));
        assert.equal((await getSupportSharedDashboardOverview(support.id)).jsonSnapshot?.id, first.snapshot.id);
        await assert.rejects(() => getSupportSharedDashboardJsonSnapshot(developer.id, firstHtml.id), {code: 'NOT_FOUND'});
        await query(`update wholesale_managers set is_active=false where id=$1`, [support.id]);
        await assert.rejects(() => getSupportSharedDashboardJsonSnapshot(support.id, firstHtml.id), {code: 'NOT_FOUND'});
        await query(`update wholesale_managers set is_active=true where id=$1`, [support.id]);
        assert.equal((await upload(1, first.snapshot.id)).status, 'duplicate');
        await assert.rejects(() => upload(0, first.snapshot.id), {code: 'STALE_SNAPSHOT'});
        const raced = await Promise.allSettled([upload(2, first.snapshot.id), upload(3, first.snapshot.id)]);
        assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
        const failed = raced.find((result) => result.status === 'rejected');
        assert.ok(failed?.status === 'rejected');
        assert.equal(failed.reason.code, 'STATE_CONFLICT');
        let active = (await getSupportSharedDashboardOverview()).jsonSnapshot!.id;
        const duplicateRace = await Promise.all([upload(4, active), upload(4, active)]);
        assert.deepEqual(duplicateRace.map((result) => result.status).sort(), ['duplicate', 'imported']);
        active = duplicateRace[0].snapshot.id;
        for (const number of [5, 6, 7]) active = (await upload(number, active)).snapshot.id;
        const jsonStateBefore = (await query(`select * from support_shared_dashboard_json_state order by html_version_id`)).rows;
        const jsonRowsBefore = (await query<{storage_path: string}>(`select * from support_shared_dashboard_json_snapshots order by id`)).rows;
        await query(`create function kts_test_reject_json_retention() returns trigger language plpgsql as
          $$ begin raise exception 'synthetic retention failure'; end $$`);
        try {
          await query(`create trigger kts_test_reject_json_retention before delete on support_shared_dashboard_json_snapshots
            for each row execute function kts_test_reject_json_retention()`);
          try {
            await assert.rejects(() => upload(8, active), {code: 'P0001'});
            assert.deepEqual((await query(`select * from support_shared_dashboard_json_state order by html_version_id`)).rows, jsonStateBefore);
            assert.deepEqual((await query(`select * from support_shared_dashboard_json_snapshots order by id`)).rows, jsonRowsBefore);
            for (const row of jsonRowsBefore) await access(path.join(storageDirectory, row.storage_path));
          } finally { await query(`drop trigger kts_test_reject_json_retention on support_shared_dashboard_json_snapshots`); }
        } finally { await query(`drop function kts_test_reject_json_retention()`); }
        const outboxBefore = (await query(`select * from dashboard_file_cleanup_queue order by storage_path`)).rows;
        await query(`create function kts_test_reject_cleanup_outbox() returns trigger language plpgsql as
          $$ begin raise exception 'synthetic cleanup outbox failure'; end $$`);
        try {
          await query(`create trigger kts_test_reject_cleanup_outbox before insert on dashboard_file_cleanup_queue
            for each row execute function kts_test_reject_cleanup_outbox()`);
          try {
            await assert.rejects(() => upload(8, active), {code: 'P0001'});
            assert.deepEqual((await query(`select * from support_shared_dashboard_json_state order by html_version_id`)).rows, jsonStateBefore);
            assert.deepEqual((await query(`select * from support_shared_dashboard_json_snapshots order by id`)).rows, jsonRowsBefore);
            assert.deepEqual((await query(`select * from dashboard_file_cleanup_queue order by storage_path`)).rows, outboxBefore);
            for (const row of jsonRowsBefore) await access(path.join(storageDirectory, row.storage_path));
          } finally { await query(`drop trigger kts_test_reject_cleanup_outbox on dashboard_file_cleanup_queue`); }
        } finally { await query(`drop function kts_test_reject_cleanup_outbox()`); }
        // Simulate process exit immediately after COMMIT: the caller never enqueues filesystem markers.
        const deferred = await upload(8, active, firstHtml.id, true);
        active = deferred.snapshot.id;
        assert.ok(deferred.prunedStoragePaths.length);
        assert.deepEqual((await query<{storage_path: string}>(`select storage_path from dashboard_file_cleanup_queue
          where storage_path=any($1::text[]) order by storage_path`, [deferred.prunedStoragePaths])).rows.map((row) => row.storage_path),
        [...deferred.prunedStoragePaths].sort());
        for (const storagePath of deferred.prunedStoragePaths) await access(path.join(storageDirectory, storagePath));
        await drainDashboardFileCleanup(storageDirectory);
        assert.equal((await query(`select storage_path from dashboard_file_cleanup_queue where storage_path=any($1::text[])`, [deferred.prunedStoragePaths])).rowCount, 0);
        for (const storagePath of deferred.prunedStoragePaths) await assert.rejects(access(path.join(storageDirectory, storagePath)), {code: 'ENOENT'});
        const retained = await getSupportSharedDashboardOverview();
        assert.equal(retained.jsonHistory.length, 2);
        assert.equal(retained.jsonHistory[0].status, 'active');
        assert.equal(retained.jsonHistory[1].status, 'previous');
        assert.equal(await getSupportSharedDashboardJsonPreviewSnapshot(firstHtml.id, retained.jsonHistory[1].id), null,
          'Preview pins only the current JSON, not a previous snapshot');
        assert.equal(await getSupportSharedDashboardJsonSnapshot(support.id, firstHtml.id, first.snapshot.id), null);
        await assert.rejects(() => access(path.join(storageDirectory, first.storagePath)), {code: 'ENOENT'});

        // Reserve synthetic metadata only to exercise the global byte cap without allocating a GiB.
        const reserved = await query<{id: string}>(`insert into support_shared_dashboard_json_snapshots
          (html_version_id,original_name,file_size,sha256,storage_path,saved_at,uploaded_by)
          select $1,'quota-fixture.json',104857600,lpad(n::text,64,'0'),
            '00/' || lpad(n::text,64,'0') || '-00000000-0000-0000-0000-000000000000.bin',now(),'admin:integration-test'
          from generate_series(1,11) n returning id::text`, [secondHtml.id]);
        try {
          await assert.rejects(() => upload(9, active), {code: 'SNAPSHOT_QUOTA'});
          assert.equal((await getSupportSharedDashboardOverview()).jsonSnapshot!.id, active);
          assert.equal((await getSupportSharedDashboardOverview()).jsonHistory.length, 2);
        } finally {
          await query(`delete from support_shared_dashboard_json_snapshots where id=any($1::bigint[])`, [reserved.rows.map((row) => row.id)]);
        }

        await activateSupportSharedDashboardHtml({versionId: secondHtml.id, expectedActiveVersionId: firstHtml.id, actorId: 'admin:integration-test'});
        assert.equal((await getSupportSharedDashboardOverview()).jsonSnapshot, null);
        assert.equal(await getSupportSharedDashboardJsonPreviewMetadata(secondHtml.id), null, 'A new HTML never borrows archived version data');
        assert.equal((await getSupportSharedDashboardJsonPreviewMetadata(firstHtml.id))?.id, active, 'Archived HTML retains its own active JSON for preview');
        const archivedPreview = await getSupportSharedDashboardJsonPreviewSnapshot(firstHtml.id, active);
        assert.ok(archivedPreview);
        assert.equal(await new Response(Readable.toWeb(archivedPreview.stream) as ReadableStream<Uint8Array>).text(), source(8).toString());
        await assert.rejects(() => getSupportSharedDashboardJsonSnapshot(support.id, firstHtml.id, active), {code: 'STATE_CONFLICT'});
        assert.equal(await getSupportSharedDashboardJsonSnapshot(support.id, secondHtml.id, active), null);
        const second = await upload(10, null, secondHtml.id);
        assert.equal(await getSupportSharedDashboardJsonPreviewSnapshot(firstHtml.id, second.snapshot.id), null);
        assert.equal(await getSupportSharedDashboardJsonPreviewSnapshot(secondHtml.id, active), null);
        await assert.rejects(() => query(`update support_shared_dashboard_json_state set active_snapshot_id=$2 where html_version_id=$1`, [firstHtml.id, second.snapshot.id]), {code: '23503'});
        await activateSupportSharedDashboardHtml({versionId: firstHtml.id, expectedActiveVersionId: secondHtml.id, actorId: 'admin:integration-test'});
        assert.equal((await getSupportSharedDashboardOverview()).jsonSnapshot?.id, active, 'HTML rollback recovers only its own JSON');
        await deleteSupportSharedDashboardHtml({versionId: secondHtml.id, actorId: 'admin:integration-test'});
        assert.equal(await getSupportSharedDashboardJsonPreviewMetadata(secondHtml.id), null);
        assert.equal(await getSupportSharedDashboardJsonPreviewSnapshot(secondHtml.id, second.snapshot.id), null);
        await assert.rejects(() => access(path.join(storageDirectory, second.storagePath)), {code: 'ENOENT'});
        const firstRemainingFiles = (await query<{storage_path: string}>(`select storage_path from support_shared_dashboard_json_snapshots where html_version_id=$1`, [firstHtml.id])).rows;
        const thirdHtml = await plannerHtml('third');
        const fourthHtml = await plannerHtml('fourth');
        const retainedDraftIds = (await getSupportSharedDashboardOverview()).htmlVersions.filter((version) => version.status === 'draft'
          && version.id !== thirdHtml.id && version.id !== fourthHtml.id).map((version) => version.id);
        await activateSupportSharedDashboardHtml({versionId: thirdHtml.id, expectedActiveVersionId: firstHtml.id, actorId: 'admin:integration-test'});
        const third = await upload(11, null, thirdHtml.id);
        assert.equal((await getSupportSharedDashboardJsonPreviewMetadata(firstHtml.id))?.id, active);
        for (const file of firstRemainingFiles) await access(path.join(storageDirectory, file.storage_path));
        await activateSupportSharedDashboardHtml({versionId: firstHtml.id, expectedActiveVersionId: thirdHtml.id, actorId: 'admin:integration-test'});
        assert.equal((await getSupportSharedDashboardOverview()).jsonSnapshot?.id, active);
        await activateSupportSharedDashboardHtml({versionId: fourthHtml.id, expectedActiveVersionId: firstHtml.id, actorId: 'admin:integration-test'});
        assert.equal(await getSupportSharedDashboardJsonPreviewMetadata(thirdHtml.id), null);
        assert.equal((await query(`select id from support_shared_dashboard_json_snapshots where html_version_id=$1`, [thirdHtml.id])).rowCount, 0);
        await assert.rejects(() => access(path.join(storageDirectory, third.storagePath)), {code: 'ENOENT'});
        assert.equal((await getSupportSharedDashboardJsonPreviewMetadata(firstHtml.id))?.id, active);
        assert.deepEqual((await getSupportSharedDashboardOverview()).htmlVersions.filter((version) => version.status === 'draft').map((version) => version.id), retainedDraftIds);
        await assert.rejects(() => activateSupportSharedDashboardHtml({versionId: legacyHtmlId, expectedActiveVersionId: fourthHtml.id, actorId: 'admin:integration-test'}), {code: 'NOT_FOUND'});
        const replacementLegacyContent = '<!doctype html><html><input id="fileInp"><script>let FILE=null; const emailHash="kts-personal"; function gate(){} function tryOpen(){} function decryptFile(){}</script></html>';
        const replacementLegacy = await createSupportSharedDashboardHtml({originalName: 'new-ktsp.html', htmlContent: replacementLegacyContent,
          fileSize: Buffer.byteLength(replacementLegacyContent), sha256: createHash('sha256').update(replacementLegacyContent).digest('hex'), actorId: 'admin:integration-test'});
        await activateSupportSharedDashboardHtml({versionId: replacementLegacy.id, expectedActiveVersionId: fourthHtml.id, actorId: 'admin:integration-test'});
        const legacy = await getSupportSharedDashboardOverview();
        assert.equal(legacy.jsonSnapshot, null);
        assert.deepEqual(legacy.jsonHistory, []);
        assert.equal(legacy.snapshot?.id, overview.snapshot?.id);
        assert.equal(await getSupportSharedDashboardJsonPreviewMetadata(firstHtml.id), null);
        for (const file of firstRemainingFiles) await assert.rejects(() => access(path.join(storageDirectory, file.storage_path)), {code: 'ENOENT'});
        assert.deepEqual(await preserved(), before);
      } finally {
        if (previousDirectory === undefined) delete process.env.TOP_DASHBOARD_DATA_DIR;
        else process.env.TOP_DASHBOARD_DATA_DIR = previousDirectory;
        await rm(storageDirectory, {recursive: true, force: true});
      }
    });
  } finally {
    await globalThis.__ktsPgPool?.end();
    globalThis.__ktsPgPool = undefined;
  }
});
