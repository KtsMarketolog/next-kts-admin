import { query } from '../../client';
import { type AnalyticsEventRow } from './rows';

export function readManagerExtendedPriceStats(managerId: number, interval: string | null) {
  return query<{
    id: string;
    title: string;
    client_name: string;
    token: string;
    valid_until: string | null;
    workflow_status: string | null;
    is_active: boolean;
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
    change_count: string;
    last_changed_at: string | null;
    last_changed_by: string | null;
  }>(
    `select
       pl.id::text,
       coalesce(nullif(pl.title, ''), 'Без названия') as title,
       pl.client_name,
       pl.token,
       pl.valid_until::text,
       pl.workflow_status,
       pl.is_active,
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
       client_activity.last_client_event_type,
       coalesce(changes.change_count, 0)::text as change_count,
       changes.last_changed_at::text,
       changes.last_changed_by
     from wholesale_price_lists pl
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
         count(*) filter (where ($2::text is null or e.created_at >= now() - $2::interval))::integer as views_period,
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
         and ($2::text is null or e.created_at >= now() - $2::interval)
     ) view_events on true
     left join lateral (
       select
         count(*)::integer as pdf_downloads,
         count(*) filter (where created_at >= now() - interval '7 days')::integer as pdf_last_7_days,
         count(*) filter (where created_at >= now() - interval '30 days')::integer as pdf_last_30_days,
         count(*) filter (where ($2::text is null or created_at >= now() - $2::interval))::integer as pdf_period,
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
         count(*) filter (where ($2::text is null or created_at >= now() - $2::interval))::integer as excel_period,
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
         count(*) filter (where ($2::text is null or created_at >= now() - $2::interval))::integer as requests_period,
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
     left join lateral (
       select
         count(*)::integer as change_count,
         max(e.created_at) as last_changed_at,
         (array_agg(coalesce(nullif(e.actor_label, ''), actor.name, e.actor_role) order by e.created_at desc, e.id desc))[1] as last_changed_by
       from wholesale_price_list_events e
       left join wholesale_managers actor on actor.id = e.manager_id
       where e.price_list_id = pl.id
     ) changes on true
     where pl.manager_id = $1
     order by pl.updated_at desc, pl.id desc`,
    [managerId, interval],
  );
}

export function readManagerExtendedActivity(managerId: number, interval: string | null) {
  return query<{
    logins_last_7_days: string;
    logins_last_30_days: string;
    logins_period: string;
    active_days_period: string;
    actions_last_7_days: string;
    actions_last_30_days: string;
    actions_period: string;
    created_prices: string;
    updated_prices: string;
    activated_prices: string;
    deactivated_prices: string;
    deleted_prices: string;
  }>(
    `select
       count(*) filter (where event_type = 'manager_login' and created_at >= now() - interval '7 days')::text as logins_last_7_days,
       count(*) filter (where event_type = 'manager_login' and created_at >= now() - interval '30 days')::text as logins_last_30_days,
       count(*) filter (where event_type = 'manager_login' and ($2::text is null or created_at >= now() - $2::interval))::text as logins_period,
       count(distinct created_at::date) filter (where $2::text is null or created_at >= now() - $2::interval)::text as active_days_period,
       count(*) filter (where event_type <> 'manager_login' and created_at >= now() - interval '7 days')::text as actions_last_7_days,
       count(*) filter (where event_type <> 'manager_login' and created_at >= now() - interval '30 days')::text as actions_last_30_days,
       count(*) filter (where event_type <> 'manager_login' and ($2::text is null or created_at >= now() - $2::interval))::text as actions_period,
       count(*) filter (where event_type = 'price_created')::text as created_prices,
       count(*) filter (where event_type = 'price_updated')::text as updated_prices,
       count(*) filter (where event_type = 'price_activated')::text as activated_prices,
       count(*) filter (where event_type = 'price_deactivated')::text as deactivated_prices,
       count(*) filter (where event_type = 'price_deleted')::text as deleted_prices
     from wholesale_analytics_events
     where manager_id = $1
       and actor_type in ('admin', 'manager')`,
    [managerId, interval],
  );
}

export function readManagerExtendedRecentEvents(managerId: number, interval: string | null) {
  return query<AnalyticsEventRow>(
    `select
       e.id::text,
       e.event_type,
       e.actor_type,
       e.price_list_id::text as price_id,
       coalesce(nullif(pl.title, ''), e.metadata->>'title', 'Без названия') as price_title,
       e.client_id,
       coalesce(nullif(pl.client_name, ''), e.metadata->>'clientName', '') as client_name,
       coalesce(m.name, '') as manager_name,
       e.created_at::text,
       coalesce(nullif(e.metadata->>'details', ''), e.metadata::text) as details,
       e.session_id,
       e.referer
     from wholesale_analytics_events e
     left join wholesale_price_lists pl on pl.id = e.price_list_id
     left join wholesale_managers m on m.id = e.manager_id
     where e.manager_id = $1
       and ($2::text is null or e.created_at >= now() - $2::interval)
     order by e.created_at desc, e.id desc
     limit 200`,
    [managerId, interval],
  );
}

export function readManagerExtendedViews24(managerId: number) {
  return query<{ client_id: string; views: string; }>(
    `select coalesce(nullif(e.client_id, ''), lower(pl.client_name)) as client_id, count(*)::text as views
     from wholesale_analytics_events e
     left join wholesale_price_lists pl on pl.id = e.price_list_id
     where e.manager_id = $1
       and e.actor_type = 'client'
       and e.event_type in ('public_price_opened', 'public_price_reopened')
       and e.created_at >= now() - interval '24 hours'
     group by coalesce(nullif(e.client_id, ''), lower(pl.client_name))`,
    [managerId],
  );
}
