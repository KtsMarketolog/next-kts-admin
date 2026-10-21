import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { PriceBuildError } from './errors';

type SnapshotDeadline = { signal: AbortSignal; deadlineAt: number };

/** Use only inside an already opened transaction, with sequential queries. */
export function createPriceSnapshotQuery(client: Pick<PoolClient, 'query'>, options: SnapshotDeadline) {
  if (!Number.isFinite(options.deadlineAt)) throw new PriceBuildError('PRICE_BUILD_FAILED');

  function remaining() {
    if (options.signal.aborted) throw new PriceBuildError('PRICE_BUILD_ABORTED');
    const milliseconds = Math.floor(options.deadlineAt - Date.now());
    if (milliseconds <= 0) throw new PriceBuildError('PRICE_BUILD_TIMEOUT');
    return milliseconds;
  }

  return async function snapshotQuery<T extends QueryResultRow = QueryResultRow>(
    sql: string, params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    const milliseconds = remaining();
    try {
      // Numeric, bounded values only. SET rather than SELECT set_config keeps
      // this compatible with SET TRANSACTION ISOLATION LEVEL before first read.
      await client.query(
        `SET LOCAL statement_timeout = '${Math.min(30_000, milliseconds)}ms'; `
        + `SET LOCAL lock_timeout = '${Math.min(5_000, milliseconds)}ms'`,
      );
      remaining();
      // Await the real SQL completion, never race a timer and release a client
      // whose query is still running. PostgreSQL enforces the remaining budget.
      const result = await client.query<T>(sql, params);
      remaining();
      return result;
    } catch (error) {
      // A successful/failed query observed after cancellation must not permit
      // another SQL statement or the CPU worker to start with a stale budget.
      remaining();
      if (error && typeof error === 'object' && 'code' in error && error.code === '57014') {
        throw new PriceBuildError('PRICE_BUILD_TIMEOUT');
      }
      throw error;
    }
  };
}
