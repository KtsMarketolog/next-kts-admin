import { query } from '../client';
import { ensureSiteSchema } from '../schema';
import {
  buildClientHistory,
  buildPriorityClients,
  buildReactionNeeded,
  buildStatusFunnel,
  buildStuckPrices,
  clientIdFromName,
  getPeriodComparison,
  getProductInterest,
  mapAnalyticsEvent,
  mapProblemPrice,
  periodSqlInterval,
  qualityScore,
  rowStatus,
  type AnalyticsEventRow,
  type AnalyticsWorkflowRow,
} from './analyticsHelpers';
import type {
  WholesaleAdminAnalytics,
  WholesaleAdminAnalyticsClient,
  WholesaleAdminAnalyticsEvent,
  WholesaleAdminAnalyticsManager,
  WholesaleAdminAnalyticsPeriod,
  WholesaleAdminAnalyticsProblemPrice,
} from './types';
export async function getWholesaleAdminAnalytics(period: WholesaleAdminAnalyticsPeriod = '30d'): Promise<WholesaleAdminAnalytics> {
  await ensureSiteSchema();

  const interval = periodSqlInterval(period);
  const managerActionEvents = [
    'price_created',
    'price_updated',
    'price_deleted',
    'price_activated',
    'price_deactivated',
    'price_client_changed',
    'price_expiration_changed',
    'price_items_added',
    'price_items_removed',
    'price_status_changed',
    'price_public_link_created',
    'price_public_link_copied',
  ];
  const trackedManagerEvents = [...managerActionEvents, 'manager_login'];

  type AdminManagerRow = {
    id: string;
    name: string;
    login: string;
    email: string;
    phone: string;
    is_active: boolean;
    last_login_at: string | null;
  };

  type AdminPriceRow = {
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

  type AdminEventRow = AnalyticsEventRow & {
    manager_id: string | null;
  };

  const managersResult = await query<AdminManagerRow>(
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

  const priceStats = await query<AdminPriceRow>(
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

  const eventSummary = await query<{
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

  const managerActivityResult = await query<{
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

  const lastLoginResult = await query<{ manager_id: string | null; manager_name: string; created_at: string }>(
    `select e.manager_id::text, coalesce(m.name, 'Не назначен') as manager_name, e.created_at::text
     from wholesale_analytics_events e
     left join wholesale_managers m on m.id = e.manager_id
     where e.event_type = 'manager_login' and e.manager_id is not null
     order by e.created_at desc, e.id desc
     limit 1`,
  );

  const lastActionResult = await query<{
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

  const recentEventsResult = await query<AdminEventRow>(
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

  const views24Result = await query<{ client_id: string; views: string }>(
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

  const rows = priceStats.rows;
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayTime = today.getTime();
  const selectedCutoff = period === '7d' ? now - 7 * day : period === '30d' ? now - 30 * day : null;
  const validTime = (value: string | null) => (value ? new Date(`${value}T00:00:00`).getTime() : null);
  const isInSelectedPeriod = (value: string) => selectedCutoff === null || new Date(value).getTime() >= selectedCutoff;
  const daysLeft = (value: string | null) => {
    const time = validTime(value);
    return time === null ? null : Math.ceil((time - todayTime) / day);
  };
  const itemCounts = rows.map((row) => Number(row.item_count)).sort((a, b) => a - b);
  const medianItemsPerPrice =
    itemCounts.length === 0
      ? 0
      : itemCounts.length % 2
        ? itemCounts[Math.floor(itemCounts.length / 2)]
        : (itemCounts[itemCounts.length / 2 - 1] + itemCounts[itemCounts.length / 2]) / 2;
  const averageItemsPerPrice = rows.length ? rows.reduce((sum, row) => sum + Number(row.item_count), 0) / rows.length : 0;

  const toProblemPrice = (row: AdminPriceRow): WholesaleAdminAnalyticsProblemPrice => {
    const price = mapProblemPrice({
      id: row.id,
      title: row.title,
      client_name: row.client_name,
      valid_until: row.valid_until,
      created_at: row.created_at,
      updated_at: row.updated_at,
      item_count: row.item_count,
      views: row.views,
      pdf_downloads: row.pdf_downloads,
    });
    return {
      ...price,
      managerId: row.manager_id ? Number(row.manager_id) : null,
      managerName: row.manager_name,
      isActive: row.is_active,
      daysLeft: daysLeft(row.valid_until),
    };
  };

  const problemPrices = rows.map(toProblemPrice).filter((price) => price.problems.length > 0);
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
  const emptyPrices = rows.filter((row) => Number(row.item_count) === 0).length;
  const pricesWithoutClient = rows.filter((row) => !row.client_name.trim()).length;
  const pricesWithoutExpiration = rows.filter((row) => !row.valid_until).length;
  const pricesWithoutViews = rows.filter((row) => Number(row.views) === 0).length;
  const pricesWithoutPdfDownloads = rows.filter((row) => Number(row.pdf_downloads) === 0).length;
  const pricesWithoutExcelDownloads = rows.filter((row) => Number(row.excel_downloads) === 0).length;
  const pricesCreatedLast7Days = rows.filter((row) => new Date(row.created_at).getTime() >= now - 7 * day).length;
  const pricesCreatedLast30Days = rows.filter((row) => new Date(row.created_at).getTime() >= now - 30 * day).length;
  const pricesCreatedInSelectedPeriod = rows.filter((row) => isInSelectedPeriod(row.created_at)).length;
  const totalPublicViews = rows.reduce((sum, row) => sum + Number(row.views), 0);
  const publicViewsInSelectedPeriod = rows.reduce((sum, row) => sum + Number(row.views_period), 0);
  const totalPdfDownloads = rows.reduce((sum, row) => sum + Number(row.pdf_downloads), 0);
  const pdfDownloadsInSelectedPeriod = rows.reduce((sum, row) => sum + Number(row.pdf_period), 0);
  const totalExcelDownloads = rows.reduce((sum, row) => sum + Number(row.excel_downloads), 0);
  const excelDownloadsInSelectedPeriod = rows.reduce((sum, row) => sum + Number(row.excel_period), 0);
  const uniquePublicVisitors = rows.reduce((sum, row) => sum + Number(row.unique_visitors), 0);
  const uniqueDownloaders = rows.reduce((sum, row) => sum + Number(row.unique_downloaders), 0);
  const uniqueExcelDownloaders = rows.reduce((sum, row) => sum + Number(row.unique_excel_downloaders), 0);
  const repeatViews = rows.reduce((sum, row) => sum + Number(row.repeat_views), 0);

  const managerActivityById = new Map(
    managerActivityResult.rows.map((row) => [
      Number(row.manager_id),
      {
        actionsInSelectedPeriod: Number(row.actions_period),
        loginsInSelectedPeriod: Number(row.logins_period),
        activeDaysInSelectedPeriod: Number(row.active_days_period),
        lastActionAt: row.last_action_at,
      },
    ]),
  );
  const priceRowsByManager = new Map<number, AdminPriceRow[]>();
  for (const row of rows) {
    if (!row.manager_id) continue;
    const managerId = Number(row.manager_id);
    priceRowsByManager.set(managerId, [...(priceRowsByManager.get(managerId) ?? []), row]);
  }

  const managers = managersResult.rows
    .map<WholesaleAdminAnalyticsManager>((manager) => {
      const managerId = Number(manager.id);
      const managerRows = priceRowsByManager.get(managerId) ?? [];
      const activity = managerActivityById.get(managerId);
      const managerProblems = managerRows.map(toProblemPrice).filter((price) => price.problems.length > 0);
      const managerStuckPrices = buildStuckPrices(managerRows, now, todayTime, day, 1000);
      const managerReactionRows = buildReactionNeeded(managerRows, now, 1000);
      const managerExpired = managerRows.filter((row) => {
        const value = validTime(row.valid_until);
        return value !== null && value < todayTime;
      }).length;
      const managerStale = managerRows.filter((row) => new Date(row.updated_at).getTime() < now - 30 * day).length;
      const activePriceCount = managerRows.filter((row) => row.is_active).length;
      const openedPriceCount = managerRows.filter((row) => Number(row.views) > 0).length;
      const pdfPriceCount = managerRows.filter((row) => Number(row.pdf_downloads) > 0).length;
      const requestPriceCount = managerRows.filter((row) => Number(row.requests_sent) > 0).length;
      const sentPriceCount = managerRows.filter((row) => rowStatus(row) !== 'not_sent').length;
      const confirmedPriceCount = managerRows.filter((row) => rowStatus(row) === 'confirmed').length;
      const averageReactionHours = managerReactionRows.length
        ? Math.round((managerReactionRows.reduce((sum, row) => sum + row.hoursWithoutReaction, 0) / managerReactionRows.length) * 10) / 10
        : null;
      const clientsWithActivity = new Set(
        managerRows
          .filter((row) => Number(row.views_period) > 0 || Number(row.pdf_period) > 0 || Number(row.requests_period) > 0)
          .map((row) => clientIdFromName(row.client_name))
          .filter(Boolean) as string[],
      ).size;
      return {
        id: managerId,
        name: manager.name,
        login: manager.login,
        email: manager.email,
        phone: manager.phone,
        isActive: manager.is_active,
        totalPrices: managerRows.length,
        activePrices: activePriceCount,
        expiredPrices: managerExpired,
        problemPrices: managerProblems.length,
        pricesCreatedInSelectedPeriod: managerRows.filter((row) => isInSelectedPeriod(row.created_at)).length,
        actionsInSelectedPeriod: activity?.actionsInSelectedPeriod ?? 0,
        publicViews: managerRows.reduce((sum, row) => sum + Number(row.views_period), 0),
        uniqueVisitors: managerRows.reduce((sum, row) => sum + Number(row.unique_visitors), 0),
        pdfDownloads: managerRows.reduce((sum, row) => sum + Number(row.pdf_period), 0),
        clientsWithActivity,
        qualityScore: qualityScore({
          emptyPrices: managerRows.filter((row) => Number(row.item_count) === 0).length,
          pricesWithoutClient: managerRows.filter((row) => !row.client_name.trim()).length,
          pricesWithoutExpiration: managerRows.filter((row) => !row.valid_until).length,
          expiredPrices: managerExpired,
          pricesWithoutViews: managerRows.filter((row) => Number(row.views) === 0).length,
          stalePrices30Days: managerStale,
        }),
        lastLoginAt: manager.last_login_at,
        lastActionAt: activity?.lastActionAt ?? null,
        viewsPerActivePrice: activePriceCount ? Number((managerRows.reduce((sum, row) => sum + Number(row.views_period), 0) / activePriceCount).toFixed(1)) : 0,
        pdfPerActivePrice: activePriceCount ? Number((managerRows.reduce((sum, row) => sum + Number(row.pdf_period), 0) / activePriceCount).toFixed(1)) : 0,
        requestsPerActivePrice: activePriceCount ? Number((managerRows.reduce((sum, row) => sum + Number(row.requests_period), 0) / activePriceCount).toFixed(1)) : 0,
        sentToOpenedConversion: sentPriceCount ? Math.round((openedPriceCount / sentPriceCount) * 100) : 0,
        openedToPdfConversion: openedPriceCount ? Math.round((pdfPriceCount / openedPriceCount) * 100) : 0,
        openedToRequestConversion: openedPriceCount ? Math.round((requestPriceCount / openedPriceCount) * 100) : 0,
        stuckPriceRate: managerRows.length ? Math.round((managerStuckPrices.length / managerRows.length) * 100) : 0,
        confirmedPriceRate: managerRows.length ? Math.round((confirmedPriceCount / managerRows.length) * 100) : 0,
        averageReactionHours,
      };
    })
    .sort((a, b) => {
      const aActive = a.actionsInSelectedPeriod > 0 || (managerActivityById.get(a.id)?.loginsInSelectedPeriod ?? 0) > 0;
      const bActive = b.actionsInSelectedPeriod > 0 || (managerActivityById.get(b.id)?.loginsInSelectedPeriod ?? 0) > 0;
      if (aActive !== bActive) return aActive ? -1 : 1;
      if (a.actionsInSelectedPeriod !== b.actionsInSelectedPeriod) return b.actionsInSelectedPeriod - a.actionsInSelectedPeriod;
      return b.totalPrices - a.totalPrices;
    });

  const averageQualityScore = managers.length
    ? Math.round(managers.reduce((sum, manager) => sum + manager.qualityScore, 0) / managers.length)
    : 0;
  const bestManager = managers.length ? [...managers].sort((a, b) => b.qualityScore - a.qualityScore)[0] : null;
  const managersNeedAttention = managers.filter((manager) => manager.qualityScore < 70 || manager.problemPrices > 0).slice(0, 10);
  const activityRow = eventSummary.rows[0];
  const activeManagersInSelectedPeriod = Number(activityRow?.active_managers_period ?? 0);

  const problemsByManager = managers
    .map((manager) => {
      const managerRows = priceRowsByManager.get(manager.id) ?? [];
      const managerExpired = managerRows.filter((row) => {
        const value = validTime(row.valid_until);
        return value !== null && value < todayTime;
      }).length;
      const row = {
        managerId: manager.id,
        managerName: manager.name,
        emptyPrices: managerRows.filter((price) => Number(price.item_count) === 0).length,
        pricesWithoutClient: managerRows.filter((price) => !price.client_name.trim()).length,
        pricesWithoutExpiration: managerRows.filter((price) => !price.valid_until).length,
        expiredPrices: managerExpired,
        pricesWithoutViews: managerRows.filter((price) => Number(price.views) === 0).length,
        stalePrices30Days: managerRows.filter((price) => new Date(price.updated_at).getTime() < now - 30 * day).length,
        totalProblems: 0,
      };
      row.totalProblems =
        row.emptyPrices +
        row.pricesWithoutClient +
        row.pricesWithoutExpiration +
        row.expiredPrices +
        row.pricesWithoutViews +
        row.stalePrices30Days;
      return row;
    })
    .filter((row) => row.totalProblems > 0)
    .sort((a, b) => b.totalProblems - a.totalProblems);

  const mapAdminEvent = (row: AdminEventRow): WholesaleAdminAnalyticsEvent => ({
    ...mapAnalyticsEvent(row),
    managerId: row.manager_id ? Number(row.manager_id) : null,
  });
  const recentEvents = recentEventsResult.rows.map(mapAdminEvent);
  const latestViews = recentEvents.filter((event) => event.actorType === 'client' && ['public_price_opened', 'public_price_reopened'].includes(event.eventType));
  const latestDownloads = recentEvents.filter((event) => event.actorType === 'client' && event.eventType === 'public_price_pdf_downloaded');
  const latestExcelDownloads = recentEvents.filter((event) => event.actorType === 'client' && event.eventType === 'public_price_excel_downloaded');

  const clientMap = new Map<string, WholesaleAdminAnalyticsClient>();
  for (const row of rows) {
    const clientName = row.client_name.trim();
    if (!clientName) continue;
    const key = clientName.toLowerCase();
    const current =
      clientMap.get(key) ??
      ({
        clientId: key,
        clientName,
        managerId: row.manager_id ? Number(row.manager_id) : null,
        managerName: row.manager_name,
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
      } satisfies WholesaleAdminAnalyticsClient);
    current.priceCount += 1;
    current.views += Number(row.views_period);
    current.viewsLast7Days += Number(row.views_last_7_days);
    current.uniqueVisitors += Number(row.unique_visitors);
    current.pdfDownloads += Number(row.pdf_period);
    const lastActivity = [row.last_view_at, row.last_pdf_at, row.last_excel_at, row.last_request_at].filter(Boolean).sort().at(-1) ?? null;
    if (lastActivity && (!current.lastActivityAt || lastActivity > current.lastActivityAt)) {
      current.lastActivityAt = lastActivity;
      current.managerId = row.manager_id ? Number(row.manager_id) : null;
      current.managerName = row.manager_name;
      current.priceId = Number(row.id);
      current.priceTitle = row.title;
    }
    if (!current.lastPriceCreatedAt || row.created_at > current.lastPriceCreatedAt) current.lastPriceCreatedAt = row.created_at;
    clientMap.set(key, current);
  }
  for (const row of views24Result.rows) {
    const client = clientMap.get(row.client_id);
    if (client) client.viewsLast24Hours = Number(row.views);
  }
  const workflowRows: AnalyticsWorkflowRow[] = rows;
  const views24ByClient = new Map(views24Result.rows.map((row) => [row.client_id, Number(row.views)]));
  const statusFunnel = buildStatusFunnel(workflowRows);
  const stuckPrices = buildStuckPrices(workflowRows, now, todayTime, day);
  const managerReactionNeeded = buildReactionNeeded(workflowRows, now);
  const priorityClients = buildPriorityClients(workflowRows, views24ByClient, managerReactionNeeded);
  const clientHistory = buildClientHistory(workflowRows, now, todayTime);
  const [productInterest, comparison] = await Promise.all([
    getProductInterest(null, interval),
    getPeriodComparison(null, period),
  ]);
  const clients = Array.from(clientMap.values()).map((client) => {
    let status = 'Не открывал';
    if (client.views > 0) status = 'Смотрел';
    if (client.pdfDownloads > 0) status = 'Скачал PDF';
    if (client.viewsLast24Hours >= 2 || client.viewsLast7Days >= 3 || client.pdfDownloads > 0) status = 'Горячий';
    return { ...client, status };
  });

  const topViewedRows = [...rows].filter((row) => Number(row.views_period) > 0).sort((a, b) => Number(b.views_period) - Number(a.views_period));
  const topDownloadedRows = [...rows].filter((row) => Number(row.pdf_period) > 0).sort((a, b) => Number(b.pdf_period) - Number(a.pdf_period));
  const topExcelRows = [...rows].filter((row) => Number(row.excel_period) > 0).sort((a, b) => Number(b.excel_period) - Number(a.excel_period));
  const topViewedPrice = topViewedRows[0]
    ? { priceId: Number(topViewedRows[0].id), title: topViewedRows[0].title, managerName: topViewedRows[0].manager_name, views: Number(topViewedRows[0].views_period) }
    : null;
  const topDownloadedPrice = topDownloadedRows[0]
    ? {
        priceId: Number(topDownloadedRows[0].id),
        title: topDownloadedRows[0].title,
        managerName: topDownloadedRows[0].manager_name,
        downloads: Number(topDownloadedRows[0].pdf_period),
      }
    : null;
  const largestPrice = rows.length
    ? [...rows]
        .sort((a, b) => Number(b.item_count) - Number(a.item_count))
        .map((row) => ({ id: Number(row.id), title: row.title, managerName: row.manager_name, itemCount: Number(row.item_count) }))[0]
    : null;
  const managerViews = managers
    .map((manager) => ({ managerId: manager.id, managerName: manager.name, views: manager.publicViews }))
    .filter((manager) => manager.views > 0)
    .sort((a, b) => b.views - a.views);
  const managerPdf = managers
    .map((manager) => ({ managerId: manager.id, managerName: manager.name, downloads: manager.pdfDownloads }))
    .filter((manager) => manager.downloads > 0)
    .sort((a, b) => b.downloads - a.downloads);
  const managerExcel = managers
    .map((manager) => {
      const managerRows = priceRowsByManager.get(manager.id) ?? [];
      return {
        managerId: manager.id,
        managerName: manager.name,
        downloads: managerRows.reduce((sum, row) => sum + Number(row.excel_period), 0),
      };
    })
    .filter((manager) => manager.downloads > 0)
    .sort((a, b) => b.downloads - a.downloads);
  const managersByDownloads = managers
    .map((manager) => {
      const managerRows = priceRowsByManager.get(manager.id) ?? [];
      return {
        managerId: manager.id,
        managerName: manager.name,
        pricesWithDownloads: managerRows.filter((row) => Number(row.pdf_period) > 0).length,
        downloads: managerRows.reduce((sum, row) => sum + Number(row.pdf_period), 0),
        uniqueDownloaders: managerRows.reduce((sum, row) => sum + Number(row.unique_downloaders), 0),
        lastDownloadAt: managerRows.map((row) => row.last_pdf_at).filter(Boolean).sort().at(-1) ?? null,
      };
    })
    .filter((manager) => manager.downloads > 0)
    .sort((a, b) => b.downloads - a.downloads)
    .slice(0, 10);
  const managersByExcelDownloads = managers
    .map((manager) => {
      const managerRows = priceRowsByManager.get(manager.id) ?? [];
      return {
        managerId: manager.id,
        managerName: manager.name,
        pricesWithDownloads: managerRows.filter((row) => Number(row.excel_period) > 0).length,
        downloads: managerRows.reduce((sum, row) => sum + Number(row.excel_period), 0),
        uniqueDownloaders: managerRows.reduce((sum, row) => sum + Number(row.unique_excel_downloaders), 0),
        lastDownloadAt: managerRows.map((row) => row.last_excel_at).filter(Boolean).sort().at(-1) ?? null,
      };
    })
    .filter((manager) => manager.downloads > 0)
    .sort((a, b) => b.downloads - a.downloads)
    .slice(0, 10);

  const clientsWithActivity = clients.filter((client) => {
    const hasRequest = rows.some((row) => client.clientId === clientIdFromName(row.client_name) && Number(row.requests_period) > 0);
    return client.views > 0 || client.pdfDownloads > 0 || hasRequest;
  }).length;
  const clientsWithExpiredPrices = new Set(
    rows
      .filter((row) => {
        const value = validTime(row.valid_until);
        return row.client_name.trim() && value !== null && value < todayTime;
      })
      .map((row) => clientIdFromName(row.client_name))
      .filter(Boolean) as string[],
  ).size;
  const clientsWithActivePrices = new Set(
    rows
      .filter((row) => row.client_name.trim() && row.is_active)
      .map((row) => clientIdFromName(row.client_name))
      .filter(Boolean) as string[],
  ).size;
  const clientsWithoutActualActivePrice = clients.length - clientsWithActivePrices;

  return {
    period,
    summary: {
      totalManagers: managers.length,
      activeManagers: activeManagersInSelectedPeriod,
      inactiveManagers: Math.max(0, managers.length - activeManagersInSelectedPeriod),
      totalPrices: rows.length,
      activePrices: rows.filter((row) => row.is_active).length,
      inactivePrices: rows.filter((row) => !row.is_active).length,
      expiredPrices,
      expiringSoon7Days,
      expiringSoon30Days,
      pricesCreatedLast7Days,
      pricesCreatedLast30Days,
      pricesCreatedInSelectedPeriod,
      problemPrices: problemPrices.length,
      averageItemsPerPrice: Number(averageItemsPerPrice.toFixed(1)),
      medianItemsPerPrice: Number(medianItemsPerPrice.toFixed(1)),
      emptyPrices,
      pricesWithoutClient,
      pricesWithoutExpiration,
      stalePrices30Days,
      pricesWithoutViews,
      pricesWithoutPdfDownloads,
      totalPublicViews,
      uniquePublicVisitors,
      publicViewsInSelectedPeriod,
      totalPdfDownloads,
      pdfDownloadsInSelectedPeriod,
      clientsWithActivity,
      averageQualityScore,
    },
    managerActivity: {
      actionsLast7Days: Number(activityRow?.actions_last_7_days ?? 0),
      actionsLast30Days: Number(activityRow?.actions_last_30_days ?? 0),
      actionsInSelectedPeriod: Number(activityRow?.actions_period ?? 0),
      loginsLast7Days: Number(activityRow?.logins_last_7_days ?? 0),
      loginsLast30Days: Number(activityRow?.logins_last_30_days ?? 0),
      loginsInSelectedPeriod: Number(activityRow?.logins_period ?? 0),
      activeDaysInSelectedPeriod: Number(activityRow?.active_days_period ?? 0),
      activeManagersInSelectedPeriod,
      inactiveManagersInSelectedPeriod: Math.max(0, managers.length - activeManagersInSelectedPeriod),
      lastLogin: lastLoginResult.rows[0]
        ? {
            managerId: lastLoginResult.rows[0].manager_id ? Number(lastLoginResult.rows[0].manager_id) : null,
            managerName: lastLoginResult.rows[0].manager_name,
            createdAt: lastLoginResult.rows[0].created_at,
          }
        : null,
      lastAction: lastActionResult.rows[0]
        ? {
            eventType: lastActionResult.rows[0].event_type,
            managerId: lastActionResult.rows[0].manager_id ? Number(lastActionResult.rows[0].manager_id) : null,
            managerName: lastActionResult.rows[0].manager_name,
            priceTitle: lastActionResult.rows[0].price_title || 'Без названия',
            clientName: lastActionResult.rows[0].client_name || '',
            createdAt: lastActionResult.rows[0].created_at,
          }
        : null,
    },
    managers,
    priceQuality: {
      emptyPrices,
      pricesWithoutClient,
      pricesWithoutExpiration,
      expiredPrices,
      expiringSoon7Days,
      expiringSoon30Days,
      stalePrices30Days,
      pricesWithoutViews,
      pricesWithoutPdfDownloads,
      averageQualityScore,
      bestManager,
      managersNeedAttention,
      problemsByManager,
    },
    priceInsights: {
      latestPrices: rows.slice(0, 10).map(toProblemPrice),
      expiringSoonPrices: problemPrices.filter((price) => price.problems.includes('EXPIRING_SOON')).slice(0, 10),
      pricesWithoutViews: problemPrices.filter((price) => price.problems.includes('NO_VIEWS')).slice(0, 20),
      topViewedPrice,
      topDownloadedPrice,
      largestPrice,
    },
    publicLinks: {
      totalViews: totalPublicViews,
      uniqueVisitors: uniquePublicVisitors,
      repeatViews,
      viewsLast7Days: rows.reduce((sum, row) => sum + Number(row.views_last_7_days), 0),
      viewsLast30Days: rows.reduce((sum, row) => sum + Number(row.views_last_30_days), 0),
      viewsInSelectedPeriod: publicViewsInSelectedPeriod,
      lastViewAt: rows.map((row) => row.last_view_at).filter(Boolean).sort().at(-1) ?? null,
      pricesWithoutViews,
      averageViewsPerPrice: rows.length ? Number((totalPublicViews / rows.length).toFixed(1)) : 0,
      topManager: managerViews[0] ?? null,
      topViewedPrices: topViewedRows.slice(0, 10).map((row) => ({
        priceId: Number(row.id),
        title: row.title,
        clientName: row.client_name,
        managerId: row.manager_id ? Number(row.manager_id) : null,
        managerName: row.manager_name,
        views: Number(row.views_period),
        uniqueVisitors: Number(row.unique_visitors),
        repeatViews: Number(row.repeat_views),
        lastViewAt: row.last_view_at,
      })),
      latestViews,
      pricesWithoutViewsList: problemPrices.filter((price) => price.problems.includes('NO_VIEWS')).slice(0, 20),
    },
    pdf: {
      totalDownloads: totalPdfDownloads,
      downloadsLast7Days: rows.reduce((sum, row) => sum + Number(row.pdf_last_7_days), 0),
      downloadsLast30Days: rows.reduce((sum, row) => sum + Number(row.pdf_last_30_days), 0),
      downloadsInSelectedPeriod: pdfDownloadsInSelectedPeriod,
      uniqueDownloaders,
      lastDownloadAt: rows.map((row) => row.last_pdf_at).filter(Boolean).sort().at(-1) ?? null,
      pricesWithDownloads: rows.filter((row) => Number(row.pdf_downloads) > 0).length,
      pricesWithoutDownloads: pricesWithoutPdfDownloads,
      topManager: managerPdf[0] ?? null,
      topDownloadedPrices: topDownloadedRows.slice(0, 10).map((row) => ({
        priceId: Number(row.id),
        title: row.title,
        clientName: row.client_name,
        managerId: row.manager_id ? Number(row.manager_id) : null,
        managerName: row.manager_name,
        downloads: Number(row.pdf_period),
        uniqueDownloaders: Number(row.unique_downloaders),
        views: Number(row.views_period),
        lastDownloadAt: row.last_pdf_at,
      })),
      latestDownloads,
      managersByDownloads,
    },
    excel: {
      totalDownloads: totalExcelDownloads,
      downloadsLast7Days: rows.reduce((sum, row) => sum + Number(row.excel_last_7_days), 0),
      downloadsLast30Days: rows.reduce((sum, row) => sum + Number(row.excel_last_30_days), 0),
      downloadsInSelectedPeriod: excelDownloadsInSelectedPeriod,
      uniqueDownloaders: uniqueExcelDownloaders,
      lastDownloadAt: rows.map((row) => row.last_excel_at).filter(Boolean).sort().at(-1) ?? null,
      pricesWithDownloads: rows.filter((row) => Number(row.excel_downloads) > 0).length,
      pricesWithoutDownloads: pricesWithoutExcelDownloads,
      topManager: managerExcel[0] ?? null,
      topDownloadedPrices: topExcelRows.slice(0, 10).map((row) => ({
        priceId: Number(row.id),
        title: row.title,
        clientName: row.client_name,
        managerId: row.manager_id ? Number(row.manager_id) : null,
        managerName: row.manager_name,
        downloads: Number(row.excel_period),
        uniqueDownloaders: Number(row.unique_excel_downloaders),
        views: Number(row.views_period),
        lastDownloadAt: row.last_excel_at,
      })),
      latestDownloads: latestExcelDownloads,
      managersByDownloads: managersByExcelDownloads,
    },
    clients: {
      totalClients: clients.length,
      clientsWithActivePrices,
      clientsWithViews: clients.filter((client) => client.views > 0).length,
      clientsWithoutViews: clients.filter((client) => client.views === 0).length,
      clientsWithPdfDownloads: clients.filter((client) => client.pdfDownloads > 0).length,
      hotClientsCount: clients.filter((client) => client.status === 'Горячий').length,
      clientsWithExpiredPrices,
      clientsWithoutActualActivePrice,
      hotClients: clients.filter((client) => client.status === 'Горячий').slice(0, 10),
      clientsWithoutViewsList: clients.filter((client) => client.views === 0).slice(0, 20),
      topClientsByActivity: [...clients].sort((a, b) => b.views + b.pdfDownloads - (a.views + a.pdfDownloads)).slice(0, 10),
    },
    funnel: {
      createdPrices: rows.length,
      activePublicLinks: rows.filter((row) => row.is_active).length,
      openedPrices: rows.filter((row) => Number(row.views) > 0).length,
      pricesWithRepeatViews: rows.filter((row) => Number(row.repeat_views) > 0).length,
      pdfDownloadedPrices: rows.filter((row) => Number(row.pdf_downloads) > 0).length,
      requestsSent: rows.filter((row) => Number(row.requests_sent) > 0).length,
      clientsWithActivity,
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
    problemPrices: problemPrices.slice(0, 50),
    recentEvents,
  };
}
