import type { PoolClient } from 'pg';

/** Legacy grants stay individual; only an explicit later save enables future employees. */
export async function applyDashboardAudiencePolicyMigration(client: PoolClient) {
  await client.query(`
    create table dashboard_audience_policies (
      key text primary key check (key in ('manager:development','manager:support','route-planner','currency-rates') or key ~ '^top:[1-9][0-9]{0,15}$'),
      top_block_id bigint generated always as (case when key like 'top:%' then substring(key from 5)::bigint end) stored references top_dashboard_blocks(id) on delete cascade,
      mode text not null check (mode in ('individual','all')),
      revision bigint not null default 1,
      updated_at timestamptz not null default now()
    );
    create table dashboard_audience_exclusions (
      id bigserial primary key,
      key text not null references dashboard_audience_policies(key) on delete cascade,
      admin_user_id bigint references admin_users(id) on delete cascade,
      manager_id bigint references wholesale_managers(id) on delete cascade,
      check (num_nonnulls(admin_user_id,manager_id)=1),
      unique(admin_user_id,key), unique(manager_id,key)
    );
    create index dashboard_audience_exclusions_key_idx on dashboard_audience_exclusions(key);
    create view dashboard_effective_view_grants as
      select g.admin_user_id,g.manager_id,g.key from dashboard_view_grants g
        where not exists(select 1 from dashboard_audience_exclusions e join dashboard_audience_policies p on p.key=e.key and p.mode='all'
          where e.key=g.key and (e.admin_user_id=g.admin_user_id or e.manager_id=g.manager_id))
      union
      select u.id,null::bigint,p.key from admin_users u cross join dashboard_audience_policies p
        where p.mode='all' and p.key not in ('manager:development','manager:support')
          and not exists(select 1 from dashboard_audience_exclusions e where e.key=p.key and e.admin_user_id=u.id)
      union
      select null::bigint,m.id,p.key from wholesale_managers m cross join dashboard_audience_policies p
        where p.mode='all'
          and (p.key not in ('manager:development','manager:support')
            or (p.key='manager:development' and coalesce(nullif(m.role,''),'manager')='manager')
            or (p.key='manager:support' and m.role='support_manager'))
          and not exists(select 1 from dashboard_audience_exclusions e where e.key=p.key and e.manager_id=m.id);
  `);
}
