import type { PoolClient } from 'pg';

/** Financial details are opt-in for the known invoice report, never generic telemetry. */
export async function applyDashboardProfitabilityAuditMigration(client: PoolClient) {
  await client.query(`
    create table dashboard_profitability_audit_details (
      usage_event_id bigint primary key references dashboard_usage_events(id) on delete cascade,
      invoice jsonb not null check (
        jsonb_typeof(invoice) = 'object'
        and invoice->>'schemaVersion' = '1'
        and jsonb_typeof(invoice->'lines') = 'array'
        and jsonb_array_length(invoice->'lines') between 1 and 1000
        -- jsonb::text inserts formatting spaces; the HTTP and repository payload
        -- limit stays 1 MiB, with 16 KiB reserved here only for DB serialization.
        and octet_length(invoice::text) <= 1064960
      ),
      payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$')
    );
    alter table top_dashboard_block_versions
      drop constraint top_dashboard_block_versions_file_size_check;
    alter table top_dashboard_block_versions
      add constraint top_dashboard_block_versions_file_size_check
      check (file_size between 1 and 20971520);
  `);
}
