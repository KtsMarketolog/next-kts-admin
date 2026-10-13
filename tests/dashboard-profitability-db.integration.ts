/** Synthetic data only. The exact V19 profile is tested separately against the supplied HTML. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { mock } from 'node:test';
import type { AdminSessionRole } from '../src/shared/lib/adminAuth';
import type { TopDashboardSnapshotFormat } from '../src/shared/lib/db/topDashboardDomain';
import type { ProfitabilityAuditRequest, ProfitabilityInvoice } from '../src/shared/lib/dashboardProfitabilityAudit';
import { MAX_PROFITABILITY_AUDIT_BODY } from '../src/shared/lib/dashboardProfitabilityAudit';
import { createAccessUser } from '../src/shared/lib/db/adminUsersRepo';
import { createStoredAdminSession, getStoredAdminSession } from '../src/shared/lib/db/adminSessionsRepo';
import { query } from '../src/shared/lib/db/client';
import { DASHBOARD_USAGE_RETENTION_CUTOFF_SQL, listDashboardUsage, recordDashboardUsage, pruneExpiredDashboardUsage } from '../src/shared/lib/db/dashboardUsageRepo';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';

function guard() {
  assert.equal(process.env.KTS_USAGE_TEST, '1');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_usage_integration');
  assert.equal(url.username, 'usage_app');
  for (const [key] of url.searchParams) assert.ok(['host', 'port'].includes(key));
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-usage-postgres\.[A-Za-z0-9]+\/socket$/);
}

const SUPPORTED_HTML = '<!doctype html><html><body>Synthetic invoice report only</body></html>';
const invoice: ProfitabilityInvoice = {
  schemaVersion: 1, documentType: 'invoice', invoiceNumber: 'Тест-123/09', currency: 'USD',
  dealAmount: 125.43, amountSource: 'document',
  lines: [{ nomenclature: 'Синтетическая позиция 1', quantity: 2.5 }, { nomenclature: 'Возврат позиции 2', quantity: -0.125 }],
};

async function employee(role: AdminSessionRole, dashboardAccess: string[], manage = false) {
  const user = await createAccessUser({ name: `Synthetic audit ${role}`, login: `profitability-${randomUUID()}`,
    email: '', role, isActive: true, passwordHash: 'synthetic-test-hash-not-a-credential',
    canManageTopDashboard: manage, dashboardAccess });
  const manager = role === 'manager' || role === 'support_manager';
  const stored = await createStoredAdminSession({ role, ...(manager ? { managerId: user.numericId } : { adminUserId: user.numericId }) });
  const session = (await getStoredAdminSession(stored.token))!;
  assert.ok(session);
  return { user, stored, session };
}

async function htmlVersion(blockId: number, html = SUPPORTED_HTML, active = true) {
  const result = await query<{ id: string }>(`insert into top_dashboard_block_versions
    (block_id,original_name,html_content,file_size,sha256) values ($1,'synthetic.html',$2,$3,$4) returning id::text`,
  [blockId, html, Buffer.byteLength(html), createHash('sha256').update(html).digest('hex')]);
  const id = Number(result.rows[0].id);
  if (active) await query('update top_dashboard_block_state set active_version_id=$2 where block_id=$1', [blockId, id]);
  return id;
}

test('profitability details isolated PostgreSQL acceptance', async (t) => {
  guard();
  // This test-only loader substitution never changes production profile detection.
  // It permits wholly synthetic invoices/HTML while exercising real SQL and ACL.
  const profile = {
    isSupportedProfitabilityHtml: (html: string) => html === SUPPORTED_HTML,
    isProfitabilityHtmlCandidate: (html: string) => html === SUPPORTED_HTML || html.includes('Unreviewed invoice version'),
  };
  const moduleMock = mock.module('../src/shared/lib/dashboardProfitabilityHtml.ts', {
    namedExports: profile, defaultExport: profile,
  });
  try {
    const { recordDashboardProfitabilityAudit: record, readDashboardProfitabilityAudit: read, ProfitabilityAuditError } =
      await import('../src/shared/lib/db/dashboardProfitabilityAuditRepo');
    const { createTopDashboardBlock, isActiveTopDashboardHtmlVersion, getPublishedTopDashboardBlocks,
      getPublishedTopDashboardBlockOverview, getPublishedTopDashboardBlockVersionContent,
      activateTopDashboardBlockVersion, createAndActivateTopDashboardBlockDataVersion,
      activateTopDashboardBlockDataVersion, getActiveTopDashboardBlockDataContent, getTopDashboardBlockOverview } =
      await import('../src/shared/lib/db/topDashboardBlocksRepo');
    const { TopDashboardDataCompatibilityError, TopDashboardStateConflictError } =
      await import('../src/shared/lib/db/topDashboardDomain');
    const forbidden = (error: unknown) => error instanceof ProfitabilityAuditError && error.status === 403;
    const conflict = (error: unknown) => error instanceof ProfitabilityAuditError && error.status === 409;
    await ensureSiteSchema();
    const block = await createTopDashboardBlock({ title: 'Synthetic profitability report', createdByAdminUserId: null, createdByManagerId: null });
    const secondBlock = await createTopDashboardBlock({ title: 'Other synthetic invoice report', createdByAdminUserId: null, createdByManagerId: null });
    const key = `top:${block.id}`;
    const secondKey = `top:${secondBlock.id}`;
    const versionId = await htmlVersion(block.id);
    const draftId = await htmlVersion(block.id, SUPPORTED_HTML, false);
    const secondVersionId = await htmlVersion(secondBlock.id);
    const purchaser = await employee('purchaser', [key, secondKey]);
    const other = await employee('purchaser', [key]);
    const manager = await employee('manager', [key]);
    const support = await employee('support_manager', [key]);
    const wholesale = await employee('wholesale_admin', [key]);
    const top = await employee('top', [key]);
    const topWithoutGrant = await employee('top', []);
    const adminTop = await employee('admintop', []);
    const admin = await employee('admin', []);
    const managementTop = await employee('top', [], true);
    const input = (overrides: Partial<ProfitabilityAuditRequest> = {}): ProfitabilityAuditRequest => ({
      eventId: randomUUID(), dashboardKey: key, versionId, preview: false, invoice, ...overrides,
    });
    const count = async () => Number((await query('select count(*)::text as count from dashboard_profitability_audit_details')).rows[0].count);
    let acceptedId = '';

    const publishLocal = (blockId: number, versionId: number, expectedActiveVersionId: number | null) =>
      activateTopDashboardBlockVersion({ blockId, versionId, expectedActiveVersionId,
        expectedSnapshotFormat: null, expectedProfile: 'profitability', adminUserId: admin.user.numericId, managerId: null });

    await t.test('normal publication admits exact local-only V19 without any shared data, retaining CAS and catalog readiness', async () => {
      const item = await createTopDashboardBlock({ title: 'Synthetic normal V19 publication', createdByAdminUserId: null, createdByManagerId: null });
      const target = await htmlVersion(item.id, SUPPORTED_HTML, false);
      const rejected = await htmlVersion(item.id, '<input type="file" id="fInv">Unreviewed invoice version', false);
      await assert.rejects(publishLocal(item.id, rejected, null), TopDashboardDataCompatibilityError);
      await assert.rejects(activateTopDashboardBlockVersion({ blockId: item.id, versionId: rejected, expectedActiveVersionId: null,
        expectedSnapshotFormat: 'multi-file-v1', expectedProfile: 'generic', adminUserId: admin.user.numericId, managerId: null }),
      TopDashboardDataCompatibilityError);
      await assert.rejects(activateTopDashboardBlockVersion({ blockId: item.id, versionId: target, expectedActiveVersionId: null,
        expectedSnapshotFormat: 'multi-file-v1', expectedProfile: 'generic', adminUserId: admin.user.numericId, managerId: null }),
      TopDashboardDataCompatibilityError);
      assert.equal((await getTopDashboardBlockOverview(item.id)).activeVersionId, null);
      const published = await publishLocal(item.id, target, null);
      assert.equal(published.change, 'published');
      assert.equal(published.activeVersionId, target);
      assert.deepEqual(published.prunedStoragePaths, []);
      assert.equal((await publishLocal(item.id, target, target)).change, 'unchanged');
      await assert.rejects(publishLocal(item.id, rejected, null), TopDashboardStateConflictError);
      const overview = await getPublishedTopDashboardBlockOverview(item.id);
      assert.equal(overview?.activeVersionId, target);
      assert.equal(overview?.dataUploadedAt, null);
      assert.ok((await getPublishedTopDashboardBlocks()).some(row => row.id === item.id));
      assert.equal((await getPublishedTopDashboardBlockVersionContent(item.id, target))?.htmlContent, SUPPORTED_HTML);
      assert.equal(await getActiveTopDashboardBlockDataContent(item.id, target), null);
      assert.equal((await query('select count(*)::int as count from top_dashboard_block_data_context_state where block_id=$1', [item.id])).rows[0].count, 0);
    });

    for (const kind of ['generic', 'native'] as const) {
      await t.test(`local-only publication hides ${kind} shared data and rollback restores its exact saved pair`, async () => {
        const item = await createTopDashboardBlock({ title: `Synthetic ${kind} rollback`, createdByAdminUserId: null, createdByManagerId: null });
        const generic = kind === 'generic';
        const originalHtml = generic ? '<input id="files" type="file">'
          : '<script>const DASH_NAME="аналитика_продаж"; const data={format:"kts-bundle",version:1};</script>';
        const expectedSnapshotFormat = generic ? 'multi-file-v1' as const : 'kts-bundle-v1' as const;
        const expectedProfile = generic ? 'generic' as const : 'sales-analytics' as const;
        const original = await htmlVersion(item.id, originalHtml, false);
        const target = await htmlVersion(item.id, SUPPORTED_HTML, false);
        const actor = { adminUserId: admin.user.numericId, managerId: null };
        await activateTopDashboardBlockVersion({ blockId: item.id, versionId: original, expectedActiveVersionId: null,
          expectedSnapshotFormat, expectedProfile, ...actor });
        const input = (previous: number | null, label: string) => {
          const content = Buffer.from(label);
          return { blockId: item.id, expectedActiveHtmlVersionId: original, expectedActiveVersionId: previous,
            expectedHtmlSnapshotFormat: expectedSnapshotFormat, expectedHtmlProfile: expectedProfile,
            originalName: `${label}.bin`, content, storagePath: null, fileSize: content.length, uncompressedSize: content.length,
            sha256: createHash('sha256').update(content).digest('hex'), snapshotFormat: expectedSnapshotFormat,
            dashboardProfile: expectedProfile, boundHtmlVersionId: generic ? original : null,
            uploadedByAdminUserId: admin.user.numericId, uploadedByManagerId: null };
        };
        const a = await createAndActivateTopDashboardBlockDataVersion(input(null, 'first'));
        const b = await createAndActivateTopDashboardBlockDataVersion(input(a.version.id, 'second'));
        // The selected older snapshot must win over chronological upload order on rollback.
        await activateTopDashboardBlockDataVersion({ blockId: item.id, expectedActiveHtmlVersionId: original,
          versionId: a.version.id, expectedActiveVersionId: b.version.id,
          expectedHtmlSnapshotFormat: expectedSnapshotFormat, expectedHtmlProfile: expectedProfile, ...actor });
        const before = (await getTopDashboardBlockOverview(item.id)).data;
        const result = await publishLocal(item.id, target, original);
        assert.deepEqual(result.prunedStoragePaths, []);
        const local = await getTopDashboardBlockOverview(item.id);
        assert.equal(local.previousVersionId, original);
        assert.equal(local.data.activeVersionId, null);
        assert.equal(local.data.previousVersionId, null);
        assert.equal(await getActiveTopDashboardBlockDataContent(item.id, target), null);
        await assert.rejects(createAndActivateTopDashboardBlockDataVersion({ ...input(null, 'must-not-share'),
          expectedActiveHtmlVersionId: target, expectedHtmlSnapshotFormat: null as unknown as TopDashboardSnapshotFormat, expectedHtmlProfile: 'profitability',
          boundHtmlVersionId: generic ? target : null }), TopDashboardDataCompatibilityError);
        await assert.rejects(activateTopDashboardBlockDataVersion({ blockId: item.id, expectedActiveHtmlVersionId: target,
          versionId: a.version.id, expectedActiveVersionId: null,
          expectedHtmlSnapshotFormat: null as unknown as TopDashboardSnapshotFormat, expectedHtmlProfile: 'profitability', ...actor }), TopDashboardDataCompatibilityError);
        const rollback = await activateTopDashboardBlockVersion({ blockId: item.id, versionId: original,
          expectedActiveVersionId: target, expectedSnapshotFormat, expectedProfile, ...actor });
        assert.equal(rollback.change, 'rolled_back');
        assert.deepEqual(rollback.prunedStoragePaths, []);
        const restored = (await getTopDashboardBlockOverview(item.id)).data;
        assert.equal(restored.activeVersionId, before.activeVersionId);
        assert.equal(restored.previousVersionId, before.previousVersionId);
        assert.deepEqual(restored.versions, before.versions);
        assert.equal((await getActiveTopDashboardBlockDataContent(item.id, original))?.id, a.version.id);
        // Defensive handling of legacy/manual states must not leave private HTML
        // pointing at an unrelated native shared snapshot even on an idempotent call.
        await query(`update top_dashboard_block_state set active_version_id=$2,previous_version_id=$3 where block_id=$1`,
          [item.id, target, original]);
        assert.equal((await publishLocal(item.id, target, target)).change, 'unchanged');
        const detached = await getTopDashboardBlockOverview(item.id);
        assert.equal(detached.previousVersionId, original);
        assert.equal(detached.data.activeVersionId, null);
        assert.equal(detached.data.previousVersionId, null);
        assert.equal(await getActiveTopDashboardBlockDataContent(item.id, target), null);
        await activateTopDashboardBlockVersion({ blockId: item.id, versionId: original,
          expectedActiveVersionId: target, expectedSnapshotFormat, expectedProfile, ...actor });
        const secondRestored = (await getTopDashboardBlockOverview(item.id)).data;
        assert.equal(secondRestored.activeVersionId, before.activeVersionId);
        assert.equal(secondRestored.previousVersionId, before.previousVersionId);
        assert.deepEqual(secondRestored.versions, before.versions);
      });
    }

    await t.test('migration increases TOP HTML to 20 MiB, not personal HTML limits', async () => {
      const accepted = await query<{ id: string }>(`insert into top_dashboard_block_versions
        (block_id,original_name,html_content,file_size,sha256)
        values ($1,'synthetic-20mb.html',repeat(' ',20971520),20971520,$2) returning id::text`, [block.id, '0'.repeat(64)]);
      await query('delete from top_dashboard_block_versions where block_id=$1 and id=$2', [block.id, accepted.rows[0].id]);
      await assert.rejects(query(`insert into top_dashboard_block_versions
        (block_id,original_name,html_content,file_size,sha256) values ($1,'too-big.html','x',20971521,$2)`, [block.id, '0'.repeat(64)]),
      /top_dashboard_block_versions_file_size_check/);
      const personal = await query(`select pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid='personal_dashboard_html_versions'::regclass and conname like '%file_size%'`);
      assert.ok(personal.rows.some((row) => row.definition.includes('5242880')));
    });

    await t.test('active self-contained HTML accepts invoices with authenticated actor and server date', async () => {
      assert.equal(await isActiveTopDashboardHtmlVersion(block.id, versionId), true);
      assert.equal(await isActiveTopDashboardHtmlVersion(block.id, draftId), false);
      assert.equal(await isActiveTopDashboardHtmlVersion(secondBlock.id, versionId), false);
      assert.equal((await query('select active_version_id from top_dashboard_block_data_state where block_id=$1', [block.id])).rows[0].active_version_id, null);
      const started = Date.now();
      acceptedId = (await record(purchaser.session, input())).id;
      const stored = (await query('select * from dashboard_usage_events where id=$1', [acceptedId])).rows[0];
      assert.equal(stored.actor_key, `admin:${purchaser.user.numericId}`);
      assert.equal(stored.actor_role, 'purchaser');
      assert.equal(stored.action, 'data_loaded');
      assert.equal(stored.is_preview, false);
      assert.equal(Number(stored.html_version_id), versionId);
      assert.ok(new Date(stored.created_at).getTime() >= started - 1000);
      assert.ok(new Date(stored.created_at).getTime() <= Date.now() + 1000);
      for (const reader of [admin.session, adminTop.session, top.session, topWithoutGrant.session]) {
        assert.deepEqual(await read(reader, acceptedId), invoice);
      }
      const listed = (await listDashboardUsage({ dashboardKey: key })).events.find((row) => row.id === acceptedId)!;
      assert.equal(listed.hasProfitabilityDetails, true);
      assert.equal(Object.hasOwn(listed, 'invoice'), false);
      assert.equal(JSON.stringify(listed).includes(invoice.invoiceNumber!), false);
      assert.equal(await read(admin.session, '9223372036854775808'), null);
      assert.equal(await read(admin.session, '0'), null);
    });

    await t.test('successful invoice file metadata persists on its single usage event and is immutable on retry', async () => {
      const request = input({ upload: { name: 'Синтетический-счёт.pdf', size: 12345 } });
      const event = await record(purchaser.session, request);
      const details = (await query('select upload_name,upload_size from dashboard_usage_event_details where usage_event_id=$1', [event.id])).rows;
      assert.equal(details.length, 1); assert.equal(details[0].upload_name, request.upload!.name); assert.equal(Number(details[0].upload_size), 12345);
      assert.equal((await record(purchaser.session, request)).id, event.id);
      await assert.rejects(record(purchaser.session, {...request, upload: {...request.upload!,name:'different.pdf'}}), conflict);
      const {upload: _upload, ...legacyRequest} = request;
      void _upload;
      await assert.rejects(record(purchaser.session, legacyRequest), conflict);
      assert.deepEqual(await read(admin.session,event.id), invoice);
    });

    await t.test('published catalog and readers admit only the exact supported self-contained profile without data', async () => {
      const ordinary = await createTopDashboardBlock({ title: 'Synthetic ordinary report', createdByAdminUserId: null, createdByManagerId: null });
      const ordinaryVersion = await htmlVersion(ordinary.id, '<html>Ordinary standalone HTML is not eligible</html>');
      await query('update top_dashboard_block_versions set original_name=$2 where block_id=$1', [ordinary.id, 'рентабельность_сделок_v19.html']);
      const catalog = await getPublishedTopDashboardBlocks();
      assert.ok(catalog.some((row) => row.id === block.id));
      assert.ok(catalog.some((row) => row.id === secondBlock.id));
      assert.ok(!catalog.some((row) => row.id === ordinary.id));
      const overview = await getPublishedTopDashboardBlockOverview(block.id);
      assert.equal(overview?.activeVersionId, versionId);
      assert.equal(overview?.dataUploadedAt, null);
      assert.equal((await getPublishedTopDashboardBlockVersionContent(block.id, versionId))?.htmlContent, SUPPORTED_HTML);
      assert.equal(await getPublishedTopDashboardBlockVersionContent(block.id, draftId), null);
      assert.equal(await getPublishedTopDashboardBlockVersionContent(secondBlock.id, versionId), null);
      assert.equal(await getPublishedTopDashboardBlockOverview(ordinary.id), null);
      assert.equal(await getPublishedTopDashboardBlockVersionContent(ordinary.id, ordinaryVersion), null);
    });

    await t.test('same-actor retries are idempotent including concurrency; mismatches never overwrite details', async () => {
      const event = input();
      const before = await count();
      const writes = await Promise.all(Array.from({ length: 8 }, () => record(purchaser.session, event)));
      assert.equal(new Set(writes.map((item) => item.id)).size, 1);
      assert.equal(await count(), before + 1);
      const reordered = { lines: invoice.lines, amountSource: invoice.amountSource, dealAmount: invoice.dealAmount,
        currency: invoice.currency, invoiceNumber: invoice.invoiceNumber, documentType: invoice.documentType, schemaVersion: invoice.schemaVersion };
      assert.equal((await record(purchaser.session, { ...event, invoice: reordered })).id, writes[0].id);
      await assert.rejects(record(purchaser.session, { ...event, invoice: { ...invoice, currency: 'EUR' } }), conflict);
      await assert.rejects(record(purchaser.session, { ...event, dashboardKey: secondKey, versionId: secondVersionId }), conflict);
      assert.deepEqual(await read(admin.session, writes[0].id), invoice);
      assert.notEqual((await record(other.session, event)).id, writes[0].id, 'Identical client IDs from different actors stay separate');

      const race = input();
      const competing = await Promise.allSettled([
        record(purchaser.session, race),
        record(purchaser.session, { ...race, invoice: { ...invoice, currency: 'CNY' } }),
      ]);
      assert.equal(competing.filter((item) => item.status === 'fulfilled').length, 1);
      const rejected = competing.find((item) => item.status === 'rejected') as PromiseRejectedResult;
      assert.ok(conflict(rejected.reason));
    });

    await t.test('generic events cannot be retrofitted with invoice details or extended with financial values', async () => {
      const event = input();
      await recordDashboardUsage(purchaser.session, { dashboardKey: key, preview: false, versionId,
        events: [{ id: event.eventId, action: 'data_loaded' }] });
      const before = await count();
      await assert.rejects(record(purchaser.session, event), conflict);
      assert.equal(await count(), before);
      const generic = (await query('select id::text from dashboard_usage_events where actor_key=$1 and event_id=$2',
        [`admin:${purchaser.user.numericId}`, event.eventId])).rows[0];
      assert.equal(await read(admin.session, generic.id), null);
      assert.equal((await listDashboardUsage({ dashboardKey: key })).events.find((row) => row.id === generic.id)?.hasProfitabilityDetails, false);
      await assert.rejects(record(purchaser.session, { ...input(), actorKey: 'admin:primary' } as ProfitabilityAuditRequest), /Некорректная детализация/);
      await assert.rejects(record(purchaser.session, input({ invoice: { ...invoice, dealAmount: Infinity } })), /Некорректная детализация/);
    });

    await t.test('report grants permit collection, not journal reading; preview remains management-only', async () => {
      for (const viewer of [manager.session, support.session, wholesale.session, top.session]) await record(viewer, input());
      for (const viewer of [purchaser.session, manager.session, support.session, wholesale.session]) {
        await assert.rejects(read(viewer, acceptedId), forbidden);
        await assert.rejects(record(viewer, input({ preview: true, versionId: draftId })), forbidden);
      }
      await assert.rejects(record(topWithoutGrant.session, input()), forbidden);
      await assert.rejects(record(purchaser.session, input({ versionId: draftId })), forbidden);
      await assert.rejects(record(admin.session, input({ versionId: draftId })), forbidden, 'Non-preview means currently active even for admins');
      for (const editor of [admin.session, adminTop.session, managementTop.session]) {
        const preview = await record(editor, input({ preview: true, versionId: draftId }));
        assert.equal((await query('select is_preview from dashboard_usage_events where id=$1', [preview.id])).rows[0].is_preview, true);
      }
      const envStored = await createStoredAdminSession({ role: 'admin' });
      const envAdmin = (await getStoredAdminSession(envStored.token))!;
      const envEvent = await record(envAdmin, input());
      assert.equal((await query('select actor_key from dashboard_usage_events where id=$1', [envEvent.id])).rows[0].actor_key, 'admin:primary');
      assert.deepEqual(await read(envAdmin, envEvent.id), invoice);
    });

    await t.test('unsupported HTML, cross-block IDs and fabricated sessions never collect financial fields', async () => {
      const before = await count();
      const unsupportedId = await htmlVersion(block.id, '<html>Ordinary sales report, not the reviewed app</html>', false);
      await assert.rejects(record(admin.session, input({ preview: true, versionId: unsupportedId })), forbidden);
      await assert.rejects(record(admin.session, input({ preview: true, dashboardKey: secondKey })), forbidden);
      await assert.rejects(record({ ...purchaser.session, sessionId: randomUUID() }, input()), forbidden);
      await assert.rejects(record({ ...purchaser.session, sessionId: undefined }, input()), forbidden);
      await assert.rejects(record({ ...purchaser.session, role: 'admin' }, input()), forbidden);
      await assert.rejects(read({ ...top.session, sessionId: randomUUID() }, acceptedId), forbidden);
      assert.equal(await count(), before);
    });

    await t.test('persisted revocation, deactivation, password changes and session expiry override stale sessions', async () => {
      await query('delete from dashboard_view_grants where admin_user_id=$1 and key=$2', [other.user.numericId, key]);
      await assert.rejects(record(other.session, input()), forbidden);
      await query('insert into dashboard_view_grants(admin_user_id,key) values ($1,$2)', [other.user.numericId, key]);
      await record(other.session, input());
      await query('update admin_users set is_active=false where id=$1', [other.user.numericId]);
      await assert.rejects(record(other.session, input()), forbidden);
      await query('update admin_users set is_active=true,password_changed_at=now()+interval \'1 second\' where id=$1', [other.user.numericId]);
      await assert.rejects(record(other.session, input()), forbidden);
      await query('update admin_users set password_changed_at=null where id=$1', [other.user.numericId]);
      await query('update admin_sessions set expires_at=now()-interval \'1 second\' where id=$1', [other.session.sessionId]);
      await assert.rejects(record(other.session, input()), forbidden);
      await query('update admin_sessions set revoked_at=now() where id=$1', [topWithoutGrant.session.sessionId]);
      await assert.rejects(read(topWithoutGrant.session, acceptedId), forbidden);
    });

    await t.test('parent event and details roll back together after a storage failure', async () => {
      await query(`create function synthetic_reject_profitability_details() returns trigger language plpgsql as $$
        begin if NEW.invoice->>'invoiceNumber'='synthetic-forced-failure' then
          raise exception 'synthetic invoice insertion failure'; end if; return NEW; end $$;
        create trigger synthetic_reject_profitability before insert on dashboard_profitability_audit_details
        for each row execute function synthetic_reject_profitability_details()`);
      const event = input({ invoice: { ...invoice, invoiceNumber: 'synthetic-forced-failure' } });
      try {
        await assert.rejects(record(purchaser.session, event), /synthetic invoice insertion failure/);
        assert.equal((await query('select count(*)::int as count from dashboard_usage_events where event_id=$1', [event.eventId])).rows[0].count, 0);
      } finally {
        await query('drop trigger synthetic_reject_profitability on dashboard_profitability_audit_details; drop function synthetic_reject_profitability_details()');
      }
      const retried = await record(purchaser.session, event);
      assert.equal((await read(admin.session, retried.id))?.invoiceNumber, 'synthetic-forced-failure');
    });

    await t.test('original-currency quote values, unknown amount and missing number are preserved without invention', async () => {
      const quote: ProfitabilityInvoice = { ...invoice, documentType: 'quote', invoiceNumber: null,
        currency: 'RUB', dealAmount: null, amountSource: 'unavailable' };
      const quoteEvent = await record(purchaser.session, input({ invoice: quote }));
      assert.deepEqual(await read(admin.session, quoteEvent.id), quote);
      const foreign = { ...invoice, currency: 'CNY', dealAmount: -1234.5678, amountSource: 'lines' as const };
      assert.deepEqual(await read(admin.session, (await record(purchaser.session, input({ invoice: foreign }))).id), foreign);
    });

    await t.test('valid near-limit UTF-8 invoices fit despite PostgreSQL JSON formatting spaces', async () => {
      const large = input({ invoice: { ...invoice, lines: Array.from({ length: 1000 }, () => ({ nomenclature: 'Я'.repeat(500), quantity: 1 })) } });
      let remaining = MAX_PROFITABILITY_AUDIT_BODY - Buffer.byteLength(JSON.stringify(large), 'utf8') - 1;
      assert.ok(remaining > 0);
      for (const line of large.invoice.lines) {
        const extra = Math.min(remaining, 500);
        line.nomenclature = '界'.repeat(extra) + 'Я'.repeat(500 - extra);
        remaining -= extra;
        if (!remaining) break;
      }
      assert.equal(Buffer.byteLength(JSON.stringify(large), 'utf8'), MAX_PROFITABILITY_AUDIT_BODY - 1);
      const event = await record(purchaser.session, large);
      const stored = await read(admin.session, event.id);
      assert.equal(stored?.lines.length, 1000);
      assert.deepEqual(stored?.lines[0], large.invoice.lines[0]);
      const textSize = Number((await query('select octet_length(invoice::text)::text as bytes from dashboard_profitability_audit_details where usage_event_id=$1', [event.id])).rows[0].bytes);
      assert.ok(textSize > MAX_PROFITABILITY_AUDIT_BODY, 'Postgres formatting consumes the reserved storage-only overhead');
    });

    await t.test('employee and report deletion preserve accepted audit until the monthly expiry', async () => {
      await query('delete from admin_users where id=$1', [purchaser.user.numericId]);
      await query('delete from top_dashboard_block_state where block_id=$1', [block.id]);
      await query('delete from top_dashboard_blocks where id=$1', [block.id]);
      assert.deepEqual(await read(admin.session, acceptedId), invoice);
      const row = (await listDashboardUsage({ dashboardKey: key })).events.find((item) => item.id === acceptedId)!;
      assert.equal(row.actorName, `admin:${purchaser.user.numericId}`);
      assert.equal(row.dashboardTitle, key);
      assert.equal(row.hasProfitabilityDetails, true);
    });

    await t.test('monthly expiry hides details immediately and cascades through bounded parent cleanup', async () => {
      const before = await count();
      const actor = 'admin:888888888';
      await query(`insert into dashboard_usage_events(actor_key,actor_role,dashboard_key,event_id,action,created_at)
        select $1,'top',$2,'profitability-expired-'||lpad(i::text,8,'0'),'data_loaded',
          (${DASHBOARD_USAGE_RETENTION_CUTOFF_SQL})-interval '1 minute' from generate_series(1,10005) as i`, [actor, secondKey]);
      await query(`insert into dashboard_usage_events(actor_key,actor_role,dashboard_key,event_id,action,created_at)
        values ($1,'top',$2,'profitability-retained-current','data_loaded',now()),
          ($1,'top',$2,'profitability-retained-boundary','data_loaded',(${DASHBOARD_USAGE_RETENTION_CUTOFF_SQL})+interval '1 minute')`, [actor, secondKey]);
      await query(`insert into dashboard_profitability_audit_details(usage_event_id,invoice,payload_sha256)
        select id,$2::jsonb,$3 from dashboard_usage_events where actor_key=$1`, [actor, JSON.stringify(invoice), 'a'.repeat(64)]);
      const expiredId = (await query('select id::text from dashboard_usage_events where actor_key=$1 order by id limit 1', [actor])).rows[0].id;
      assert.equal(await read(admin.session, expiredId), null);
      assert.equal((await listDashboardUsage({ actorKey: actor })).events.length, 2);
      assert.equal(await count(), before + 10007);
      const first = await pruneExpiredDashboardUsage();
      assert.equal(first.deleted, 10000);
      assert.equal(first.remaining, true);
      assert.equal(await count(), before + 7);
      const second = await pruneExpiredDashboardUsage();
      assert.equal(second.deleted, 5);
      assert.equal(second.remaining, false);
      assert.equal(await count(), before + 2);
      assert.equal((await query(`select count(*)::int as count from dashboard_profitability_audit_details details
        left join dashboard_usage_events event on event.id=details.usage_event_id where event.id is null`)).rows[0].count, 0);
      assert.deepEqual(await read(admin.session, acceptedId), invoice, 'Unexpired accepted invoices are unchanged');
    });
  } finally {
    moduleMock.restore();
    await globalThis.__ktsPgPool?.end();
    globalThis.__ktsPgPool = undefined;
  }
});
