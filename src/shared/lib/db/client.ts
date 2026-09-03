import { Pool, type PoolClient, type QueryResultRow } from 'pg';

declare global {
  var __ktsPgPool: Pool | undefined;
}

function getPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  if (!globalThis.__ktsPgPool) {
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

export async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>) {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await callback(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function tryAcquireSessionAdvisoryLock(lockName: string) {
  const client = await getPool().connect();
  try {
    const result = await client.query<{ acquired: boolean }>(
      `select pg_try_advisory_lock(hashtext($1::text)) as acquired`,
      [lockName],
    );
    if (!result.rows[0]?.acquired) {
      client.release();
      return null;
    }
  } catch (error) {
    client.release();
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query(`select pg_advisory_unlock(hashtext($1::text))`, [lockName]);
    } finally {
      client.release();
    }
  };
}

export async function withSessionAdvisoryLock<T>(
  lockName: string,
  callback: (client: PoolClient) => Promise<T>,
) {
  const client = await getPool().connect();
  try {
    await client.query(`select pg_advisory_lock(hashtext($1::text))`, [lockName]);
    return await callback(client);
  } finally {
    await client.query(`select pg_advisory_unlock(hashtext($1::text))`, [lockName]).catch(() => {});
    client.release();
  }
}
