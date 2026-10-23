import { analyticsQuery } from './performance';
import { type AnalyticsChangeRow, type AnalyticsProblemRow, type AnalyticsSummaryRow } from './rows';

export function readManagerManager(managerId: number) {
  return analyticsQuery<{
    id: string;
    name: string;
    login: string;
    email: string;
    phone: string;
    role: string | null;
    last_login_at: string | null;
    analytics_revision: string;
  }>("readManagerManager",
    `select
       m.id::text,
       m.name,
       m.login,
       m.email,
       m.phone,
       m.updated_at::text as analytics_revision,
       coalesce(nullif(m.role, ''), 'manager') as role,
       last_login.created_at::text as last_login_at
     from wholesale_managers m
     left join lateral (
       select created_at
       from wholesale_manager_login_logs
       where manager_id = m.id
       order by created_at desc, id desc
       limit 1
     ) last_login on true
     where m.id = $1
     limit 1`,
    [managerId],
  );
}

export function readManagerSummary(managerId: number, interval: string | null) {
  return analyticsQuery<AnalyticsSummaryRow>("readManagerSummary",
    `with manager_prices as (
       select
         pl.id,
         pl.client_name,
         pl.valid_until,
         pl.is_active,
         pl.created_at,
         count(i.id) filter (where i.visible = true)::integer as item_count
       from wholesale_price_lists pl
       left join wholesale_price_list_items i on i.price_list_id = pl.id
       where pl.manager_id = $1
       group by pl.id
     )
     select
       count(*)::text as total_prices,
       count(*) filter (where is_active)::text as active_prices,
       count(*) filter (where valid_until is not null and valid_until < current_date)::text as expired_prices,
       count(*) filter (where created_at >= now() - interval '7 days')::text as prices_last_7_days,
       count(*) filter (where created_at >= now() - interval '30 days')::text as prices_last_30_days,
       count(*) filter (where ($2::text is null or created_at >= now() - $2::interval))::text as period_prices,
       coalesce(round(avg(item_count)::numeric, 1), 0)::text as average_items_per_price,
       count(*) filter (where item_count = 0)::text as empty_prices,
       count(*) filter (where btrim(client_name) = '')::text as prices_without_client,
       count(*) filter (where valid_until is null)::text as prices_without_expiration
     from manager_prices`,
    [managerId, interval],
  );
}

export function readManagerLastCreated(managerId: number) {
  return analyticsQuery<{
    id: string;
    title: string;
    created_at: string;
  }>("readManagerLastCreated",
    `select id::text, title, created_at::text
     from wholesale_price_lists
     where manager_id = $1
     order by created_at desc, id desc
     limit 1`,
    [managerId],
  );
}

export function readManagerRecentChanges(managerId: number, interval: string | null) {
  return analyticsQuery<AnalyticsChangeRow>("readManagerRecentChanges",
    `select
       e.id::text,
       e.price_list_id::text as price_id,
       coalesce(nullif(e.title_snapshot, ''), pl.title, 'Без названия') as price_title,
       e.action,
       coalesce(
         nullif(e.actor_label, ''),
         actor.name,
         case
           when e.actor_role = 'admin' then 'Администратор'
           when e.actor_role = 'wholesale_admin' then 'Администратор прайсов'
           when e.actor_role = 'manager' then 'Менеджер по развитию'
           when e.actor_role = 'support_manager' then 'Менеджер по сопровождению'
           else 'Не указано'
         end
       ) as changed_by,
       e.created_at::text,
       e.details
     from wholesale_price_list_events e
     left join wholesale_price_lists pl on pl.id = e.price_list_id
     left join wholesale_managers actor on actor.id = e.manager_id
     where coalesce(e.owner_manager_id, pl.manager_id, e.manager_id) = $1
       and ($2::text is null or e.created_at >= now() - $2::interval)
     order by e.created_at desc, e.id desc
     limit 12`,
    [managerId, interval],
  );
}

