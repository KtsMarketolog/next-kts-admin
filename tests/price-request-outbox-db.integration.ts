/** Run only with scripts/test-price-request-outbox-postgres.sh; synthetic isolated database. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { query, withTransaction } from '../src/shared/lib/db/client';
import { ensureSiteSchema } from '../src/shared/lib/db/schema';
import { applyPriceRequestOutboxMigration } from '../src/shared/lib/db/priceRequestOutboxMigration';
import { getClientPriceRequestsForClient, getPriceRequestInbox, type ClientPriceRequestInput } from '../src/shared/lib/db/clientPriceRequestsRepo';
import {
  acknowledgePriceRequestMail, claimPriceRequestMail, deferPriceRequestMail, findPriceRequestOperation,
  PriceRequestConflictError, priceRequestMailQueueCounts, savePriceRequestOperation,
} from '../src/shared/lib/db/priceRequestOutboxRepo';

function guard() {
  assert.equal(process.env.KTS_PRICE_REQUEST_OUTBOX_TEST, '1');
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.pathname, '/kts_price_request_outbox_integration');
  assert.equal(url.username, 'outbox_app');
  assert.equal(url.password, '');
  assert.match(url.searchParams.get('host') ?? '', /^\/(?:private\/)?tmp\/kts-price-outbox-postgres\.[A-Za-z0-9]+\/socket$/);
  assert.equal(url.searchParams.get('port'), '55491');
  for (const [key] of url.searchParams) assert.ok(['host', 'port'].includes(key));
}
const digest = createHash('sha256').update('synthetic body').digest('hex');
const mail = { recipients: ['one@example.test', 'two@example.test'], subject: 'Synthetic request', html: '<p>No external IO</p>', text: 'No external IO' };

test('durable request/outbox atomicity, replay, isolation and leases in PostgreSQL', { timeout: 120_000 }, async (t) => {
  guard();
  try {
    await ensureSiteSchema();
    if (!(await query("select to_regclass('public.price_request_mail_outbox') as present")).rows[0].present) {
      await withTransaction(applyPriceRequestOutboxMigration);
    }
    const companyId = Number((await query<{ id: string }>("insert into client_companies(title) values('Synthetic client') returning id::text")).rows[0].id);
    const priceId = Number((await query<{ id: string }>("insert into wholesale_price_lists(title,token,client_company_id) values('Keep unchanged','outbox-price',$1) returning id::text", [companyId])).rows[0].id);
    const otherPriceId = Number((await query<{ id: string }>("insert into wholesale_price_lists(title,token) values('Orphan request price','outbox-orphan') returning id::text")).rows[0].id);
    const originalPrices = (await query('select * from wholesale_price_lists order by id')).rows;
    const input: ClientPriceRequestInput & { priceListId: number } = { companyId, priceListId: priceId, token: 'outbox-price', priceTitle: 'Keep unchanged',
      clientName: 'Synthetic client', managerId: null, supportManagerId: null, comment: 'Preserve me', totalQuantity: 2,
      totalPriceLabel: '20 EUR', totalConvertedRub: null, rubConversionInfo: '', convertedBreakdownLabel: '',
      items: [{ priceItemId: 17, productTitle: 'Synthetic product', sku: 'TEST', variantTitle: '', quantity: 2,
        prices: [{ amount: 10, currency: 'EUR', lineTotal: 20, convertedRubAmount: null, convertedRubLineTotal: null }] }] };
    const operationId = randomUUID();
    let requestId = '';

    await t.test('40 concurrent submissions have one history and exactly one envelope per recipient', async () => {
      const results = await Promise.all(Array.from({ length: 40 }, () => savePriceRequestOperation(input, operationId, digest, mail)));
      assert.equal(results.filter((value) => !value.duplicate).length, 1);
      assert.equal(new Set(results.map((value) => value.requestId)).size, 1);
      requestId = results[0].requestId;
      assert.equal((await query('select count(*)::int as n from client_price_requests')).rows[0].n, 1);
      assert.equal((await query('select count(*)::int as n from price_request_mail_outbox')).rows[0].n, 2);
      assert.deepEqual(await findPriceRequestOperation(priceId, operationId, digest), { requestId, duplicate: true });
      await assert.rejects(savePriceRequestOperation(input, operationId, 'a'.repeat(64), mail), PriceRequestConflictError);
      assert.equal((await query('select count(*)::int as n from client_price_requests')).rows[0].n, 1);
    });

    await t.test('outbox failure rolls back history and receipt; same operation then succeeds', async () => {
      const failedOperation = randomUUID();
      await assert.rejects(savePriceRequestOperation(input, failedOperation, digest, { ...mail, recipients: ['x'.repeat(1001)] }));
      assert.equal(await findPriceRequestOperation(priceId, failedOperation, digest), null);
      assert.equal((await query('select count(*)::int as n from client_price_requests')).rows[0].n, 1);
      assert.equal((await savePriceRequestOperation(input, failedOperation, digest, mail)).duplicate, false);
    });

    await t.test('scope separates prices; requests without company are durable but never appear in another client history', async () => {
      const orphan = await savePriceRequestOperation({ ...input, companyId: null, priceListId: otherPriceId, token: 'outbox-orphan' }, operationId, digest, mail);
      assert.notEqual(orphan.requestId, requestId);
      const clientRequests = await getClientPriceRequestsForClient(companyId);
      assert.equal(clientRequests.length, 2);
      assert.ok(clientRequests.every((value) => value.companyId === companyId && value.mailStatus === 'pending'));
      const inbox = await getPriceRequestInbox({ role: 'admin' }, null, true);
      assert.equal(inbox.requests.length, 3);
      assert.ok(inbox.requests.some((value) => value.id === Number(orphan.requestId) && value.companyId === null));
      await assert.rejects(getPriceRequestInbox({ role: 'manager', managerId: 1 }, null, false), /Forbidden/);
    });

    await t.test('concurrent workers claim distinct envelopes; stale acknowledgements cannot steal a renewed lease', async () => {
      const claims = await Promise.all(Array.from({ length: 8 }, () => claimPriceRequestMail()));
      const claimed = claims.filter((value) => value !== null);
      assert.equal(claimed.length, 6);
      assert.equal(new Set(claimed.map((value) => value.id)).size, 6);
      const expired = claimed[0];
      await query("update price_request_mail_outbox set lease_until=now()-interval '1 second' where id=$1", [expired.id]);
      const renewed = await claimPriceRequestMail();
      assert.equal(renewed?.id, expired.id);
      assert.notEqual(renewed?.leaseToken, expired.leaseToken);
      assert.equal(await acknowledgePriceRequestMail(expired), false);
      assert.equal(await acknowledgePriceRequestMail(renewed!), true);
      const failedMail = claimed.find((item) => item.requestId === requestId && item.id !== expired.id)!;
      assert.ok(failedMail);
      await deferPriceRequestMail(failedMail, 'EAUTH');
      const deferred = (await query("select state,last_error,extract(epoch from(next_attempt_at-now()))::int as delay from price_request_mail_outbox where id=$1", [failedMail.id])).rows[0];
      assert.equal(deferred.state, 'pending');
      assert.equal(deferred.last_error, 'EAUTH');
      assert.ok(deferred.delay >= 59 && deferred.delay <= 60);
      assert.equal(await claimPriceRequestMail(), null);
      assert.ok((await getClientPriceRequestsForClient(companyId)).some((item) => item.mailStatus === 'retrying'));
      for (const item of claimed.filter((item) => item.id !== expired.id && item.id !== failedMail.id)) await acknowledgePriceRequestMail(item);
    });

    await t.test('extended outage keeps a durable daily retry and attention count instead of abandoning mail', async () => {
      await query("update price_request_mail_outbox set attempts=71,next_attempt_at=now() where state='pending'");
      const last = await claimPriceRequestMail();
      assert.equal(last?.attempts, 72);
      await deferPriceRequestMail(last!, 'EAUTH');
      const row = (await query("select state,extract(epoch from(next_attempt_at-now()))::int as delay from price_request_mail_outbox where id=$1", [last!.id])).rows[0];
      assert.equal(row.state, 'pending');
      assert.ok(row.delay >= 86399 && row.delay <= 86400);
      assert.deepEqual(await priceRequestMailQueueCounts(), { pending: 1, failed: 1 });
      await query('update price_request_mail_outbox set next_attempt_at=now() where id=$1', [last!.id]);
      const retry = await claimPriceRequestMail();
      assert.equal(retry?.attempts, 72);
      assert.equal(await acknowledgePriceRequestMail(retry!), true);
      assert.deepEqual(await priceRequestMailQueueCounts(), { pending: 0, failed: 0 });
      assert.equal((await getPriceRequestInbox({ role: 'wholesale_admin' }, null, true)).requests.length, 0);
      assert.deepEqual((await query('select * from wholesale_price_lists order by id')).rows, originalPrices);
      assert.equal((await query('select count(*)::int as n from client_price_requests')).rows[0].n, 3);
    });

    await t.test('inbox orders numeric ids across 8–12 and 99–101 and does not skip rows at the 25/26 page boundary', async () => {
      await query(`insert into client_price_requests(company_id,price_list_id,price_title)
        select $1,$2,'Synthetic pagination '||number::text from generate_series(1,105) number`, [companyId, priceId]);
      const expected = (await query<{ id: string }>('select id::text from client_price_requests order by client_price_requests.id desc'))
        .rows.map((row) => Number(row.id));
      for (const value of [8, 9, 10, 11, 12, 99, 100, 101]) assert.ok(expected.includes(value));
      const actual: number[] = [];
      let before: string | null = null;
      do {
        const page = await getPriceRequestInbox({ role: 'admin' }, before, false);
        assert.ok(page.requests.length <= 25);
        actual.push(...page.requests.map((request) => request.id));
        before = page.nextCursor;
      } while (before !== null);
      assert.deepEqual(actual, expected);
      assert.equal(new Set(actual).size, expected.length);
    });
  } finally {
    await globalThis.__ktsPgPool?.end();
    globalThis.__ktsPgPool = undefined;
  }
});
