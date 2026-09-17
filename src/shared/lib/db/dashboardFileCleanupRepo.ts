import type { PoolClient } from 'pg';

const STORAGE_PATH = /^[0-9a-f]{2}\/[0-9a-f]{64}-[0-9a-f-]{36}\.bin$/u;

/** The caller's transaction commits deletion metadata and its cleanup job together. */
export async function enqueueDashboardFilesForDeletion(
  client: Pick<PoolClient, 'query'>,
  storagePaths: readonly string[],
) {
  const paths = [...new Set(storagePaths)];
  for (const value of paths) {
    if (!STORAGE_PATH.test(value) || value.slice(0, 2) !== value.slice(3, 5)) {
      throw new Error('Invalid dashboard cleanup storage path');
    }
  }
  if (!paths.length) return;
  await client.query(`insert into dashboard_file_cleanup_queue(storage_path)
    select unnest($1::text[]) on conflict (storage_path) do nothing`, [paths]);
}