export function readManagerLastChange(managerId: number) {
  return analyticsQuery<AnalyticsChangeRow>("readManagerLastChange",
    `select
       e.id::text,
       e.price_list_id::text as price_id,
       coalesce(nullif(e.title_snapshot, ''), pl.title, 'Без названия') as price_title,
       e.action,
       coalesce(
         nullif(e.actor_label, ''),
         actor.name,
         case
           when e.actor_role = 'admin' then 'Администратор'
           when e.actor_role = 'wholesale_admin' then 'Администратор прайсов'
           when e.actor_role = 'manager' then 'Менеджер по развитию'
           when e.actor_role = 'support_manager' then 'Менеджер по сопровождению'
           else 'Не указано'
         end
       ) as changed_by,
       e.created_at::text,
       e.details
     from wholesale_price_list_events e
     left join wholesale_price_lists pl on pl.id = e.price_list_id
     left join wholesale_managers actor on actor.id = e.manager_id
     where coalesce(e.owner_manager_id, pl.manager_id, e.manager_id) = $1
     order by e.created_at desc, e.id desc
     limit 1`,
    [managerId],
  );
}

export function readManagerProblem(managerId: number) {
  return analyticsQuery<AnalyticsProblemRow>("readManagerProblem",
    `with manager_prices as (
       select
         pl.id,
         pl.title,
         pl.client_name,
         pl.valid_until::text as valid_until,
         pl.valid_until as valid_until_date,
         pl.created_at::text,
         count(i.id) filter (where i.visible = true)::text as item_count
       from wholesale_price_lists pl
       left join wholesale_price_list_items i on i.price_list_id = pl.id
       where pl.manager_id = $1
       group by pl.id
     )
     select id::text, title, client_name, valid_until::text, created_at, item_count
     from manager_prices
     where item_count::integer = 0
        or btrim(client_name) = ''
        or valid_until_date is null
        or valid_until_date < current_date
     order by
       case when valid_until_date is not null and valid_until_date < current_date then 0 else 1 end,
       created_at desc,
       id desc
     limit 50`,
    [managerId],
  );
}

export function readManagerPublicViews(managerId: number, interval: string | null) {
  return analyticsQuery<{
    total: string;
    last_7_days: string;
    last_30_days: string;
    period_views: string;
    last_view_at: string | null;
  }>("readManagerPublicViews",
    `select
       count(e.id)::text as total,
       count(e.id) filter (where e.created_at >= now() - interval '7 days')::text as last_7_days,
       count(e.id) filter (where e.created_at >= now() - interval '30 days')::text as last_30_days,
       count(e.id) filter (where ($2::text is null or e.created_at >= now() - $2::interval))::text as period_views,
       max(e.created_at)::text as last_view_at
     from wholesale_price_lists pl
     left join wholesale_analytics_events e on e.price_list_id = pl.id
       and e.actor_type = 'client'
       and e.event_type in ('public_price_opened', 'public_price_reopened')
     where pl.manager_id = $1`,
    [managerId, interval],
  );
}

export function readManagerTopViews(managerId: number, interval: string | null) {
  return analyticsQuery<{
    price_id: string;
    title: string;
    views: string;
    last_view_at: string | null;
  }>("readManagerTopViews",
    `select
       pl.id::text as price_id,
       coalesce(nullif(pl.title, ''), 'Без названия') as title,
       count(e.id)::text as views,
       max(e.created_at)::text as last_view_at
     from wholesale_price_lists pl
     join wholesale_analytics_events e on e.price_list_id = pl.id
       and e.actor_type = 'client'
       and e.event_type in ('public_price_opened', 'public_price_reopened')
     where pl.manager_id = $1
       and ($2::text is null or e.created_at >= now() - $2::interval)
     group by pl.id
     order by count(e.id) desc, max(e.created_at) desc
     limit 5`,
    [managerId, interval],
  );
}
