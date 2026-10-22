import {
  type WholesaleAdminAnalyticsClient,
  type WholesaleAdminAnalyticsEvent,
  type WholesaleAdminAnalyticsManager,
  type WholesaleAdminAnalyticsPeriod,
  type WholesaleAdminAnalyticsProblemPrice,
} from '../types';
import { type AnalyticsWorkflowRow } from './rows';
import { clientIdFromName, qualityScore } from './calculations';
import { mapAnalyticsEvent, mapProblemPriceWithClock } from './mappers';
import { buildStatusFunnel } from './statusFunnel';
import { buildStuckPrices, buildReactionNeeded } from './attention';
import { buildPriorityClients, buildClientHistory } from './clients';
import { rowStatus } from './workflowValues';
import { type AdminPriceRow, type AdminEventRow } from './adminReads';
import type { AdminAnalyticsData } from './adminData';

export function aggregateAdminAnalytics(data: AdminAnalyticsData, period: WholesaleAdminAnalyticsPeriod, now: number, currentDate: Date, readDate: () => Date) {
  const { managersResult, priceStats, eventSummary, managerActivityResult, recentEventsResult, views24Result } = data;
  const rows = priceStats.rows;

  const day = 24 * 60 * 60 * 1000;

  const today = new Date(currentDate.getTime());

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
    const price = mapProblemPriceWithClock({
      id: row.id,
      title: row.title,
      client_name: row.client_name,
      valid_until: row.valid_until,
      created_at: row.created_at,
      updated_at: row.updated_at,
      item_count: row.item_count,
      views: row.views,
      pdf_downloads: row.pdf_downloads,
    }, readDate);
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

  return { rows, todayTime, validTime, medianItemsPerPrice, averageItemsPerPrice, toProblemPrice, problemPrices, expiredPrices, expiringSoon7Days, expiringSoon30Days, stalePrices30Days, emptyPrices, pricesWithoutClient, pricesWithoutExpiration, pricesWithoutViews, pricesWithoutPdfDownloads, pricesWithoutExcelDownloads, pricesCreatedLast7Days, pricesCreatedLast30Days, pricesCreatedInSelectedPeriod, totalPublicViews, publicViewsInSelectedPeriod, totalPdfDownloads, pdfDownloadsInSelectedPeriod, totalExcelDownloads, excelDownloadsInSelectedPeriod, uniquePublicVisitors, uniqueDownloaders, uniqueExcelDownloaders, repeatViews, priceRowsByManager, managers, averageQualityScore, bestManager, managersNeedAttention, activityRow, activeManagersInSelectedPeriod, problemsByManager, recentEvents, latestViews, latestDownloads, latestExcelDownloads, clientMap, statusFunnel, stuckPrices, managerReactionNeeded, priorityClients, clientHistory };
}
