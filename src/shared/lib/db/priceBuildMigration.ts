import type { PoolClient } from 'pg';

/** Disposable derived work only: no foreign keys or writes to saved prices/catalogue. */
export async function applyPriceBuildMigration(client: PoolClient) {
  await client.query(`
    create table price_build_jobs (
      key_hash text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
      generation uuid not null,
      state text not null check (state in ('queued','active','ready','failed')),
      queued_at timestamptz not null default clock_timestamp(),
      queue_expires_at timestamptz not null,
      owner_id uuid,
      deadline_at timestamptz,
      lease_until timestamptz,
      result_file text check (result_file ~ '^[0-9a-f]{64}-[0-9a-f-]{36}\\.bin$'),
      result_bytes integer check (result_bytes > 0 and result_bytes <= 67108864),
      result_sha256 text check (result_sha256 ~ '^[0-9a-f]{64}$'),
      expires_at timestamptz,
      error_code text check (error_code in ('PRICE_BUILD_BUSY','PRICE_BUILD_TIMEOUT','PRICE_BUILD_UNAVAILABLE','PRICE_BUILD_ABORTED','PRICE_BUILD_FAILED')),
      check (state <> 'active' or (owner_id is not null and deadline_at is not null and lease_until is not null)),
      check (state <> 'ready' or (result_file is not null and result_bytes is not null and result_sha256 is not null and expires_at is not null)),
      check (state <> 'failed' or (error_code is not null and expires_at is not null))
    );
    create index price_build_jobs_queue_idx on price_build_jobs(queued_at,key_hash) where state = 'queued';
    create index price_build_jobs_expiry_idx on price_build_jobs(expires_at) where state in ('ready','failed');
  `);
}
