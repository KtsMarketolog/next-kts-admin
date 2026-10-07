import type { PoolClient } from 'pg';

export async function applyDashboardDatesMigration(client: PoolClient) {
  // Existing rows intentionally remain unknown: an upload date is not a snapshot date.
  await client.query(`alter table top_dashboard_block_data_versions add column if not exists data_as_of text`);
}
