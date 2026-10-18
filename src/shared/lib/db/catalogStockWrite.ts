import type { PoolClient } from 'pg';

import { withTransaction } from '@/shared/lib/db/client';

// Every multi-table catalog/stock writer takes this gate before reading a
// mutable snapshot or locking rows. Schema initialization participates too,
// including across app workers. Ordinary MVCC readers never take this lock.
export const CATALOG_STOCK_WRITE_LOCK = 'kts-catalog-stock-write';

// Retryable callbacks must contain only database work. Build mutable counters,
// lookup caches and results inside the callback; run mail/cache side effects
// only after this promise resolves. Never wrap an ensure*Schema call here:
// initialize schemas first, so their separate transaction cannot wait on us.
export function withCatalogStockWrite<T>(
  callback: (client: PoolClient) => Promise<T>,
  profile: 'interactive' | 'import' | 'schema' = 'interactive',
) {
  return withTransaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [CATALOG_STOCK_WRITE_LOCK]);
    return callback(client);
  }, { profile, retryOnConflict: true, trackCommitOutcome: true });
}
