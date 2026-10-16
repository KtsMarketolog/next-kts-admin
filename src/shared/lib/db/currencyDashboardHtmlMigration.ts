import type { PoolClient } from 'pg';

/** HTML releases are independent of currency snapshots, source caches and calendar history. */
export async function applyCurrencyDashboardHtmlMigration(client: PoolClient) {
  await client.query(`
    create table currency_dashboard_html_versions (
      id bigserial primary key,
      original_name text not null check (char_length(original_name) between 1 and 255),
      html_content text not null,
      file_size integer not null check (file_size between 1 and 2097152),
      sha256 text not null unique check (sha256 ~ '^[0-9a-f]{64}$'),
      source_version text not null check (char_length(source_version) between 1 and 40),
      created_by text not null check (char_length(created_by) between 1 and 160),
      created_at timestamptz not null default now(),
      check (file_size = octet_length(html_content))
    );
    create table currency_dashboard_html_state (
      id smallint primary key check (id = 1),
      active_version_id bigint references currency_dashboard_html_versions(id) on delete restrict,
      previous_version_id bigint references currency_dashboard_html_versions(id) on delete restrict,
      revision bigint not null default 0 check (revision >= 0),
      updated_at timestamptz not null default now(),
      updated_by text,
      check (active_version_id is null or previous_version_id is null or active_version_id <> previous_version_id)
    );
    insert into currency_dashboard_html_state (id) values (1);
  `);
}
