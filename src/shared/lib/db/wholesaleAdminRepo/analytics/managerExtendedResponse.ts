import {
  type WholesaleManagerAnalytics,
  type WholesaleAnalyticsProductInterest,
  type WholesaleAnalyticsPeriodComparison,
} from '../types';
import { qualityScore } from './calculations';
import type { ManagerExtendedData } from './managerExtendedData';
import type { aggregateManagerPrices } from './managerPriceAggregates';
import type { aggregateManagerEvents } from './managerEventAggregates';
import type { aggregateManagerAttention } from './managerAttention';

export function buildManagerExtendedResponse(base: WholesaleManagerAnalytics, data: ManagerExtendedData, prices: ReturnType<typeof aggregateManagerPrices>, events: ReturnType<typeof aggregateManagerEvents>, attention: ReturnType<typeof aggregateManagerAttention>, productInterest: WholesaleAnalyticsProductInterest[], comparison: WholesaleAnalyticsPeriodComparison[]): WholesaleManagerAnalytics {
  const { activity } = data;
  const { rows, medianItemsPerPrice, expiredPrices, expiringSoon7Days, expiringSoon30Days, stalePrices30Days, pricesWithoutViews, pricesWithoutPdfDownloads, extendedProblems } = prices;
  const { recentEvents, recentViews, recentDownloads, lastAction, topViewed, topDownloaded, mostChanged, clientMap } = events;
  const { statusFunnel, stuckPrices, managerReactionNeeded, priorityClients, clientHistory } = attention;
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
