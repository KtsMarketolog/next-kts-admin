import {
  type WholesaleAdminAnalytics,
  type WholesaleAdminAnalyticsPeriod,
  type WholesaleAnalyticsProductInterest,
  type WholesaleAnalyticsPeriodComparison,
} from '../types';
import { clientIdFromName } from './calculations';
import type { aggregateAdminAnalytics } from './adminAggregates';
import type { AdminAnalyticsData } from './adminData';

export function buildAdminAnalyticsResponse(data: AdminAnalyticsData, aggregates: ReturnType<typeof aggregateAdminAnalytics>, productInterest: WholesaleAnalyticsProductInterest[], comparison: WholesaleAnalyticsPeriodComparison[], period: WholesaleAdminAnalyticsPeriod): WholesaleAdminAnalytics {
  const { rows, todayTime, validTime, medianItemsPerPrice, averageItemsPerPrice, toProblemPrice, problemPrices, expiredPrices, expiringSoon7Days, expiringSoon30Days, stalePrices30Days, emptyPrices, pricesWithoutClient, pricesWithoutExpiration, pricesWithoutViews, pricesWithoutPdfDownloads, pricesWithoutExcelDownloads, pricesCreatedLast7Days, pricesCreatedLast30Days, pricesCreatedInSelectedPeriod, totalPublicViews, publicViewsInSelectedPeriod, totalPdfDownloads, pdfDownloadsInSelectedPeriod, totalExcelDownloads, excelDownloadsInSelectedPeriod, uniquePublicVisitors, uniqueDownloaders, uniqueExcelDownloaders, repeatViews, priceRowsByManager, managers, averageQualityScore, bestManager, managersNeedAttention, activityRow, activeManagersInSelectedPeriod, problemsByManager, recentEvents, latestViews, latestDownloads, latestExcelDownloads, clientMap, statusFunnel, stuckPrices, managerReactionNeeded, priorityClients, clientHistory } = aggregates;
  const { lastLoginResult, lastActionResult } = data;
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
