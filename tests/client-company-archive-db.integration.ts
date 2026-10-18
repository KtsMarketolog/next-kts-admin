/** Synthetic acceptance only. Run via scripts/test-client-company-archive-postgres.sh. */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { AdminSession } from '../src/shared/lib/adminAuth';
import { readClientDocumentFile, saveClientDocumentUpload } from '../src/shared/lib/clientDocumentStorage';
import { query, withTransaction } from '../src/shared/lib/db/client';
import {
  ClientArchiveConflictError, createClientCompany, deleteClientCompany, getClientCompanies,
  getClientPortalProfile, getClientUserByLogin, restoreClientCompany, updateClientCompany,
  updateClientCompanyManagerAssignments,
} from '../src/shared/lib/db/clientCompaniesRepo';
import type { ClientCompanyInput } from '../src/shared/lib/db/clientCompanyTypes';
import {
  createClientChatMessageForAdmin, createClientChatMessageForClient, getClientChatConversationForAdmin,
} from '../src/shared/lib/db/clientChatRepo';
import { createClientDocument, deleteClientDocument, getClientDocumentsForAdmin } from '../src/shared/lib/db/clientDocumentsRepo';
import { processClientDocumentCleanup } from '../src/shared/lib/db/clientDocumentCleanupRepo';
import { createClientPriceRequest } from '../src/shared/lib/db/clientPriceRequestsRepo';
import { createStoredClientSession, getStoredClientSession } from '../src/shared/lib/db/clientSessionsRepo';
import { getClientCompanyDeletionPreview, purgeArchivedClientCompany } from '../src/shared/lib/db/clientArchivePurgeRepo';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import { lockPriceListCompany } from '../src/shared/lib/db/wholesaleAdminRepo/priceListCompanyWrite';
import { scryptSync } from 'node:crypto';

function guard() {
  assert.equal(process.env.KTS_CLIENT_ARCHIVE_TEST, '1');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_client_archive_integration');
  assert.equal(url.username, 'archive_app');
  assert.equal(url.password, '');
  for (const [key] of url.searchParams) assert.ok(['host', 'port'].includes(key));
  const socket = url.searchParams.get('host') ?? '';
  assert.match(socket, /^\/(?:private\/)?tmp\/kts-client-archive-postgres\.[A-Za-z0-9]+\/socket$/);
  assert.equal(url.searchParams.get('port'), '55483');
  assert.equal(process.env.UPLOAD_DIR, socket.replace(/\/socket$/, '/uploads'));
}

const admin: AdminSession = { role: 'admin' };
let sequence = 0;
const syntheticPassword = 'SyntheticArchivePassword123!';
const syntheticSalt = 'd'.repeat(32);
const syntheticHash = `scrypt:${syntheticSalt}:${scryptSync(syntheticPassword, syntheticSalt, 64).toString('hex')}`;
function input(): ClientCompanyInput {
  return {
    title: `Synthetic archive client ${++sequence}`, inn: '', kpp: '', contactName: '',
    email: `archive-${sequence}@example.test`, phone: '', address: '', note: 'Preserve this note',
    managerId: null, supportManagerId: null, requireTwoFactor: false, isActive: true,
    passwordHash: syntheticHash, displayPassword: syntheticPassword,
  };
}

async function preservedState(companyId: number) {
  return (await query(`select
    (select json_agg(row_to_json(u) order by u.id) from client_users u where company_id=$1) as users,
    (select json_agg(row_to_json(m) order by m.id) from client_chat_messages m where company_id=$1) as messages,
    (select row_to_json(r) from client_chat_read_state r where company_id=$1) as reads,
    (select json_agg(row_to_json(d) order by d.id) from client_documents d where company_id=$1) as documents,
    (select json_agg(row_to_json(r) order by r.id) from client_price_requests r where company_id=$1) as requests,
    (select json_agg(row_to_json(p) order by p.id) from wholesale_price_lists p where client_company_id=$1) as prices,
    (select json_agg(row_to_json(i) order by i.id) from wholesale_price_list_items i
      join wholesale_price_lists p on p.id=i.price_list_id where p.client_company_id=$1) as items`, [companyId])).rows[0];
}

