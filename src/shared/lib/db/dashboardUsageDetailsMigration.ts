import type { PoolClient } from 'pg';

/** Add reviewed metadata only; existing reports, credentials and usage rows are preserved. */
export async function applyDashboardUsageDetailsMigration(client: PoolClient) {
  await client.query(`
    alter table dashboard_usage_events drop constraint dashboard_usage_events_action_check;
    alter table dashboard_usage_events add constraint dashboard_usage_events_action_check
      check (action in ('report_open','tab_changed','filter_changed','calculation_completed','data_loaded','export_started','file_uploaded','viewing_time'));
    create table dashboard_usage_event_details (
      usage_event_id bigint primary key references dashboard_usage_events(id) on delete cascade,
      upload_name text,
      upload_size bigint,
      upload_type text check (upload_type in ('html','data','personal')),
      duration_seconds smallint,
      viewing_window_id text,
      check (
        (upload_name is not null and char_length(upload_name) between 1 and 255
          and char_length(btrim(upload_name)) > 0 and upload_name not in ('.','..')
          and position('/' in upload_name) = 0 and position(chr(92) in upload_name) = 0
          and upload_name !~ '[[:cntrl:]]'
          and upload_size is not null and upload_size between 0 and 2147483648
          and duration_seconds is null and viewing_window_id is null)
        or
        (upload_name is null and upload_size is null and upload_type is null
          and duration_seconds is not null and duration_seconds between 1 and 60
          and viewing_window_id is not null and viewing_window_id ~ '^[a-zA-Z0-9_-]{16,80}$')
      )
    );
  `);
}
