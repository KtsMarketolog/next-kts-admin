import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { withTransaction } from './client';
import { ensureSiteSchema } from './schema';
import { PriceBuildError, type PriceBuildErrorCode } from '../priceBuild/errors';

// Different keys: the short queue transaction never waits for the active-build lock.
export const PRICE_BUILD_LOCK_NAMESPACE = 19760422;
export const PRICE_BUILD_ACTIVE_LOCK = 1;
const QUEUE_LOCK = 2;
/** Eight waiting UNIQUE keys, in addition to one active build across all processes. */
export const PRICE_BUILD_MAX_QUEUED = 8;

export type PriceBuildJob = {
  key_hash: string;
  generation: string;
  state: 'queued' | 'active' | 'ready' | 'failed';
  owner_id: string | null;
  deadline_at: Date | null;
  lease_until: Date | null;
  result_file: string | null;
  result_bytes: number | null;
  result_sha256: string | null;
  error_code: PriceBuildErrorCode | null;
};
export type PriceBuildArtifact = { file: string; bytes: number; sha256: string };
export type PriceBuildLease = {
  job: PriceBuildJob;
  client: Client;
  ownerId: string;
  close: () => Promise<void>;
};

/** Short pool checkout only. There is no connection checked out between polls. */
export async function readOrEnqueuePriceBuild(keyHash: string, queueWaitMs: number): Promise<PriceBuildJob> {
  await ensureSiteSchema();
  return withTransaction(async client => {
    await client.query(`set local statement_timeout = '2000ms'; set local lock_timeout = '1500ms'`);
    await client.query('select pg_advisory_xact_lock($1,$2)', [PRICE_BUILD_LOCK_NAMESPACE, QUEUE_LOCK]);
    // Bounded maintenance of derived receipts, never application/customer records.
    await client.query(`delete from price_build_jobs where key_hash in (
      select key_hash from price_build_jobs where
        (state in ('ready','failed') and expires_at <= clock_timestamp())
        or (state = 'queued' and queue_expires_at <= clock_timestamp()) limit 128
    )`);
    const existing = (await client.query<PriceBuildJob>('select * from price_build_jobs where key_hash=$1', [keyHash])).rows[0];
    if (existing) return existing;
    const count = (await client.query<{ count: string }>(`select count(*)::text as count from price_build_jobs where state='queued'`)).rows[0];
    if (Number(count.count) >= PRICE_BUILD_MAX_QUEUED) throw new PriceBuildError('PRICE_BUILD_BUSY');
    return (await client.query<PriceBuildJob>(`insert into price_build_jobs
      (key_hash,generation,state,queue_expires_at) values($1,$2,'queued',clock_timestamp()+$3*interval '1 millisecond') returning *`,
    [keyHash, randomUUID(), queueWaitMs])).rows[0];
  }, { profile: 'interactive' });
}

/** A ready receipt is invalidated by exact generation/file, not by price or broad scope. */
export async function invalidatePriceBuildResult(job: PriceBuildJob) {
  await withTransaction(async client => {
    await client.query(`set local statement_timeout = '2000ms'; set local lock_timeout = '1000ms'`);
    await client.query(`delete from price_build_jobs where key_hash=$1 and generation=$2 and state='ready' and result_file=$3`,
      [job.key_hash, job.generation, job.result_file]);
  }, { profile: 'interactive' });
}

export async function readPriceBuildJob(keyHash: string) {
  return withTransaction(async client => {
    await client.query(`set local statement_timeout = '2000ms'; set local lock_timeout = '1000ms'`);
    return (await client.query<PriceBuildJob>('select * from price_build_jobs where key_hash=$1', [keyHash])).rows[0] ?? null;
  }, { profile: 'interactive' });
}

/** A failed claimant must not strand the FIFO head until the full queue deadline. */
export async function failQueuedPriceBuild(job: PriceBuildJob, code: PriceBuildErrorCode) {
  await withTransaction(async client => {
    await client.query(`set local statement_timeout = '2000ms'; set local lock_timeout = '1000ms'`);
    await client.query(`update price_build_jobs set state='failed',error_code=$3,expires_at=clock_timestamp()+interval '3 seconds'
      where key_hash=$1 and generation=$2 and state='queued'`, [job.key_hash, job.generation, code]);
  }, { profile: 'interactive' });
}

const ELIGIBLE_SQL = `select * from price_build_jobs j where key_hash=$1 and generation=$2
  and ((state='queued' and queue_expires_at>clock_timestamp())
    or (state='active' and lease_until<=clock_timestamp()))
  and not exists(select 1 from price_build_jobs a where a.state='active' and a.lease_until>clock_timestamp())
  and not exists(select 1 from price_build_jobs q where q.state='queued' and q.queue_expires_at>clock_timestamp()
    and (q.queued_at,q.key_hash)<(j.queued_at,j.key_hash))`;

