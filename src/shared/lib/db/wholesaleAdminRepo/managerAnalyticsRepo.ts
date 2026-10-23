import { ensureSiteSchema } from '../schema';
import type { AdminSession } from '@/shared/lib/adminAuth';
import { readCachedAnalytics } from './analytics/readCache';
import { measureAnalytics, traceAnalytics } from './analytics/performance';
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

async function managerReport(managerId: number, period: WholesaleManagerAnalyticsPeriod, session: AdminSession | undefined, kind: 'manager' | 'extended') {
  return traceAnalytics(kind, async () => {
    await measureAnalytics('schema', ensureSiteSchema);
    // Re-read the target before any cache hit. Admins can still inspect inactive
    // managers' historical statistics; removed managers must immediately be 404.
    const managerResult = await readManagerManager(managerId);
    if (!managerResult.rows[0]) return null;
    return readCachedAnalytics({ session, kind, period, managerId, targetRevision: managerResult.rows[0].analytics_revision }, () => kind === 'manager'
      ? loadManagerAnalytics(managerId, period, managerResult)
      : loadManagerAnalyticsExtended(managerId, period, managerResult));
  });
}

export async function getWholesaleManagerAnalytics(managerId: number, period: WholesaleManagerAnalyticsPeriod = '30d', session?: AdminSession): Promise<WholesaleManagerAnalytics | null> {
  return managerReport(managerId, period, session, 'manager');
}

async function loadManagerAnalytics(managerId: number, period: WholesaleManagerAnalyticsPeriod, managerResult: Awaited<ReturnType<typeof readManagerManager>>) {
  const interval = periodSqlInterval(period);
  const summaryResult = await readManagerSummary(managerId, interval);

  const lastCreatedResult = await readManagerLastCreated(managerId);

  const recentChangesResult = await readManagerRecentChanges(managerId, interval);

  const lastChangeResult = await readManagerLastChange(managerId);

  const problemResult = await readManagerProblem(managerId);

  const publicViewsResult = await readManagerPublicViews(managerId, interval);

  const topViewsResult = await readManagerTopViews(managerId, interval);

  return buildManagerAnalyticsResponse({ managerResult, summaryResult, lastCreatedResult, recentChangesResult, lastChangeResult, problemResult, publicViewsResult, topViewsResult }, () => new Date());
}

export async function getWholesaleManagerAnalyticsExtended(managerId: number, period: WholesaleManagerAnalyticsPeriod = '30d', session?: AdminSession): Promise<WholesaleManagerAnalytics | null> {
  return managerReport(managerId, period, session, 'extended');
}

async function loadManagerAnalyticsExtended(managerId: number, period: WholesaleManagerAnalyticsPeriod, managerResult: Awaited<ReturnType<typeof readManagerManager>>) {
  const base = await loadManagerAnalytics(managerId, period, managerResult);
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
