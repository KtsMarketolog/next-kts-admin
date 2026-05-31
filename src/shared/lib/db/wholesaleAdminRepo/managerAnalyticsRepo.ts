import { query } from '../client';
import { ensureSiteSchema } from '../schema';
import {
  buildClientHistory,
  buildPriorityClients,
  buildReactionNeeded,
  buildStatusFunnel,
  buildStuckPrices,
  getPeriodComparison,
  getProductInterest,
  mapAnalyticsChange,
  mapAnalyticsEvent,
  mapProblemPrice,
  periodSqlInterval,
  qualityScore,
  type AnalyticsChangeRow,
  type AnalyticsEventRow,
  type AnalyticsProblemRow,
  type AnalyticsSummaryRow,
  type AnalyticsWorkflowRow,
} from './analyticsHelpers';
import { managerRoleLabel } from './managerHelpers';
import type {
  WholesaleManagerAnalytics,
  WholesaleManagerAnalyticsClient,
  WholesaleManagerAnalyticsPeriod,
} from './types';
export async function getWholesaleManagerAnalytics(
  managerId: number,
  period: WholesaleManagerAnalyticsPeriod = '30d',
): Promise<WholesaleManagerAnalytics | null> {
  await ensureSiteSchema();
  const interval = periodSqlInterval(period);

  const managerResult = await query<{
    id: string;
    name: string;
    login: string;
    email: string;
    phone: string;
    role: string | null;
    last_login_at: string | null;
  }>(
    `select
       m.id::text,
       m.name,
       m.login,
       m.email,
       m.phone,
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
  const managerRow = managerResult.rows[0];
  if (!managerRow) return null;

  const summaryResult = await query<AnalyticsSummaryRow>(
    `with manager_prices as (
       select
         pl.id,
         pl.client_name,
         pl.valid_until,
         pl.is_active,
         pl.created_at,
         count(i.id)::integer as item_count
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
  const summaryRow = summaryResult.rows[0];

  const lastCreatedResult = await query<{
    id: string;
    title: string;
    created_at: string;
  }>(
    `select id::text, title, created_at::text
     from wholesale_price_lists
     where manager_id = $1
     order by created_at desc, id desc
     limit 1`,
    [managerId],
  );

  const recentChangesResult = await query<AnalyticsChangeRow>(
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

  const lastChangeResult = await query<AnalyticsChangeRow>(
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

  const problemResult = await query<AnalyticsProblemRow>(
    `with manager_prices as (
       select
         pl.id,
         pl.title,
         pl.client_name,
         pl.valid_until::text as valid_until,
         pl.valid_until as valid_until_date,
         pl.created_at::text,
         count(i.id)::text as item_count
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

  const publicViewsResult = await query<{
    total: string;
    last_7_days: string;
    last_30_days: string;
    period_views: string;
    last_view_at: string | null;
  }>(
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

  const topViewsResult = await query<{
    price_id: string;
    title: string;
    views: string;
    last_view_at: string | null;
  }>(
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

  const lastCreatedRow = lastCreatedResult.rows[0];
  const publicViewsRow = publicViewsResult.rows[0];

  return {
    manager: {
      id: Number(managerRow.id),
      name: managerRow.name,
      login: managerRow.login,
      email: managerRow.email,
      role: managerRoleLabel(managerRow.role),
      phone: managerRow.phone,
      lastLoginAt: managerRow.last_login_at,
    },
    summary: {
      totalPrices: Number(summaryRow?.total_prices ?? 0),
      activePrices: Number(summaryRow?.active_prices ?? 0),
      expiredPrices: Number(summaryRow?.expired_prices ?? 0),
      pricesLast7Days: Number(summaryRow?.prices_last_7_days ?? 0),
      pricesLast30Days: Number(summaryRow?.prices_last_30_days ?? 0),
      periodPrices: Number(summaryRow?.period_prices ?? 0),
      averageItemsPerPrice: Number(summaryRow?.average_items_per_price ?? 0),
      emptyPrices: Number(summaryRow?.empty_prices ?? 0),
      pricesWithoutClient: Number(summaryRow?.prices_without_client ?? 0),
      pricesWithoutExpiration: Number(summaryRow?.prices_without_expiration ?? 0),
    },
    lastCreatedPrice: lastCreatedRow
      ? {
          id: Number(lastCreatedRow.id),
          title: lastCreatedRow.title || 'Без названия',
          createdAt: lastCreatedRow.created_at,
        }
      : null,
    lastChange: lastChangeResult.rows[0] ? mapAnalyticsChange(lastChangeResult.rows[0]) : null,
    problemPrices: problemResult.rows.map(mapProblemPrice).filter((price) => price.problems.length > 0),
    recentChanges: recentChangesResult.rows.map(mapAnalyticsChange),
    publicViews: {
      total: Number(publicViewsRow?.total ?? 0),
      last7Days: Number(publicViewsRow?.last_7_days ?? 0),
      last30Days: Number(publicViewsRow?.last_30_days ?? 0),
      periodViews: Number(publicViewsRow?.period_views ?? 0),
      lastViewAt: publicViewsRow?.last_view_at ?? null,
      topPrices: topViewsResult.rows.map((row) => ({
        priceId: Number(row.price_id),
        title: row.title,
        views: Number(row.views),
        lastViewAt: row.last_view_at,
      })),
    },
  };
}

export async function getWholesaleManagerAnalyticsExtended(
  managerId: number,
  period: WholesaleManagerAnalyticsPeriod = '30d',
): Promise<WholesaleManagerAnalytics | null> {
  const base = await getWholesaleManagerAnalytics(managerId, period);
  if (!base) return null;

  const interval = periodSqlInterval(period);
  const priceStats = await query<{
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

  const rows = priceStats.rows;
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayTime = today.getTime();
  const validTime = (value: string | null) => (value ? new Date(`${value}T00:00:00`).getTime() : null);
  const itemCounts = rows.map((row) => Number(row.item_count)).sort((a, b) => a - b);
  const medianItemsPerPrice =
    itemCounts.length === 0
      ? 0
      : itemCounts.length % 2
        ? itemCounts[Math.floor(itemCounts.length / 2)]
        : (itemCounts[itemCounts.length / 2 - 1] + itemCounts[itemCounts.length / 2]) / 2;
  const expiredPrices = rows.filter((row) => {
    const value = validTime(row.valid_until);
    return value !== null && value < todayTime;
  }).length;
  const expiringSoon7Days = rows.filter((row) => {
    const value = validTime(row.valid_until);
    return value !== null && value >= todayTime && value <= todayTime + 7 * day;
  }).length;
  const expiringSoon30Days = rows.filter((row) => {
    const value = validTime(row.valid_until);
    return value !== null && value >= todayTime && value <= todayTime + 30 * day;
  }).length;
  const stalePrices30Days = rows.filter((row) => new Date(row.updated_at).getTime() < now - 30 * day).length;
  const pricesWithoutViews = rows.filter((row) => Number(row.views) === 0).length;
  const pricesWithoutPdfDownloads = rows.filter((row) => Number(row.pdf_downloads) === 0).length;
  const extendedProblems = rows
    .map((row) =>
      mapProblemPrice({
        id: row.id,
        title: row.title,
        client_name: row.client_name,
        valid_until: row.valid_until,
        created_at: row.created_at,
        updated_at: row.updated_at,
        item_count: row.item_count,
        views: row.views,
        pdf_downloads: row.pdf_downloads,
      }),
    )
    .filter((price) => price.problems.length > 0);

  const activity = await query<{
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

  const recentEventsResult = await query<AnalyticsEventRow>(
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
  const recentEvents = recentEventsResult.rows.map(mapAnalyticsEvent);
  const recentViews = recentEvents.filter((event) => event.actorType === 'client' && ['public_price_opened', 'public_price_reopened'].includes(event.eventType));
  const recentDownloads = recentEvents.filter((event) => event.actorType === 'client' && event.eventType === 'public_price_pdf_downloaded');
  const lastAction = recentEvents.find((event) => event.actorType === 'admin' || event.actorType === 'manager') ?? null;

  const topViewed = [...rows].filter((row) => Number(row.views) > 0).sort((a, b) => Number(b.views) - Number(a.views));
  const topDownloaded = [...rows]
    .filter((row) => Number(row.pdf_downloads) > 0)
    .sort((a, b) => Number(b.pdf_downloads) - Number(a.pdf_downloads));
  const mostChanged = [...rows].filter((row) => Number(row.change_count) > 0).sort((a, b) => Number(b.change_count) - Number(a.change_count));

  const clientMap = new Map<string, WholesaleManagerAnalyticsClient>();
  for (const row of rows) {
    const clientName = row.client_name.trim();
    if (!clientName) continue;
    const key = clientName.toLowerCase();
    const current =
      clientMap.get(key) ??
      ({
        clientId: key,
        clientName,
        priceId: Number(row.id),
        priceTitle: row.title,
        priceCount: 0,
        viewsLast24Hours: 0,
        viewsLast7Days: 0,
        views: 0,
        uniqueVisitors: 0,
        pdfDownloads: 0,
        lastActivityAt: null,
        lastPriceCreatedAt: null,
        status: 'Не открывал',
      } satisfies WholesaleManagerAnalyticsClient);
    current.priceCount += 1;
    current.views += Number(row.views);
    current.viewsLast7Days += Number(row.views_last_7_days);
    current.uniqueVisitors += Number(row.unique_visitors);
    current.pdfDownloads += Number(row.pdf_downloads);
    const lastActivity = [row.last_view_at, row.last_pdf_at].filter(Boolean).sort().at(-1) ?? null;
    if (lastActivity && (!current.lastActivityAt || lastActivity > current.lastActivityAt)) {
      current.lastActivityAt = lastActivity;
      current.priceId = Number(row.id);
      current.priceTitle = row.title;
    }
    if (!current.lastPriceCreatedAt || row.created_at > current.lastPriceCreatedAt) current.lastPriceCreatedAt = row.created_at;
    clientMap.set(key, current);
  }

  const views24 = await query<{ client_id: string; views: string }>(
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
  for (const row of views24.rows) {
    const client = clientMap.get(row.client_id);
    if (client) client.viewsLast24Hours = Number(row.views);
  }
  const workflowRows: AnalyticsWorkflowRow[] = rows.map((row) => ({
    ...row,
    manager_id: String(managerId),
    manager_name: base.manager.name,
  }));
  const views24ByClient = new Map(views24.rows.map((row) => [row.client_id, Number(row.views)]));
  const statusFunnel = buildStatusFunnel(workflowRows);
  const stuckPrices = buildStuckPrices(workflowRows, now, todayTime, day);
  const managerReactionNeeded = buildReactionNeeded(workflowRows, now);
  const priorityClients = buildPriorityClients(workflowRows, views24ByClient, managerReactionNeeded);
  const clientHistory = buildClientHistory(workflowRows, now, todayTime);
  const [productInterest, comparison] = await Promise.all([
    getProductInterest(managerId, interval),
    getPeriodComparison(managerId, period),
  ]);
  const clients = Array.from(clientMap.values()).map((client) => {
    let status = 'Не открывал';
    if (client.views > 0) status = 'Смотрел';
    if (client.pdfDownloads > 0) status = 'Скачал PDF';
    if (client.viewsLast24Hours >= 2 || client.viewsLast7Days >= 3 || client.pdfDownloads > 0) status = 'Горячий';
    return { ...client, status };
  });

  const totalViews = rows.reduce((sum, row) => sum + Number(row.views), 0);
  const totalPdf = rows.reduce((sum, row) => sum + Number(row.pdf_downloads), 0);
  const activityRow = activity.rows[0];
  const quality = qualityScore({
    emptyPrices: base.summary.emptyPrices,
    pricesWithoutClient: base.summary.pricesWithoutClient,
    pricesWithoutExpiration: base.summary.pricesWithoutExpiration,
    expiredPrices,
    pricesWithoutViews,
    stalePrices30Days,
  });

  return {
    ...base,
    summary: {
      ...base.summary,
      expiredPrices,
      expiringSoon7Days,
      expiringSoon30Days,
      medianItemsPerPrice: Number(medianItemsPerPrice.toFixed(1)),
      stalePrices30Days,
      pricesWithoutViews,
      qualityScore: quality,
      disabledPrices: rows.length - rows.filter((row) => row.is_active).length,
      pricesWithoutPdfDownloads,
    },
    managerActivity: {
      loginsLast7Days: Number(activityRow?.logins_last_7_days ?? 0),
      loginsLast30Days: Number(activityRow?.logins_last_30_days ?? 0),
      loginsInSelectedPeriod: Number(activityRow?.logins_period ?? 0),
      activeDaysInSelectedPeriod: Number(activityRow?.active_days_period ?? 0),
      actionsLast7Days: Number(activityRow?.actions_last_7_days ?? 0),
      actionsLast30Days: Number(activityRow?.actions_last_30_days ?? 0),
      actionsInSelectedPeriod: Number(activityRow?.actions_period ?? 0),
      lastAction: lastAction ? { eventType: lastAction.eventType, priceTitle: lastAction.priceTitle, clientName: lastAction.clientName, createdAt: lastAction.createdAt } : null,
      createdPrices: Number(activityRow?.created_prices ?? 0),
      updatedPrices: Number(activityRow?.updated_prices ?? 0),
      activatedPrices: Number(activityRow?.activated_prices ?? 0),
      deactivatedPrices: Number(activityRow?.deactivated_prices ?? 0),
      deletedPrices: Number(activityRow?.deleted_prices ?? 0),
    },
    problemPrices: extendedProblems,
    publicViews: {
      ...base.publicViews,
      total: totalViews,
      uniqueVisitors: rows.reduce((sum, row) => sum + Number(row.unique_visitors), 0),
      last7Days: rows.reduce((sum, row) => sum + Number(row.views_last_7_days), 0),
      last30Days: rows.reduce((sum, row) => sum + Number(row.views_last_30_days), 0),
      periodViews: rows.reduce((sum, row) => sum + Number(row.views_period), 0),
      repeatViews: rows.reduce((sum, row) => sum + Number(row.repeat_views), 0),
      lastViewAt: rows.map((row) => row.last_view_at).filter(Boolean).sort().at(-1) ?? null,
      pricesWithoutViews,
      averageViewsPerPrice: rows.length ? Number((totalViews / rows.length).toFixed(1)) : 0,
      topPrices: topViewed.slice(0, 5).map((row) => ({
        priceId: Number(row.id),
        title: row.title,
        clientName: row.client_name,
        views: Number(row.views),
        uniqueVisitors: Number(row.unique_visitors),
        lastViewAt: row.last_view_at,
      })),
      recentViews,
      pricesWithoutViewsList: extendedProblems.filter((price) => price.problems.includes('NO_VIEWS')),
    },
    pdf: {
      totalDownloads: totalPdf,
      downloadsLast7Days: rows.reduce((sum, row) => sum + Number(row.pdf_last_7_days), 0),
      downloadsLast30Days: rows.reduce((sum, row) => sum + Number(row.pdf_last_30_days), 0),
      downloadsInSelectedPeriod: rows.reduce((sum, row) => sum + Number(row.pdf_period), 0),
      uniqueDownloaders: rows.reduce((sum, row) => sum + Number(row.unique_downloaders), 0),
      lastDownloadAt: rows.map((row) => row.last_pdf_at).filter(Boolean).sort().at(-1) ?? null,
      pricesWithDownloads: rows.filter((row) => Number(row.pdf_downloads) > 0).length,
      pricesWithoutDownloads: pricesWithoutPdfDownloads,
      topDownloadedPrices: topDownloaded.slice(0, 5).map((row) => ({
        priceId: Number(row.id),
        title: row.title,
        clientName: row.client_name,
        downloads: Number(row.pdf_downloads),
        uniqueDownloaders: Number(row.unique_downloaders),
        views: Number(row.views),
        lastDownloadAt: row.last_pdf_at,
      })),
      recentDownloads,
      clientsWithPdfDownloads: clients
        .filter((client) => client.pdfDownloads > 0 && client.priceId)
        .slice(0, 10)
        .map((client) => ({
          clientId: client.clientId,
          clientName: client.clientName,
          priceId: client.priceId ?? 0,
          priceTitle: client.priceTitle,
          downloads: client.pdfDownloads,
          lastDownloadAt: client.lastActivityAt,
        })),
    },
    clients: {
      totalClients: clients.length,
      clientsWithPrices: clients.length,
      clientsWithViews: clients.filter((client) => client.views > 0).length,
      clientsWithoutViews: clients.filter((client) => client.views === 0).length,
      clientsWithPdfDownloads: clients.filter((client) => client.pdfDownloads > 0).length,
      hotClients: clients.filter((client) => client.status === 'Горячий').slice(0, 10),
      topClientsByViews: [...clients].sort((a, b) => b.views - a.views).slice(0, 10),
      clientsWithoutRecentActivity: clients.filter((client) => client.views === 0).slice(0, 20),
    },
    funnel: {
      createdPrices: rows.length,
      activePublicLinks: rows.filter((row) => row.is_active).length,
      openedPrices: rows.filter((row) => Number(row.views) > 0).length,
      pricesWithRepeatViews: rows.filter((row) => Number(row.repeat_views) > 0).length,
      pdfDownloadedPrices: rows.filter((row) => Number(row.pdf_downloads) > 0).length,
      requestsSent: rows.filter((row) => Number(row.requests_sent) > 0).length,
      contactClicks: recentEvents.filter((event) => ['public_price_phone_clicked', 'public_price_email_clicked'].includes(event.eventType)).length,
    },
    attention: {
      statusFunnel,
      stuckPrices,
      managerReactionNeeded,
      priorityClients,
      clientHistory,
      productInterest,
      comparison,
    },
    priceInsights: {
      expiringSoon: extendedProblems.filter((price) => price.problems.includes('EXPIRING_SOON')),
      pricesWithoutViews: extendedProblems.filter((price) => price.problems.includes('NO_VIEWS')),
      topViewedPrices: topViewed.slice(0, 10).map((row) => ({
        priceId: Number(row.id),
        title: row.title,
        clientName: row.client_name,
        views: Number(row.views),
        uniqueVisitors: Number(row.unique_visitors),
        pdfDownloads: Number(row.pdf_downloads),
        lastViewAt: row.last_view_at,
      })),
      mostChangedPrices: mostChanged.slice(0, 10).map((row) => ({
        priceId: Number(row.id),
        title: row.title,
        clientName: row.client_name,
        changes: Number(row.change_count),
        lastChangedAt: row.last_changed_at,
        lastChangedBy: row.last_changed_by || 'Не указано',
      })),
      largestPrice: rows.length
        ? [...rows].sort((a, b) => Number(b.item_count) - Number(a.item_count)).map((row) => ({ id: Number(row.id), title: row.title, itemCount: Number(row.item_count) }))[0]
        : null,
      smallestNonEmptyPrice:
        rows.filter((row) => Number(row.item_count) > 0).length > 0
          ? [...rows]
              .filter((row) => Number(row.item_count) > 0)
              .sort((a, b) => Number(a.item_count) - Number(b.item_count))
              .map((row) => ({ id: Number(row.id), title: row.title, itemCount: Number(row.item_count) }))[0]
          : null,
    },
    recentEvents,
  };
}
