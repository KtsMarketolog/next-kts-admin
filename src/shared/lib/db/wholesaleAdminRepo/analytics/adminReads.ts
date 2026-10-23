import { analyticsQuery } from './performance';
import { clientEventAggregate } from './clientEventAggregate';
import { type AnalyticsEventRow } from './rows';

export type AdminManagerRow = {
  id: string;
  name: string;
  login: string;
  email: string;
  phone: string;
  is_active: boolean;
  last_login_at: string | null;
};

export type AdminPriceRow = {
  id: string;
  title: string;
  client_name: string;
  valid_until: string | null;
  workflow_status: string | null;
  is_active: boolean;
  manager_id: string | null;
  manager_name: string;
  created_at: string;
  updated_at: string;
  item_count: string;
  views: string;
  views_last_7_days: string;
  views_last_30_days: string;
  views_period: string;
  last_view_at: string | null;
  unique_visitors: string;
  repeat_views: string;
  pdf_downloads: string;
  pdf_last_7_days: string;
  pdf_last_30_days: string;
  pdf_period: string;
  unique_downloaders: string;
  last_pdf_at: string | null;
  excel_downloads: string;
  excel_last_7_days: string;
  excel_last_30_days: string;
  excel_period: string;
  unique_excel_downloaders: string;
  last_excel_at: string | null;
  requests_sent: string;
  requests_period: string;
  last_request_at: string | null;
  first_view_at: string | null;
  first_pdf_at: string | null;
  first_request_at: string | null;
  last_manager_activity_at: string | null;
  last_client_event_type: string | null;
};

export type AdminEventRow = AnalyticsEventRow & {
  manager_id: string | null;
};

export function readAdminManagers() {
  return analyticsQuery<AdminManagerRow>("readAdminManagers",
    `select
       m.id::text,
       m.name,
       m.login,
       m.email,
       m.phone,
       m.is_active,
       login_events.last_login_at::text
     from wholesale_managers m
     left join lateral (
       select max(e.created_at) as last_login_at
       from wholesale_analytics_events e
       where e.manager_id = m.id and e.event_type = 'manager_login'
     ) login_events on true
     order by m.name asc, m.id asc`,
  );
}

