import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { TransactionCommitUnknownError } from './transactionOutcome';
import {
  databaseOperationProfile,
  isRetryableTransactionConflict,
  MAX_TRANSACTION_ATTEMPTS,
  waitBeforeTransactionRetry,
  type TransactionOptions,
} from './transactionPolicy';

declare global {
  var __ktsPgPool: Pool | undefined;
}

function getPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  if (!globalThis.__ktsPgPool) {
    const deadlines = databaseOperationProfile();
    const pool = new Pool({
      connectionString,
      application_name: `kts-next-admin:${process.env.KTS_INSTANCE_ID ?? 'standalone'}`,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      max: 8,
      maxLifetimeSeconds: 15 * 60,
      maxUses: 5_000,
      // pg sends these as server settings for every connection, including pool.query().
      // connectionTimeoutMillis alone does not bound SQL or lock waits.
      statement_timeout: deadlines.statementTimeoutMs,
      lock_timeout: deadlines.lockTimeoutMs,
      idle_in_transaction_session_timeout: deadlines.idleTransactionTimeoutMs,
    });
    pool.on('error', (error) => {
      console.error(JSON.stringify({
        event: 'postgres_pool_error',
        timestamp: new Date().toISOString(),
        message: error.message,
        instance: process.env.KTS_INSTANCE_ID ?? 'standalone',
      }));
    });
    globalThis.__ktsPgPool = pool;
  }
  return globalThis.__ktsPgPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) {
  return getPool().query<T>(text, params);
}

export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const deadlines = databaseOperationProfile(options.profile);
  const maxAttempts = options.retryOnConflict ? MAX_TRANSACTION_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt += 1) {
    // Each attempt obtains a fresh checkout. Never hold a pool slot during backoff.
    const client = await getPool().connect();
    let committing = false;
    let discard = false;
    let retrySqlState: string | undefined;
    try {
      await client.query('begin');
      // Transaction-local settings restore automatically on both COMMIT and ROLLBACK.
      // Only compile-time profile numbers are interpolated. SET (not SELECT
      // set_config) lets callers still set transaction isolation/read-only first.
      await client.query(
        `SET LOCAL statement_timeout = '${deadlines.statementTimeoutMs}ms';
         SET LOCAL lock_timeout = '${deadlines.lockTimeoutMs}ms';
         SET LOCAL idle_in_transaction_session_timeout = '${deadlines.idleTransactionTimeoutMs}ms'`,
      );
      const result = await callback(client);
      committing = true;
      const commit = await client.query('commit');
      committing = false;
      if (options.trackCommitOutcome && commit.command === 'ROLLBACK') {
        throw new Error('Транзакция отменена. Изменения не сохранены.');
      }
      return result;
    } catch (error) {
      const knownConflict = isRetryableTransactionConflict(error);
      let rolledBack = false;
      try {
        const rollback = await client.query('rollback');
        rolledBack = rollback.command === 'ROLLBACK';
      } catch {
        // Discard the connection below; without a confirmed rollback, do not replay.
      }
      discard = !rolledBack || (committing && !knownConflict);
      // A lost COMMIT acknowledgement does not establish whether it committed.
      // 40P01/40001 are explicit aborts, including errors returned by COMMIT itself.
      if (committing && !knownConflict && options.trackCommitOutcome) {
        throw new TransactionCommitUnknownError();
      }
      if (!knownConflict || !rolledBack || attempt >= maxAttempts) throw error;
      retrySqlState = (error as { code: string }).code;
    } finally {
      client.release(discard);
    }
    console.warn(JSON.stringify({
      event: 'postgres_transaction_retry',
      profile: options.profile ?? 'default',
      attempt,
      sqlstate: retrySqlState,
    }));
    await waitBeforeTransactionRetry(attempt);
  }
}

export async function tryAcquireSessionAdvisoryLock(lockName: string, options: { onDisconnect?: () => void } = {}) {
  const client = await getPool().connect();
  let disconnected = false;
  const onDisconnect = () => {
    if (disconnected) return;
    disconnected = true;
    options.onDisconnect?.();
  };
  // A checked-out pg client does not use the pool's idle error handler. Upload
  // owners need a cancellation signal if their session-owned admission vanishes.
  if (options.onDisconnect) {
    client.on('error', onDisconnect);
    client.on('end', onDisconnect);
  }
  const detach = () => {
    if (!options.onDisconnect) return;
    client.removeListener('error', onDisconnect);
    client.removeListener('end', onDisconnect);
  };
  try {
    const result = await client.query<{ acquired: boolean }>(
      `select pg_try_advisory_lock(hashtext($1::text)) as acquired`,
      [lockName],
    );
    if (disconnected) throw new Error('Database admission connection was lost');
    if (!result.rows[0]?.acquired) {
      detach();
      client.release();
      return null;
    }
  } catch (error) {
    detach();
    client.release(true);
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    let discard = disconnected;
    try {
      if (disconnected) return;
      await client.query(`select pg_advisory_unlock(hashtext($1::text))`, [lockName]);
    } catch (error) {
      discard = true;
      throw error;
    } finally {
      discard ||= disconnected;
      detach();
      // An uncertain unlock must not return a session-owned lock to the pool.
      client.release(discard);
    }
  };
}

export async function withSessionAdvisoryLock<T>(
  lockName: string,
  callback: (client: PoolClient) => Promise<T>,
) {
  const client = await getPool().connect();
  let discard = false;
  try {
    await client.query(`select pg_advisory_lock(hashtext($1::text))`, [lockName]);
    return await callback(client);
  } finally {
    try {
      await client.query(`select pg_advisory_unlock(hashtext($1::text))`, [lockName]);
    } catch {
      // A session lock has no transaction rollback cleanup. Do not return a
      // potentially locked session to the pool after a timeout/lost response.
      discard = true;
    }
    client.release(discard);
  }
}
