import type { PoolClient } from 'pg';

/** Additive migration: operational roles, price lists and private snapshot ownership are untouched. */
export async function applyDashboardAccessMigration(client: PoolClient) {
  await client.query(`
    create table dashboard_view_grants (
      id bigserial primary key,
      admin_user_id bigint references admin_users(id) on delete cascade,
      manager_id bigint references wholesale_managers(id) on delete cascade,
      key text not null check (key in ('manager:development','manager:support','route-planner','currency-rates') or key ~ '^top:[1-9][0-9]{0,15}$'),
      top_block_id bigint generated always as (case when key like 'top:%' then substring(key from 5)::bigint end) stored references top_dashboard_blocks(id) on delete cascade,
      created_at timestamptz not null default now(),
      check (num_nonnulls(admin_user_id,manager_id)=1),
      unique(admin_user_id,key), unique(manager_id,key)
    );
    create index dashboard_view_grants_key_idx on dashboard_view_grants(key);
    insert into dashboard_view_grants(admin_user_id,key)
      select a.user_id,a.key from admin_user_dashboard_access a join admin_users u on u.id=a.user_id
      where u.role='purchaser' and (a.key='route-planner' or exists(select 1 from top_dashboard_blocks b where 'top:' || b.id = a.key));
    insert into dashboard_view_grants(admin_user_id,key)
      select u.id,'top:' || b.id from admin_users u cross join top_dashboard_blocks b where u.role in ('admin','admintop','top') on conflict do nothing;
    insert into dashboard_view_grants(manager_id,key)
      select m.id,'top:' || b.id from wholesale_managers m cross join top_dashboard_blocks b
      where m.can_access_top_dashboard or m.can_manage_top_dashboard on conflict do nothing;
    insert into dashboard_view_grants(admin_user_id,key)
      select u.id,k.key from admin_users u cross join (values ('manager:development'),('manager:support'),('route-planner'),('currency-rates')) k(key)
      where u.role in ('admin','admintop') or (u.role='top' and k.key='currency-rates') on conflict do nothing;
    insert into dashboard_view_grants(manager_id,key)
      select m.id,k.key from wholesale_managers m cross join (values ('manager:development'),('manager:support'),('route-planner'),('currency-rates')) k(key)
      where (coalesce(nullif(m.role,''),'manager')='manager' and k.key in ('manager:development','currency-rates'))
         or (m.role='support_manager' and k.key in ('manager:support','route-planner','currency-rates')) on conflict do nothing;
  `);
}