export function readAdminPriceStats(interval: string | null) {
  return analyticsQuery<AdminPriceRow>("readAdminPriceStats",
    `select
       pl.id::text,
       coalesce(nullif(pl.title, ''), 'Без названия') as title,
       coalesce(pl.client_name, '') as client_name,
       pl.valid_until::text,
       pl.workflow_status,
       pl.is_active,
       pl.manager_id::text,
       coalesce(m.name, 'Не назначен') as manager_name,
       pl.created_at::text,
       pl.updated_at::text,
       coalesce(items.item_count, 0)::text as item_count,
       coalesce(client_events.views, 0)::text as views,
       coalesce(client_events.views_last_7_days, 0)::text as views_last_7_days,
       coalesce(client_events.views_last_30_days, 0)::text as views_last_30_days,
       coalesce(client_events.views_period, 0)::text as views_period,
       client_events.last_view_at::text,
       coalesce(client_events.unique_visitors, 0)::text as unique_visitors,
       coalesce(client_events.repeat_views, 0)::text as repeat_views,
       coalesce(client_events.pdf_downloads, 0)::text as pdf_downloads,
       coalesce(client_events.pdf_last_7_days, 0)::text as pdf_last_7_days,
       coalesce(client_events.pdf_last_30_days, 0)::text as pdf_last_30_days,
       coalesce(client_events.pdf_period, 0)::text as pdf_period,
       coalesce(client_events.unique_downloaders, 0)::text as unique_downloaders,
       client_events.last_pdf_at::text,
       coalesce(client_events.excel_downloads, 0)::text as excel_downloads,
       coalesce(client_events.excel_last_7_days, 0)::text as excel_last_7_days,
       coalesce(client_events.excel_last_30_days, 0)::text as excel_last_30_days,
       coalesce(client_events.excel_period, 0)::text as excel_period,
       coalesce(client_events.unique_excel_downloaders, 0)::text as unique_excel_downloaders,
       client_events.last_excel_at::text,
       coalesce(client_events.requests_sent, 0)::text as requests_sent,
       coalesce(client_events.requests_period, 0)::text as requests_period,
       client_events.last_request_at::text,
       client_events.first_view_at::text,
       client_events.first_pdf_at::text,
       client_events.first_request_at::text,
       manager_actions.last_manager_activity_at::text,
       client_activity.last_client_event_type
     from wholesale_price_lists pl
     left join wholesale_managers m on m.id = pl.manager_id
     left join lateral (
       select count(*)::integer as item_count
       from wholesale_price_list_items i
       where i.price_list_id = pl.id and i.visible = true
     ) items on true
     ${clientEventAggregate("$1")}
     left join lateral (
       select max(e.created_at) as last_manager_activity_at
       from wholesale_analytics_events e
       where e.price_list_id = pl.id
         and e.actor_type in ('admin', 'manager')
         and e.event_type in (
           'price_updated',
           'price_status_changed',
           'price_client_changed',
           'price_expiration_changed',
           'price_items_added',
           'price_items_removed',
           'price_activated',
           'price_deactivated'
         )
     ) manager_actions on true
     left join lateral (
       select e.event_type as last_client_event_type
       from wholesale_analytics_events e
       where e.price_list_id = pl.id
         and e.actor_type = 'client'
         and e.event_type in (
           'public_price_opened',
           'public_price_reopened',
           'public_price_pdf_downloaded',
           'public_price_excel_downloaded',
           'public_price_request_sent',
           'public_price_phone_clicked',
           'public_price_email_clicked',
           'public_price_request_abandoned'
         )
       order by e.created_at desc, e.id desc
       limit 1
     ) client_activity on true
     order by pl.created_at desc, pl.id desc`,
    [interval],
  );
}

export function readAdminEventSummary(interval: string | null, managerActionEvents: string[], trackedManagerEvents: string[]) {
  return analyticsQuery<{
    actions_last_7_days: string;
    actions_last_30_days: string;
    actions_period: string;
    logins_last_7_days: string;
    logins_last_30_days: string;
    logins_period: string;
    active_days_period: string;
    active_managers_period: string;
  }>("readAdminEventSummary",
    `select
       count(*) filter (where event_type = any($2::text[]) and created_at >= now() - interval '7 days')::text as actions_last_7_days,
       count(*) filter (where event_type = any($2::text[]) and created_at >= now() - interval '30 days')::text as actions_last_30_days,
       count(*) filter (where event_type = any($2::text[]) and ($1::text is null or created_at >= now() - $1::interval))::text as actions_period,
       count(*) filter (where event_type = 'manager_login' and created_at >= now() - interval '7 days')::text as logins_last_7_days,
       count(*) filter (where event_type = 'manager_login' and created_at >= now() - interval '30 days')::text as logins_last_30_days,
       count(*) filter (where event_type = 'manager_login' and ($1::text is null or created_at >= now() - $1::interval))::text as logins_period,
       count(distinct created_at::date) filter (where event_type = any($3::text[]) and ($1::text is null or created_at >= now() - $1::interval))::text as active_days_period,
       count(distinct manager_id) filter (where manager_id is not null and event_type = any($3::text[]) and ($1::text is null or created_at >= now() - $1::interval))::text as active_managers_period
     from wholesale_analytics_events
     where actor_type in ('admin', 'manager')`,
    [interval, managerActionEvents, trackedManagerEvents],
  );
}

