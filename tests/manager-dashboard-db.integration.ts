/** Explicit isolated PostgreSQL test only; never run with application/production credentials.
 * Run through scripts/test-personal-dashboard-postgres.sh (isolated local Unix socket only).
 * node --import tsx --test tests/manager-dashboard-db.integration.ts
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { query, withTransaction } from '../src/shared/lib/db/client';
import { applyPersonalDashboardAudienceMigration } from '../src/shared/lib/db/migrations';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import {
  activatePersonalDashboardHtml, createPersonalDashboardHtml, deletePersonalDashboardHtml, getPersonalDashboardHtml,
  getPersonalDashboardSnapshot, getPersonalDashboardStatus, importPersonalDashboardSnapshot,
  listPersonalDashboardAdmin, listPersonalDashboardImports, recordPersonalDashboardImportFailure,
} from '../src/shared/lib/db/managerDashboardRepo';
import { getManagerEmailHash, personalDashboardToday } from '../src/shared/lib/managerDashboardDomain';
import type { PersonalDashboardAudience } from '../src/shared/lib/managerDashboardAudience';
import { getPersonalDashboardMailReceipt, recordPersonalDashboardMailReceipt, prunePersonalDashboardMailReceipts } from '../src/shared/lib/db/managerDashboardMailReceipts';
import {
  activateSupportSharedDashboardHtml, createSupportSharedDashboardHtml, deleteSupportSharedDashboardHtml,
  getSupportSharedDashboardHtml, getSupportSharedDashboardOverview, getSupportSharedDashboardSnapshot,
  importSupportSharedDashboardSnapshot,
} from '../src/shared/lib/db/supportSharedDashboardRepo';

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
        const htmlContent = `<!doctype html><html><body>Shared ${label}</body></html>`;
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
      assert.equal((await getSupportSharedDashboardOverview()).history.length, 3);
      assert.equal((await getSupportSharedDashboardSnapshot(supportB.id, first.snapshot.id))?.id, first.snapshot.id);

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

      await query(`update support_shared_dashboard_snapshots set expires=$2 where id=$1`, [first.snapshot.id, day(-1)]);
      await assert.rejects(() => getSupportSharedDashboardSnapshot(supportA.id, first.snapshot.id), { code: 'EXPIRED' });
      const originalThird = bytes(sharedEmail, -1);
      await query(`update support_shared_dashboard_snapshots set encrypted_payload=$2 where id=$1`, [thirdId, Buffer.alloc(originalThird.length)]);
      await assert.rejects(() => getSupportSharedDashboardSnapshot(supportA.id), { code: 'SNAPSHOT_INTEGRITY' });
      await query(`update support_shared_dashboard_snapshots set encrypted_payload=$2 where id=$1`, [thirdId, originalThird]);

      await query(`update support_shared_dashboard_snapshots set received_at=now()-interval '31 days'`);
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
  } finally {
    await globalThis.__ktsPgPool?.end();
    globalThis.__ktsPgPool = undefined;
  }
});
