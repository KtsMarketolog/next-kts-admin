import type { PoolClient } from 'pg';

/** Independent of source retention: deleting an old version cannot erase its pending upload audit. */
export async function applyDashboardUploadUsageOutboxMigration(client: PoolClient) {
  await client.query(`create table dashboard_upload_usage_outbox (
    id bigserial primary key,
    actor_key text not null check (actor_key ~ '^(admin|manager):([1-9][0-9]*|primary)$'),
    actor_role text not null check (actor_role in ('admin','admintop','top','wholesale_admin','manager','support_manager','purchaser')),
    dashboard_key text not null check (dashboard_key ~ '^(top:[1-9][0-9]*|manager:(development|support)|route-planner|currency-rates)$'),
    html_version_id bigint check (html_version_id > 0),
    event_id text not null check (event_id ~ '^upload_[0-9a-f]{64}$'),
    upload_name text not null check (char_length(upload_name) between 1 and 255 and char_length(btrim(upload_name)) > 0
      and upload_name not in ('.','..') and position('/' in upload_name)=0 and position(chr(92) in upload_name)=0
      and upload_name !~ '[[:cntrl:]]'),
    upload_size bigint not null check (upload_size between 0 and 2147483648),
    upload_type text not null check (upload_type in ('html','data','personal')),
    captured_at timestamptz not null default clock_timestamp(),
    unique(actor_key,event_id)
  )`);
}
