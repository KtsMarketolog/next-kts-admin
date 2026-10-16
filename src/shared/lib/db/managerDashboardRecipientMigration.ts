import type { PoolClient } from 'pg';

/** Add leader ownership without copying, reassigning or removing existing manager snapshots. */
export async function applyPersonalDashboardRecipientMigration(client: PoolClient) {
  await client.query(`
    alter table personal_dashboard_snapshots
      add column admin_user_id bigint references admin_users(id) on delete cascade,
      alter column manager_id drop not null,
      add constraint personal_dashboard_snapshots_owner_check check (num_nonnulls(manager_id,admin_user_id)=1),
      add constraint personal_dashboard_snapshots_admin_hash_key unique (admin_user_id,sha256),
      add constraint personal_dashboard_snapshots_admin_id_key unique (admin_user_id,id);
    alter table personal_dashboard_snapshot_state
      drop constraint personal_dashboard_snapshot_state_pkey,
      alter column manager_id drop not null,
      add column admin_user_id bigint references admin_users(id) on delete cascade,
      add constraint personal_dashboard_snapshot_state_manager_key unique (manager_id),
      add constraint personal_dashboard_snapshot_state_admin_key unique (admin_user_id),
      add constraint personal_dashboard_snapshot_state_owner_check check (num_nonnulls(manager_id,admin_user_id)=1),
      add constraint personal_dashboard_snapshot_state_admin_active_fkey
        foreign key (admin_user_id,active_snapshot_id) references personal_dashboard_snapshots(admin_user_id,id)
        on delete no action deferrable initially deferred,
      add constraint personal_dashboard_snapshot_state_admin_previous_fkey
        foreign key (admin_user_id,previous_snapshot_id) references personal_dashboard_snapshots(admin_user_id,id)
        on delete no action deferrable initially deferred;
    alter table personal_dashboard_imports
      add column admin_user_id bigint references admin_users(id) on delete set null,
      add constraint personal_dashboard_imports_owner_check check (num_nonnulls(manager_id,admin_user_id)<=1);
    create index personal_dashboard_snapshots_admin_date_idx
      on personal_dashboard_snapshots(admin_user_id,issued desc,id desc) where admin_user_id is not null;
  `);
}
