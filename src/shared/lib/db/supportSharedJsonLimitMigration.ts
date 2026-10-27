import type { PoolClient } from 'pg';
import { SUPPORT_SHARED_JSON_MAX_BYTES } from '../supportSharedRoutePlannerLimits';

/** Widen only this report's metadata constraint, preserving all files and pointers. */
export async function applySupportSharedJsonLimitMigration(client: PoolClient) {
  // PostgreSQL assigns this name to the original column-level CHECK. Replacing
  // it inside the schema migration transaction also upgrades existing installs.
  await client.query(`
    alter table support_shared_dashboard_json_snapshots
      drop constraint if exists support_shared_dashboard_json_snapshots_file_size_check,
      add constraint support_shared_dashboard_json_snapshots_file_size_check
        check (file_size between 1 and ${SUPPORT_SHARED_JSON_MAX_BYTES});
  `);
}
