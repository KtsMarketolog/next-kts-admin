import { randomUUID } from 'node:crypto';
import { query, withTransaction } from './client';
import { createClientPriceRequest, type ClientPriceRequestInput } from './clientPriceRequestsRepo';
import { ensureSiteSchema } from './schema';

export class PriceRequestConflictError extends Error {
  constructor() { super('Request operation has different content'); this.name = 'PriceRequestConflictError'; }
}
export type PriceRequestMail = { recipients: string[]; subject: string; html: string; text: string };
export type PriceRequestReceipt = { requestId: string; duplicate: boolean };
type OperationRow = { request_id: string; request_digest: string };

function receipt(row: OperationRow, digest: string): PriceRequestReceipt {
  if (row.request_digest !== digest) throw new PriceRequestConflictError();
  return { requestId: row.request_id, duplicate: true };
}

/** Only called after current token access has been checked. Never return customer content. */
export async function findPriceRequestOperation(priceId: number, operationId: string, digest: string) {
  await ensureSiteSchema();
  const result = await query<OperationRow>(`select request_id::text, request_digest
    from public_price_request_operations where price_scope_id=$1 and operation_id=$2::uuid`, [priceId, operationId]);
  return result.rows[0] ? receipt(result.rows[0], digest) : null;
}

export async function savePriceRequestOperation(
  input: ClientPriceRequestInput & { priceListId: number },
  operationId: string,
  digest: string,
  mail: PriceRequestMail,
): Promise<PriceRequestReceipt> {
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    // Concurrent replays serialize before creating history. Hash collisions only serialize unrelated work.
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`public-price-request:${input.priceListId}:${operationId}`]);
    const existing = await client.query<OperationRow>(`select request_id::text, request_digest
      from public_price_request_operations where price_scope_id=$1 and operation_id=$2::uuid`, [input.priceListId, operationId]);
    if (existing.rows[0]) return receipt(existing.rows[0], digest);
    const saved = await createClientPriceRequest(input, client);
    await client.query(`insert into public_price_request_operations(price_scope_id,operation_id,request_digest,request_id)
      values($1,$2::uuid,$3,$4)`, [input.priceListId, operationId, digest, saved.id]);
    const recipients = [...new Map(mail.recipients.map((value) => [value.trim().toLowerCase(), value.trim()])).values()].filter(Boolean);
    if (!recipients.length) throw new Error('Price notification recipient is required');
    // One envelope per recipient: a partial SMTP acceptance must not repeatedly email accepted recipients.
    for (const recipient of recipients) {
      await client.query(`insert into price_request_mail_outbox(request_id,recipient,subject,html,body_text)
        values($1,$2,$3,$4,$5)`, [saved.id, recipient, mail.subject, mail.html, mail.text]);
    }
    return { requestId: String(saved.id), duplicate: false };
  }, { profile: 'interactive', retryOnConflict: true, trackCommitOutcome: true });
}

export const PRICE_REQUEST_MAIL_FAST_ATTEMPTS = 72;
export type ClaimedPriceRequestMail = {
  id: string; requestId: string; recipient: string; subject: string; html: string; text: string;
  attempts: number; leaseToken: string;
};

export async function claimPriceRequestMail(): Promise<ClaimedPriceRequestMail | null> {
  await ensureSiteSchema();
  const leaseToken = randomUUID();
  const result = await query<{
    id: string; request_id: string; recipient: string; subject: string; html: string; body_text: string; attempts: number;
  }>(`with candidate as (
    select id from price_request_mail_outbox
    where (state='pending' and next_attempt_at<=now()) or (state='sending' and lease_until<=now())
    order by next_attempt_at,id for update skip locked limit 1
  ) update price_request_mail_outbox o set state='sending', attempts=least(o.attempts+1,72),
    lease_token=$1::uuid, lease_until=now()+interval '2 minutes'
    from candidate where o.id=candidate.id
    returning o.id::text,o.request_id::text,o.recipient,o.subject,o.html,o.body_text,o.attempts`, [leaseToken]);
  const row = result.rows[0];
  return row ? { id: row.id, requestId: row.request_id, recipient: row.recipient, subject: row.subject,
    html: row.html, text: row.body_text, attempts: row.attempts, leaseToken } : null;
}

export async function acknowledgePriceRequestMail(mail: ClaimedPriceRequestMail) {
  const result = await query(`update price_request_mail_outbox set state='sent',sent_at=now(),last_error=null,
    lease_token=null,lease_until=null where id=$1 and state='sending' and lease_token=$2::uuid`, [mail.id, mail.leaseToken]);
  return result.rowCount === 1;
}

export async function deferPriceRequestMail(mail: ClaimedPriceRequestMail, code: string) {
  // An extended provider outage must not discard notifications or silently stop retries.
  const delaySeconds = mail.attempts >= PRICE_REQUEST_MAIL_FAST_ATTEMPTS ? 86400
    : Math.min(3600, 60 * 2 ** Math.min(mail.attempts - 1, 6));
  await query(`update price_request_mail_outbox set state='pending',next_attempt_at=now()+$3*interval '1 second',
    last_error=$4,lease_token=null,lease_until=null where id=$1 and state='sending' and lease_token=$2::uuid`,
  [mail.id, mail.leaseToken, delaySeconds, code]);
}

export async function priceRequestMailQueueCounts() {
  const result = await query<{ pending: string; failed: string }>(`select
    count(*) filter (where state in ('pending','sending'))::text as pending,
    count(*) filter (where state<>'sent' and attempts>=72)::text as failed from price_request_mail_outbox`);
  return { pending: Number(result.rows[0].pending), failed: Number(result.rows[0].failed) };
}