/**
 * Only a queue head opens a dedicated PostgreSQL session. Its advisory lock is
 * held throughout build AND worker termination: an expired lease alone can never
 * admit a second CPU worker while a paused owner's session remains connected.
 */
export async function tryClaimPriceBuild(job: PriceBuildJob, options: {
  buildTimeoutMs: number; leaseMs: number; onDisconnect: () => void;
}): Promise<PriceBuildLease | null> {
  const eligible = await withTransaction(async client => {
    await client.query(`set local statement_timeout = '2000ms'; set local lock_timeout = '1000ms'`);
    return (await client.query(ELIGIBLE_SQL, [job.key_hash, job.generation])).rowCount;
  }, { profile: 'interactive' });
  if (!eligible) return null;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new PriceBuildError('PRICE_BUILD_UNAVAILABLE');
  const client = new Client({ connectionString, application_name: 'kts-price-build-active',
    connectionTimeoutMillis: 2_000, statement_timeout: 2_000, query_timeout: 2_500,
    keepAlive: true, keepAliveInitialDelayMillis: 1_000 });
  let closing = false;
  let closed = false;
  const disconnected = () => { if (!closing) options.onDisconnect(); };
  client.on('error', disconnected);
  client.on('end', disconnected);
  const close = async () => {
    if (closed) return;
    closed = true; closing = true;
    // Closing this dedicated connection releases only this session's lock.
    await client.end().catch(() => {});
  };
  try {
    await client.connect();
    const acquired = (await client.query<{ locked: boolean }>('select pg_try_advisory_lock($1,$2) as locked',
      [PRICE_BUILD_LOCK_NAMESPACE, PRICE_BUILD_ACTIVE_LOCK])).rows[0].locked;
    if (!acquired) { await close(); return null; }
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock($1,$2)', [PRICE_BUILD_LOCK_NAMESPACE, QUEUE_LOCK]);
    if (!(await client.query(ELIGIBLE_SQL, [job.key_hash, job.generation])).rowCount) {
      await client.query('rollback'); await close(); return null;
    }
    // Global session lock proves expired previous owners no longer hold admission.
    await client.query(`update price_build_jobs set state='failed',error_code='PRICE_BUILD_TIMEOUT',
      expires_at=clock_timestamp()+interval '3 seconds' where state='active' and key_hash<>$1 and lease_until<=clock_timestamp()`, [job.key_hash]);
    const ownerId = randomUUID();
    const claimed = (await client.query<PriceBuildJob>(`update price_build_jobs set state='active',owner_id=$3,
      deadline_at=clock_timestamp()+$4*interval '1 millisecond',lease_until=clock_timestamp()+$5*interval '1 millisecond'
      where key_hash=$1 and generation=$2 returning *`,
    [job.key_hash, job.generation, ownerId, options.buildTimeoutMs, options.leaseMs])).rows[0];
    await client.query('commit');
    return { client, job: claimed, ownerId, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function heartbeatPriceBuild(lease: PriceBuildLease, leaseMs: number) {
  const result = await lease.client.query(`update price_build_jobs set lease_until=least(deadline_at,clock_timestamp()+$4*interval '1 millisecond')
    where key_hash=$1 and generation=$2 and owner_id=$3 and state='active' and deadline_at>clock_timestamp()`,
  [lease.job.key_hash, lease.job.generation, lease.ownerId, leaseMs]);
  if (!result.rowCount) throw new PriceBuildError('PRICE_BUILD_UNAVAILABLE');
}

export async function publishPriceBuild(lease: PriceBuildLease, artifact: PriceBuildArtifact, ttlMs: number) {
  const result = await lease.client.query(`update price_build_jobs set state='ready',result_file=$4,result_bytes=$5,
    result_sha256=$6,expires_at=clock_timestamp()+$7*interval '1 millisecond'
    where key_hash=$1 and generation=$2 and owner_id=$3 and state='active' and deadline_at>clock_timestamp() and lease_until>clock_timestamp()`,
  [lease.job.key_hash, lease.job.generation, lease.ownerId, artifact.file, artifact.bytes, artifact.sha256, ttlMs]);
  if (!result.rowCount) throw new PriceBuildError('PRICE_BUILD_UNAVAILABLE');
}

export async function failPriceBuild(lease: PriceBuildLease, code: PriceBuildErrorCode) {
  // The dedicated connection may have failed. A short independent query fences
  // against a replacement owner; never replay a build or overwrite a ready result.
  await withTransaction(async client => {
    await client.query(`set local statement_timeout = '2000ms'; set local lock_timeout = '1000ms'`);
    await client.query(`update price_build_jobs set state='failed',error_code=$4,expires_at=clock_timestamp()+interval '3 seconds'
      where key_hash=$1 and generation=$2 and owner_id=$3 and state='active'`,
    [lease.job.key_hash, lease.job.generation, lease.ownerId, code]);
  }, { profile: 'interactive' });
}
