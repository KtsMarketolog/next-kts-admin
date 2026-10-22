import { type WholesaleManagerAnalytics } from '../types';
import { mapAnalyticsChange, mapProblemPriceWithClock } from './mappers';
import { managerRoleLabel } from './calculations';
import type { ManagerAnalyticsData } from './managerData';

export function buildManagerAnalyticsResponse(data: ManagerAnalyticsData, readDate: () => Date): WholesaleManagerAnalytics {
  const { lastCreatedResult, recentChangesResult, lastChangeResult, problemResult, publicViewsResult, topViewsResult } = data;
  const managerRow = data.managerResult.rows[0];
  const summaryRow = data.summaryResult.rows[0];
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
    problemPrices: problemResult.rows.map((row) => mapProblemPriceWithClock(row, readDate)).filter((price) => price.problems.length > 0),
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
