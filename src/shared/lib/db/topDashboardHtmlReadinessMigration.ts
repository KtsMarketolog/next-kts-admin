import type { PoolClient } from 'pg';

/** Derived metadata only. Legacy versions are classified lazily, not in a boot-time HTML scan. */
export async function applyTopDashboardHtmlReadinessMigration(client: PoolClient) {
  await client.query(`
    alter table top_dashboard_block_versions
      add column is_self_contained boolean,
      add column self_contained_revision integer,
      add column self_contained_sha256 text,
      add column self_contained_error text,
      add column self_contained_retry_after timestamptz,
      add constraint top_dashboard_block_versions_readiness_check check (
        (is_self_contained is null and self_contained_revision is null and self_contained_sha256 is null
          and self_contained_error is null and self_contained_retry_after is null)
        or (self_contained_revision is not null and self_contained_revision > 0
          and self_contained_sha256 is not null and self_contained_sha256 ~ '^[0-9a-f]{64}$'
          and ((is_self_contained is not null and self_contained_error is null and self_contained_retry_after is null)
            or (is_self_contained is null and self_contained_error is not null and self_contained_error = 'analysis_limit'
              and self_contained_retry_after is not null)))
      );
  `);
}
