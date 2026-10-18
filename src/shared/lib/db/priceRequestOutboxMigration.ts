import type { PoolClient } from 'pg';

/** Additive durable receipts: existing requests, prices and catalogue rows stay untouched. */
export async function applyPriceRequestOutboxMigration(client: PoolClient) {
  await client.query(`
    alter table client_price_requests alter column company_id drop not null;
    create table public_price_request_operations (
      price_scope_id bigint not null,
      operation_id uuid not null,
      request_digest text not null check (request_digest ~ '^[0-9a-f]{64}$'),
      request_id bigint not null unique references client_price_requests(id) on delete cascade,
      created_at timestamptz not null default now(),
      primary key (price_scope_id, operation_id)
    );
    create table price_request_mail_outbox (
      id bigserial primary key,
      request_id bigint not null references client_price_requests(id) on delete cascade,
      recipient text not null check (char_length(recipient) between 1 and 1000),
      subject text not null,
      html text not null,
      body_text text not null,
      state text not null default 'pending' check (state in ('pending','sending','sent')),
      attempts integer not null default 0 check (attempts >= 0),
      next_attempt_at timestamptz not null default now(),
      lease_token uuid,
      lease_until timestamptz,
      last_error text,
      created_at timestamptz not null default now(),
      sent_at timestamptz,
      unique (request_id, recipient)
    );
    create index price_request_mail_outbox_due_idx on price_request_mail_outbox(next_attempt_at, id)
      where state in ('pending','sending');
  `);
}
