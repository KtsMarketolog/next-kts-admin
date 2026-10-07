import type { PoolClient } from 'pg';

/** Independent audit; snapshot retention and employee/report deletion never remove it. */
export async function applyDashboardUsageMigration(client: PoolClient) {
  await client.query(`
    create table dashboard_usage_events (
      id bigserial primary key,
      actor_key text not null check (actor_key ~ '^(admin|manager):([1-9][0-9]*|primary)$'),
      actor_role text not null,
      dashboard_key text not null check (dashboard_key ~ '^(top:[1-9][0-9]*|manager:(development|support)|route-planner|currency-rates)$'),
      event_id text not null check (event_id ~ '^[a-zA-Z0-9_-]{16,80}$'),
      action text not null check (action in ('report_open','tab_changed','filter_changed','calculation_completed','data_loaded','export_started')),
      is_preview boolean not null default false,
      html_version_id bigint check (html_version_id > 0),
      created_at timestamptz not null default now(),
      unique(actor_key, event_id)
    );
    create index dashboard_usage_events_recent_idx on dashboard_usage_events(id desc);
    create index dashboard_usage_events_actor_idx on dashboard_usage_events(actor_key, id desc);
    create index dashboard_usage_events_dashboard_idx on dashboard_usage_events(dashboard_key, id desc);
  `);
}
