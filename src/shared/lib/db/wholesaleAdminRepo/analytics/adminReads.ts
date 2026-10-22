import { query } from '../../client';
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
  return query<AdminManagerRow>(
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
  return query<AdminPriceRow>(
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
       coalesce(views.views, 0)::text as views,
       coalesce(views.views_last_7_days, 0)::text as views_last_7_days,
       coalesce(views.views_last_30_days, 0)::text as views_last_30_days,
       coalesce(views.views_period, 0)::text as views_period,
       views.last_view_at::text,
       coalesce(view_events.unique_visitors, 0)::text as unique_visitors,
       coalesce(view_events.repeat_views, 0)::text as repeat_views,
       coalesce(pdf.pdf_downloads, 0)::text as pdf_downloads,
       coalesce(pdf.pdf_last_7_days, 0)::text as pdf_last_7_days,
       coalesce(pdf.pdf_last_30_days, 0)::text as pdf_last_30_days,
       coalesce(pdf.pdf_period, 0)::text as pdf_period,
       coalesce(pdf.unique_downloaders, 0)::text as unique_downloaders,
       pdf.last_pdf_at::text,
       coalesce(excel.excel_downloads, 0)::text as excel_downloads,
       coalesce(excel.excel_last_7_days, 0)::text as excel_last_7_days,
       coalesce(excel.excel_last_30_days, 0)::text as excel_last_30_days,
       coalesce(excel.excel_period, 0)::text as excel_period,
       coalesce(excel.unique_downloaders, 0)::text as unique_excel_downloaders,
       excel.last_excel_at::text,
       coalesce(requests.requests_sent, 0)::text as requests_sent,
       coalesce(requests.requests_period, 0)::text as requests_period,
       requests.last_request_at::text,
       views.first_view_at::text,
       pdf.first_pdf_at::text,
       requests.first_request_at::text,
       manager_actions.last_manager_activity_at::text,
       client_activity.last_client_event_type
     from wholesale_price_lists pl
     left join wholesale_managers m on m.id = pl.manager_id
     left join lateral (
       select count(*)::integer as item_count
       from wholesale_price_list_items i
       where i.price_list_id = pl.id and i.visible = true
     ) items on true
     left join lateral (
       select
         count(*)::integer as views,
         count(*) filter (where e.created_at >= now() - interval '7 days')::integer as views_last_7_days,
         count(*) filter (where e.created_at >= now() - interval '30 days')::integer as views_last_30_days,
         count(*) filter (where ($1::text is null or e.created_at >= now() - $1::interval))::integer as views_period,
         max(e.created_at) as last_view_at,
         min(e.created_at) as first_view_at
       from wholesale_analytics_events e
       where e.price_list_id = pl.id
         and e.actor_type = 'client'
         and e.event_type in ('public_price_opened', 'public_price_reopened')
     ) views on true
     left join lateral (
       select
         count(distinct nullif(session_id, ''))::integer as unique_visitors,
         count(*) filter (where event_type = 'public_price_reopened')::integer as repeat_views
       from wholesale_analytics_events e
       where e.price_list_id = pl.id
         and e.actor_type = 'client'
         and e.event_type in ('public_price_opened', 'public_price_reopened')
         and ($1::text is null or e.created_at >= now() - $1::interval)
     ) view_events on true
     left join lateral (
       select
         count(*)::integer as pdf_downloads,
         count(*) filter (where created_at >= now() - interval '7 days')::integer as pdf_last_7_days,
         count(*) filter (where created_at >= now() - interval '30 days')::integer as pdf_last_30_days,
         count(*) filter (where ($1::text is null or created_at >= now() - $1::interval))::integer as pdf_period,
         count(distinct nullif(session_id, ''))::integer as unique_downloaders,
         max(created_at) as last_pdf_at,
         min(created_at) as first_pdf_at
       from wholesale_analytics_events e
       where e.price_list_id = pl.id
         and e.actor_type = 'client'
         and e.event_type = 'public_price_pdf_downloaded'
     ) pdf on true
     left join lateral (
       select
         count(*)::integer as excel_downloads,
         count(*) filter (where created_at >= now() - interval '7 days')::integer as excel_last_7_days,
         count(*) filter (where created_at >= now() - interval '30 days')::integer as excel_last_30_days,
         count(*) filter (where ($1::text is null or created_at >= now() - $1::interval))::integer as excel_period,
         count(distinct nullif(session_id, ''))::integer as unique_downloaders,
         max(created_at) as last_excel_at
       from wholesale_analytics_events e
       where e.price_list_id = pl.id
         and e.actor_type = 'client'
         and e.event_type = 'public_price_excel_downloaded'
     ) excel on true
     left join lateral (
       select
         count(*)::integer as requests_sent,
         count(*) filter (where ($1::text is null or created_at >= now() - $1::interval))::integer as requests_period,
         max(created_at) as last_request_at,
         min(created_at) as first_request_at
       from wholesale_analytics_events e
       where e.price_list_id = pl.id
         and e.actor_type = 'client'
         and e.event_type = 'public_price_request_sent'
     ) requests on true
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
  return query<{
    actions_last_7_days: string;
    actions_last_30_days: string;
    actions_period: string;
    logins_last_7_days: string;
    logins_last_30_days: string;
    logins_period: string;
    active_days_period: string;
    active_managers_period: string;
  }>(
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
  return query<{
    manager_id: string;
    actions_period: string;
    logins_period: string;
    active_days_period: string;
    last_action_at: string | null;
  }>(
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
  return query<{ manager_id: string | null; manager_name: string; created_at: string; }>(
    `select e.manager_id::text, coalesce(m.name, 'Не назначен') as manager_name, e.created_at::text
     from wholesale_analytics_events e
     left join wholesale_managers m on m.id = e.manager_id
     where e.event_type = 'manager_login' and e.manager_id is not null
     order by e.created_at desc, e.id desc
     limit 1`,
  );
}

export function readAdminLastAction(managerActionEvents: string[]) {
  return query<{
    event_type: string;
    manager_id: string | null;
    manager_name: string;
    price_title: string | null;
    client_name: string | null;
    created_at: string;
  }>(
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
  return query<AdminEventRow>(
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
  return query<{ client_id: string; views: string; }>(
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
