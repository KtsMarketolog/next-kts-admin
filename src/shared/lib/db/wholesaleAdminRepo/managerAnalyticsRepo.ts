import { ensureSiteSchema } from '../schema';
import { periodSqlInterval } from './analytics/calculations';
import { getPeriodComparison, getProductInterest } from './analytics/supplemental';
import {
  readManagerManager,
  readManagerSummary,
  readManagerLastCreated,
  readManagerRecentChanges,
  readManagerLastChange,
  readManagerProblem,
  readManagerPublicViews,
  readManagerTopViews,
} from './analytics/managerReads';
import {
  readManagerExtendedPriceStats,
  readManagerExtendedActivity,
  readManagerExtendedRecentEvents,
  readManagerExtendedViews24,
} from './analytics/managerExtendedReads';
import { buildManagerAnalyticsResponse } from './analytics/managerResponse';
import { aggregateManagerPrices } from './analytics/managerPriceAggregates';
import { aggregateManagerEvents } from './analytics/managerEventAggregates';
import { aggregateManagerAttention } from './analytics/managerAttention';
import { buildManagerExtendedResponse } from './analytics/managerExtendedResponse';
import type { WholesaleManagerAnalytics, WholesaleManagerAnalyticsPeriod } from './types';

export async function getWholesaleManagerAnalytics(managerId: number, period: WholesaleManagerAnalyticsPeriod = '30d'): Promise<WholesaleManagerAnalytics | null> {
  await ensureSiteSchema();

  const interval = periodSqlInterval(period);

  const managerResult = await readManagerManager(managerId);

  const managerRow = managerResult.rows[0];

  if (!managerRow) return null;

  const summaryResult = await readManagerSummary(managerId, interval);

  const lastCreatedResult = await readManagerLastCreated(managerId);

  const recentChangesResult = await readManagerRecentChanges(managerId, interval);

  const lastChangeResult = await readManagerLastChange(managerId);

  const problemResult = await readManagerProblem(managerId);

  const publicViewsResult = await readManagerPublicViews(managerId, interval);

  const topViewsResult = await readManagerTopViews(managerId, interval);

  return buildManagerAnalyticsResponse({ managerResult, summaryResult, lastCreatedResult, recentChangesResult, lastChangeResult, problemResult, publicViewsResult, topViewsResult }, () => new Date());
}

export async function getWholesaleManagerAnalyticsExtended(managerId: number, period: WholesaleManagerAnalyticsPeriod = '30d'): Promise<WholesaleManagerAnalytics | null> {
  const base = await getWholesaleManagerAnalytics(managerId, period);

  if (!base) return null;

  const interval = periodSqlInterval(period);

  const priceStats = await readManagerExtendedPriceStats(managerId, interval);

  const prices = aggregateManagerPrices(priceStats, Date.now(), new Date(), () => new Date());
  const activity = await readManagerExtendedActivity(managerId, interval);
  const recentEventsResult = await readManagerExtendedRecentEvents(managerId, interval);
  const events = aggregateManagerEvents(prices.rows, recentEventsResult);
  const views24 = await readManagerExtendedViews24(managerId);
  const attention = aggregateManagerAttention(managerId, base, views24, prices, events);
  const [productInterest, comparison] = await Promise.all([
    getProductInterest(managerId, interval),
    getPeriodComparison(managerId, period),
  ]);
  return buildManagerExtendedResponse(base, { priceStats, activity, recentEventsResult, views24 }, prices, events, attention, productInterest, comparison);
}