test('client archive keeps related data, revokes access and never sweeps files', { timeout: 180_000 }, async (t) => {
  guard();
  try {
    assert.equal((await query("select to_regclass('public.client_companies')::text as present")).rows[0].present, null);
    await ensureSiteSchema();
    const role = (await query('select rolsuper,rolcreatedb,rolcreaterole from pg_roles where rolname=current_user')).rows[0];
    assert.deepEqual(role, { rolsuper: false, rolcreatedb: false, rolcreaterole: false });
    const managerRows = await query<{ id: string }>(`insert into wholesale_managers (login,name,email,role)
      values ('archive-manager','Synthetic manager','manager@example.test','manager'),
      ('archive-support','Synthetic support','support@example.test','support_manager') returning id::text`);
    const managerId = Number(managerRows.rows[0].id);
    const supportManagerId = Number(managerRows.rows[1].id);
    const originalInput = { ...input(), managerId, supportManagerId };
    let company = await createClientCompany(originalInput, admin);
    const firstUpdatedAt = company.updatedAt;
    assert.ok(company.clientUserId);
    const clientSession = { clientUserId: company.clientUserId, companyId: company.id };
    const stored = await createStoredClientSession(clientSession);
    assert.ok(await getStoredClientSession(stored.token));
    await createClientChatMessageForAdmin(company.id, admin, 'Retain employee message');
    await createClientChatMessageForClient(clientSession, 'Retain client message');
    await getClientChatConversationForAdmin(company.id, admin);
    const savedFile = await saveClientDocumentUpload(company.id, new File(['synthetic retained bytes'], 'retained.txt'));
    const document = await createClientDocument(company.id, { ...savedFile, title: 'Retained document', isVisible: true }, admin);
    const product = (await query<{ id: string }>(`insert into wholesale_products (title,sku)
      values ('Preserved product','ARCHIVE-SKU') returning id::text`)).rows[0];
    const price = (await query<{ id: string }>(`insert into wholesale_price_lists
      (title,client_company_id,client_name,manager_id,support_manager_id,token)
      values ('Preserved price',$1,$2,$3,$4,'synthetic-archive-public-price') returning id::text`,
    [company.id, company.title, managerId, supportManagerId])).rows[0];
    await query(`insert into wholesale_price_list_items
      (price_list_id,wholesale_product_id,custom_wholesale_price,discount_percent,visible,snapshot_product_title)
      values ($1,$2,123.45,7.5,true,'Preserved settings')`, [price.id, product.id]);
    const requestInput = {
      companyId: company.id, priceListId: Number(price.id), token: 'synthetic-archive-public-price',
      priceTitle: 'Preserved price', clientName: company.title, managerId, supportManagerId,
      comment: 'Retain request', totalQuantity: 2, totalPriceLabel: '246.90 RUB', totalConvertedRub: 246.9,
      rubConversionInfo: '', convertedBreakdownLabel: '', items: [],
    };
    await createClientPriceRequest(requestInput);

    await t.test('archiving preserves users, prices/items, correspondence, requests, document rows and actual bytes', async () => {
      const before = await preservedState(company.id);
      const cleanupCount = (await query('select count(*)::int as count from client_document_file_cleanup')).rows[0].count;
      company = await deleteClientCompany(company.id, admin, company.updatedAt);
      assert.ok(company.archivedAt);
      assert.equal(company.isActive, false);
      assert.deepEqual(await preservedState(company.id), before);
      assert.equal((await readClientDocumentFile(savedFile.filePath)).toString(), 'synthetic retained bytes');
      assert.equal((await query('select count(*)::int as count from client_document_file_cleanup')).rows[0].count, cleanupCount);
      assert.equal(await getStoredClientSession(stored.token), null);
      assert.equal((await getClientUserByLogin(originalInput.email))?.companyIsActive, false);
      assert.equal(await getClientPortalProfile(clientSession.clientUserId), null);
      await assert.rejects(createStoredClientSession(clientSession), /архиве|отключена/);
      assert.ok(!(await getClientCompanies(admin)).some((row) => row.id === company.id));
      assert.ok((await getClientCompanies(admin, 'archived')).some((row) => row.id === company.id));
      assert.ok((await getClientCompanies(admin, 'all')).some((row) => row.id === company.id));
    });

    await t.test('archived reads remain available without mutating read state; writes and stale forms are refused', async () => {
      const before = await preservedState(company.id);
      assert.equal((await getClientDocumentsForAdmin(company.id, admin))[0].id, document.id);
      assert.equal((await getClientChatConversationForAdmin(company.id, admin)).messages.length, 2);
      await assert.rejects(updateClientCompany(company.id, { ...originalInput, expectedUpdatedAt: firstUpdatedAt, title: 'Stale change', isActive: true }, admin), /архиве/);
      await assert.rejects(updateClientCompanyManagerAssignments(company.id, { managerId, supportManagerId }, admin), /архиве/);
      await assert.rejects(createClientChatMessageForAdmin(company.id, admin, 'Forbidden'), /архиве/);
      await assert.rejects(createClientChatMessageForClient(clientSession, 'Forbidden'), /архиве|отключена/);
      await assert.rejects(createClientDocument(company.id, { ...savedFile, title: 'Forbidden', isVisible: true }, admin), /архиве/);
      await assert.rejects(deleteClientDocument(company.id, document.id, admin), /архиве/);
      await assert.rejects(withTransaction((client) => lockPriceListCompany(client, company.id, { managerId, supportManagerId }, admin)), /Клиент/);
      assert.deepEqual(await preservedState(company.id), before);
      // Public prices retain their contract and append history even when their company is archived.
      await createClientPriceRequest({ ...requestInput, comment: 'Request from still-active public link' });
      assert.equal((await query('select count(*)::int as count from client_price_requests where company_id=$1', [company.id])).rows[0].count, 2);
    });

    await t.test('database constraint forbids activating an archived company', async () => {
      await assert.rejects(query('update client_companies set is_active=true where id=$1', [company.id]), { code: '23514' });
      assert.equal((await getClientUserByLogin(originalInput.email))?.companyIsActive, false);
      await assert.rejects(createStoredClientSession(clientSession), /архиве|отключена/);
    });

    await t.test('restore is explicit and keeps login disabled until separate activation; old sessions never revive', async () => {
      await assert.rejects(restoreClientCompany(company.id, admin, '2000-01-01'), ClientArchiveConflictError);
      company = await restoreClientCompany(company.id, admin, company.updatedAt);
      assert.equal(company.archivedAt, null);
      assert.equal(company.isActive, false);
      await assert.rejects(createStoredClientSession(clientSession), /отключена/);
      assert.equal(await getStoredClientSession(stored.token), null);
      await assert.rejects(updateClientCompany(company.id, { ...originalInput, expectedUpdatedAt: firstUpdatedAt }, admin), ClientArchiveConflictError);
      company = await updateClientCompany(company.id, { ...originalInput, expectedUpdatedAt: company.updatedAt, passwordHash: undefined, displayPassword: undefined }, admin);
      assert.equal(company.isActive, true);
      const fresh = await createStoredClientSession(clientSession);
      assert.ok(await getStoredClientSession(fresh.token));
      assert.equal(await getStoredClientSession(stored.token), null);
    });

    await t.test('out-of-scope manager cannot archive, restore, or write a company', async () => {
      const outsider: AdminSession = { role: 'manager', managerId: managerId + 100_000 };
      await assert.rejects(deleteClientCompany(company.id, outsider, company.updatedAt), /не найдена/);
      await assert.rejects(restoreClientCompany(company.id, outsider, company.updatedAt), /не найдена/);
      await assert.rejects(createClientChatMessageForAdmin(company.id, outsider, 'Forbidden'), /не найдена/);
    });

    await t.test('failed session revocation rolls back archiving', async () => {
      const before = (await query('select row_to_json(c) as company from client_companies c where id=$1', [company.id])).rows[0].company;
      await query(`create function synthetic_archive_fail() returns trigger language plpgsql as $$
        begin raise exception 'synthetic archive failure'; end $$`);
      await query(`create trigger synthetic_archive_fault before update on client_sessions
        for each row execute function synthetic_archive_fail()`);
      try {
        await assert.rejects(deleteClientCompany(company.id, admin, company.updatedAt), /synthetic archive failure/);
      } finally {
        await query('drop trigger synthetic_archive_fault on client_sessions');
        await query('drop function synthetic_archive_fail()');
      }
      assert.deepEqual((await query('select row_to_json(c) as company from client_companies c where id=$1', [company.id])).rows[0].company, before);
    });

    await t.test('racing login and archive never leaves a valid client session', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const raceCompany = await createClientCompany(input(), admin);
        const [login, archive] = await Promise.allSettled([
          createStoredClientSession({ clientUserId: raceCompany.clientUserId! }),
          deleteClientCompany(raceCompany.id, admin, raceCompany.updatedAt),
        ]);
        assert.equal(archive.status, 'fulfilled');
        if (login.status === 'fulfilled') assert.equal(await getStoredClientSession(login.value.token), null);
        assert.equal((await query(`select count(*)::int as count from client_sessions s join client_users u on u.id=s.client_user_id
          where u.company_id=$1 and s.revoked_at is null`, [raceCompany.id])).rows[0].count, 0);
      }
    });

    await t.test('racing stale save and archive either conflict or keep archived company inactive', async () => {
      const raceInput = input();
      const raceCompany = await createClientCompany(raceInput, admin);
      const outcomes = await Promise.allSettled([
        deleteClientCompany(raceCompany.id, admin, raceCompany.updatedAt),
        updateClientCompany(raceCompany.id, { ...raceInput, expectedUpdatedAt: raceCompany.updatedAt, title: 'Concurrent edit' }, admin),
      ]);
      assert.ok(outcomes.some((result) => result.status === 'rejected'));
      const row = (await query('select archived_at,is_active from client_companies where id=$1', [raceCompany.id])).rows[0];
      if (row.archived_at) assert.equal(row.is_active, false);
    });

    await t.test('changed version cannot be archived by a stale confirmation', async () => {
      const stale = company.updatedAt;
      company = await updateClientCompany(company.id, { ...originalInput, expectedUpdatedAt: company.updatedAt, note: 'Newer company change' }, admin);
      await assert.rejects(deleteClientCompany(company.id, admin, stale), ClientArchiveConflictError);
    });

    await t.test('document delete and cleanup-job creation are atomic', async () => {
      await query(`create function synthetic_cleanup_fail() returns trigger language plpgsql as $$
        begin raise exception 'synthetic cleanup queue failure'; end $$`);
      await query(`create trigger synthetic_cleanup_fault before insert on client_document_file_cleanup
        for each row execute function synthetic_cleanup_fail()`);
      try {
        await assert.rejects(deleteClientDocument(company.id, document.id, admin), /synthetic cleanup queue failure/);
      } finally {
        await query('drop trigger synthetic_cleanup_fault on client_document_file_cleanup');
        await query('drop function synthetic_cleanup_fail()');
      }
      assert.ok((await getClientDocumentsForAdmin(company.id, admin)).some((row) => row.id === document.id));
      assert.equal((await readClientDocumentFile(savedFile.filePath)).toString(), 'synthetic retained bytes');
    });

    await t.test('explicit cleanup preserves referenced files, retries safely, and never touches unrelated orphan files', async () => {
      const unrelated = await saveClientDocumentUpload(company.id, new File(['unrelated orphan'], 'untouched.txt'));
      const removed = await deleteClientDocument(company.id, document.id, admin);
      const duplicate = await createClientDocument(company.id, { ...savedFile, title: 'Second retained reference', isVisible: false }, admin);
      assert.deepEqual(await processClientDocumentCleanup(removed.cleanupId), { pending: true, reason: 'FILE_STILL_REFERENCED' });
      assert.equal((await readClientDocumentFile(savedFile.filePath)).toString(), 'synthetic retained bytes');
      const secondRemoved = await deleteClientDocument(company.id, duplicate.id, admin);
      assert.deepEqual(await processClientDocumentCleanup(removed.cleanupId), { pending: false });
      assert.deepEqual(await processClientDocumentCleanup(secondRemoved.cleanupId), { pending: false });
      assert.deepEqual(await processClientDocumentCleanup(removed.cleanupId), { pending: false });
      await assert.rejects(readClientDocumentFile(savedFile.filePath), { code: 'ENOENT' });
      assert.equal((await readClientDocumentFile(unrelated.filePath)).toString(), 'unrelated orphan');
    });

    await t.test('permanent purge requires archive, typed confirmation and CAS; cascades are queued atomically and prices survive', async () => {
      let purgeCompany = await createClientCompany(input(), admin);
      const userId = purgeCompany.clientUserId!;
      const confirmation = { expectedUpdatedAt: purgeCompany.updatedAt, expectedRevision: '0'.repeat(64), confirmationTitle: purgeCompany.title };
      await assert.rejects(getClientCompanyDeletionPreview(purgeCompany.id, admin), /только.*архива/);
      await assert.rejects(purgeArchivedClientCompany(purgeCompany.id, admin, confirmation), /только.*архива/);
      const purgeSession = await createStoredClientSession({ clientUserId: userId });
      await createClientChatMessageForClient({ clientUserId: userId, companyId: purgeCompany.id }, 'Purged message');
      await getClientChatConversationForAdmin(purgeCompany.id, admin);
      await query(`insert into admin_2fa_challenges (id,client_user_id,code_hash,expires_at)
        values (gen_random_uuid(),$1,'synthetic-code',now()+interval '1 day')`, [userId]);
      const purgeFile = await saveClientDocumentUpload(purgeCompany.id, new File(['remove exact bytes'], 'purged.txt'));
      const sharedFile = await saveClientDocumentUpload(purgeCompany.id, new File(['shared retained bytes'], 'shared.txt'));
      await createClientDocument(purgeCompany.id, { ...purgeFile, title: 'Delete with company', isVisible: true }, admin);
      await createClientDocument(purgeCompany.id, { ...sharedFile, title: 'Shared reference', isVisible: false }, admin);
      // A surviving reference must protect even a historical cross-company path.
      await createClientDocument(company.id, { ...sharedFile, title: 'Keep shared bytes', isVisible: false }, admin);
      const retainedPrice = (await query<{ id: string }>(`insert into wholesale_price_lists
        (title,client_company_id,client_name,token,is_active)
        values ('Price survives purge',$1,$2,'synthetic-purge-retained-price',true) returning id::text`,
      [purgeCompany.id, purgeCompany.title])).rows[0];
      await query(`insert into wholesale_price_list_items
        (price_list_id,wholesale_product_id,custom_wholesale_price,discount_percent,visible,snapshot_product_title)
        values ($1,$2,345.67,8.25,true,'Purge-preserved settings')`, [retainedPrice.id, product.id]);
      await createClientPriceRequest({ ...requestInput, companyId: purgeCompany.id, priceListId: Number(retainedPrice.id) });
      purgeCompany = await deleteClientCompany(purgeCompany.id, admin, purgeCompany.updatedAt);
      const preview = await getClientCompanyDeletionPreview(purgeCompany.id, admin);
      assert.deepEqual(preview.counts, {
        users: 1, sessions: 1, twoFactorChallenges: 1, chatMessages: 1, chatReadStates: 1,
        documents: 2, files: 2, fileBytes: purgeFile.fileSize + sharedFile.fileSize, priceRequests: 1, priceLists: 1,
      });
      const purgeInput = { expectedUpdatedAt: preview.updatedAt, expectedRevision: preview.revision, confirmationTitle: preview.title };
      for (const role of ['manager', 'support_manager', 'top', 'admintop'] as const) {
        await assert.rejects(getClientCompanyDeletionPreview(purgeCompany.id, { role }), /администратору/);
        await assert.rejects(purgeArchivedClientCompany(purgeCompany.id, { role }, purgeInput), /администратору/);
      }
      await assert.rejects(purgeArchivedClientCompany(purgeCompany.id, admin, { ...purgeInput, confirmationTitle: `${preview.title} ` }), /не совпадает/);
      await assert.rejects(purgeArchivedClientCompany(purgeCompany.id, admin, { ...purgeInput, expectedUpdatedAt: confirmation.expectedUpdatedAt }), ClientArchiveConflictError);
      const before = await preservedState(purgeCompany.id);
      const beforeJobs = (await query('select count(*)::int as count from client_document_file_cleanup')).rows[0].count;
      for (const [table, action] of [['client_document_file_cleanup', 'insert'], ['client_companies', 'delete']] as const) {
        await query(`create function synthetic_purge_fail() returns trigger language plpgsql as $$
          begin raise exception 'synthetic purge failure'; end $$`);
        await query(`create trigger synthetic_purge_fault before ${action} on ${table}
          for each row execute function synthetic_purge_fail()`);
        try {
          await assert.rejects(purgeArchivedClientCompany(purgeCompany.id, admin, purgeInput), /synthetic purge failure/);
        } finally {
          await query(`drop trigger synthetic_purge_fault on ${table}`);
          await query('drop function synthetic_purge_fail()');
        }
        assert.deepEqual(await preservedState(purgeCompany.id), before);
        assert.equal((await query('select count(*)::int as count from client_document_file_cleanup')).rows[0].count, beforeJobs);
        assert.ok((await query('select id from client_companies where id=$1', [purgeCompany.id])).rows[0]);
      }
      const beforePrice = (await query('select row_to_json(p) as price from wholesale_price_lists p where id=$1', [retainedPrice.id])).rows[0].price;
      const beforeItems = (await query('select row_to_json(i) as item from wholesale_price_list_items i where price_list_id=$1', [retainedPrice.id])).rows;
      const result = await purgeArchivedClientCompany(purgeCompany.id, { role: 'wholesale_admin' }, purgeInput);
      const { priceLists: preservedPriceCount, ...expectedRemoved } = preview.counts;
      assert.deepEqual(result.removed, expectedRemoved);
      assert.equal(result.detachedPriceLists, preservedPriceCount);
      assert.equal(result.cleanupIds.length, 2);
      const after = await preservedState(purgeCompany.id);
      assert.ok(Object.values(after).every((value) => value === null));
      assert.equal((await query('select count(*)::int as count from client_sessions where client_user_id=$1', [userId])).rows[0].count, 0);
      assert.equal((await query('select count(*)::int as count from admin_2fa_challenges where client_user_id=$1', [userId])).rows[0].count, 0);
      assert.equal(await getStoredClientSession(purgeSession.token), null);
      const afterPrice = (await query('select row_to_json(p) as price from wholesale_price_lists p where id=$1', [retainedPrice.id])).rows[0].price;
      assert.equal(afterPrice.client_company_id, null);
      for (const field of ['id', 'title', 'token', 'is_active', 'client_name', 'comment', 'created_at']) {
        assert.equal(afterPrice[field], beforePrice[field]);
      }
      assert.deepEqual((await query('select row_to_json(i) as item from wholesale_price_list_items i where price_list_id=$1', [retainedPrice.id])).rows, beforeItems);
      // The repo has not touched any file before/inside the committed purge.
      assert.equal((await readClientDocumentFile(purgeFile.filePath)).toString(), 'remove exact bytes');
      assert.equal((await readClientDocumentFile(sharedFile.filePath)).toString(), 'shared retained bytes');
      assert.deepEqual(await processClientDocumentCleanup(result.cleanupIds[0]), { pending: false });
      assert.deepEqual(await processClientDocumentCleanup(result.cleanupIds[1]), { pending: true, reason: 'FILE_STILL_REFERENCED' });
      await assert.rejects(readClientDocumentFile(purgeFile.filePath), { code: 'ENOENT' });
      assert.equal((await readClientDocumentFile(sharedFile.filePath)).toString(), 'shared retained bytes');
      await assert.rejects(purgeArchivedClientCompany(purgeCompany.id, admin, purgeInput), /не найдена/);
    });

    await t.test('new request after preview invalidates permanent-delete confirmation even with unchanged company timestamp', async () => {
      const created = await createClientCompany(input(), admin);
      const archived = await deleteClientCompany(created.id, admin, created.updatedAt);
      const preview = await getClientCompanyDeletionPreview(archived.id, admin);
      await createClientPriceRequest({ ...requestInput, companyId: archived.id, priceListId: null, comment: 'Arrived after preview' });
      const confirmation = { expectedUpdatedAt: preview.updatedAt, expectedRevision: preview.revision, confirmationTitle: preview.title };
      await assert.rejects(purgeArchivedClientCompany(archived.id, admin, confirmation), ClientArchiveConflictError);
      assert.equal((await query('select count(*)::int as count from client_price_requests where company_id=$1', [archived.id])).rows[0].count, 1);
      assert.equal((await query('select count(*)::int as count from client_document_file_cleanup where company_id=$1', [archived.id])).rows[0].count, 0);
      const refreshed = await getClientCompanyDeletionPreview(archived.id, admin);
      assert.equal(refreshed.updatedAt, preview.updatedAt);
      assert.notEqual(refreshed.revision, preview.revision);
      const removed = await purgeArchivedClientCompany(archived.id, admin, { ...confirmation, expectedRevision: refreshed.revision });
      assert.equal(removed.removed.priceRequests, 1);
    });

    await t.test('concurrent purge and restore serialize; restored client cannot be purged by stale confirmation', async () => {
      const created = await createClientCompany(input(), admin);
      const archived = await deleteClientCompany(created.id, admin, created.updatedAt);
      const preview = await getClientCompanyDeletionPreview(archived.id, admin);
      const results = await Promise.allSettled([
        purgeArchivedClientCompany(archived.id, admin, { expectedUpdatedAt: archived.updatedAt, expectedRevision: preview.revision, confirmationTitle: archived.title }),
        restoreClientCompany(archived.id, admin, archived.updatedAt),
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      const survivors = (await query('select archived_at,is_active from client_companies where id=$1', [archived.id])).rows;
      if (survivors[0]) assert.deepEqual(survivors[0], { archived_at: null, is_active: false });
    });
  } finally {
    await globalThis.__ktsPgPool?.end();
    globalThis.__ktsPgPool = undefined;
  }
});