export function readAdminManagerActivity(interval: string | null, managerActionEvents: string[], trackedManagerEvents: string[]) {
  return analyticsQuery<{
    manager_id: string;
    actions_period: string;
    logins_period: string;
    active_days_period: string;
    last_action_at: string | null;
  }>("readAdminManagerActivity",
    `select
       manager_id::text,
       count(*) filter (where event_type = any($2::text[]) and ($1::text is null or created_at >= now() - $1::interval))::text as actions_period,
       count(*) filter (where event_type = 'manager_login' and ($1::text is null or created_at >= now() - $1::interval))::text as logins_period,
       count(distinct created_at::date) filter (where event_type = any($3::text[]) and ($1::text is null or created_at >= now() - $1::interval))::text as active_days_period,
       max(created_at) filter (where event_type = any($2::text[]))::text as last_action_at
     from wholesale_analytics_events
     where manager_id is not null
       and actor_type in ('admin', 'manager')
       and event_type = any($3::text[])
     group by manager_id`,
    [interval, managerActionEvents, trackedManagerEvents],
  );
}

export function readAdminLastLogin() {
  return analyticsQuery<{ manager_id: string | null; manager_name: string; created_at: string; }>("readAdminLastLogin",
    `select e.manager_id::text, coalesce(m.name, 'Не назначен') as manager_name, e.created_at::text
     from wholesale_analytics_events e
     left join wholesale_managers m on m.id = e.manager_id
     where e.event_type = 'manager_login' and e.manager_id is not null
     order by e.created_at desc, e.id desc
     limit 1`,
  );
}

export function readAdminLastAction(managerActionEvents: string[]) {
  return analyticsQuery<{
    event_type: string;
    manager_id: string | null;
    manager_name: string;
    price_title: string | null;
    client_name: string | null;
    created_at: string;
  }>("readAdminLastAction",
    `select
       e.event_type,
       e.manager_id::text,
       coalesce(m.name, 'Не назначен') as manager_name,
       coalesce(nullif(pl.title, ''), e.metadata->>'title', 'Без названия') as price_title,
       coalesce(nullif(pl.client_name, ''), e.metadata->>'clientName', '') as client_name,
       e.created_at::text
     from wholesale_analytics_events e
     left join wholesale_price_lists pl on pl.id = e.price_list_id
     left join wholesale_managers m on m.id = e.manager_id
     where e.event_type = any($1::text[])
     order by e.created_at desc, e.id desc
     limit 1`,
    [managerActionEvents],
  );
}

export function readAdminRecentEvents(interval: string | null) {
  return analyticsQuery<AdminEventRow>("readAdminRecentEvents",
    `select
       e.id::text,
       e.event_type,
       e.actor_type,
       e.manager_id::text,
       e.price_list_id::text as price_id,
       coalesce(nullif(pl.title, ''), e.metadata->>'title', 'Без названия') as price_title,
       e.client_id,
       coalesce(nullif(pl.client_name, ''), e.metadata->>'clientName', '') as client_name,
       coalesce(m.name, '') as manager_name,
       e.created_at::text,
       coalesce(nullif(e.metadata->>'details', ''), e.metadata::text, '') as details,
       e.session_id,
       e.referer
     from wholesale_analytics_events e
     left join wholesale_price_lists pl on pl.id = e.price_list_id
     left join wholesale_managers m on m.id = e.manager_id
     where ($1::text is null or e.created_at >= now() - $1::interval)
     order by e.created_at desc, e.id desc
     limit 200`,
    [interval],
  );
}

export function readAdminViews24() {
  return analyticsQuery<{ client_id: string; views: string; }>("readAdminViews24",
    `select coalesce(nullif(e.client_id, ''), lower(pl.client_name)) as client_id, count(*)::text as views
     from wholesale_analytics_events e
     left join wholesale_price_lists pl on pl.id = e.price_list_id
     where e.actor_type = 'client'
       and e.event_type in ('public_price_opened', 'public_price_reopened')
       and e.created_at >= now() - interval '24 hours'
       and coalesce(nullif(e.client_id, ''), lower(pl.client_name)) is not null
       and btrim(coalesce(nullif(e.client_id, ''), lower(pl.client_name))) <> ''
     group by coalesce(nullif(e.client_id, ''), lower(pl.client_name))`,
  );
}
