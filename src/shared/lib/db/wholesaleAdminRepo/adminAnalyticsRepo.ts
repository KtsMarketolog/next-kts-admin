import { ensureSiteSchema } from '../schema';
import type { AdminSession } from '@/shared/lib/adminAuth';
import { readCachedAnalytics } from './analytics/readCache';
import { measureAnalytics, traceAnalytics } from './analytics/performance';
import { periodSqlInterval } from './analytics/calculations';
import { getPeriodComparison, getProductInterest } from './analytics/supplemental';
import {
  readAdminManagers,
  readAdminPriceStats,
  readAdminEventSummary,
  readAdminManagerActivity,
  readAdminLastLogin,
  readAdminLastAction,
  readAdminRecentEvents,
  readAdminViews24,
} from './analytics/adminReads';
import { aggregateAdminAnalytics } from './analytics/adminAggregates';
import { buildAdminAnalyticsResponse } from './analytics/adminResponse';
import type { WholesaleAdminAnalytics, WholesaleAdminAnalyticsPeriod } from './types';

export async function getWholesaleAdminAnalytics(period: WholesaleAdminAnalyticsPeriod = '30d', session?: AdminSession): Promise<WholesaleAdminAnalytics> {
  return traceAnalytics('admin', async () => {
    await measureAnalytics('schema', ensureSiteSchema);
    return readCachedAnalytics({ session, kind: 'admin', period }, () => loadAdminAnalytics(period));
  });
}

async function loadAdminAnalytics(period: WholesaleAdminAnalyticsPeriod): Promise<WholesaleAdminAnalytics> {
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

  const managersResult = await readAdminManagers();

  const priceStats = await readAdminPriceStats(interval);

  const eventSummary = await readAdminEventSummary(interval, managerActionEvents, trackedManagerEvents);

  const managerActivityResult = await readAdminManagerActivity(interval, managerActionEvents, trackedManagerEvents);

  const lastLoginResult = await readAdminLastLogin();

  const lastActionResult = await readAdminLastAction(managerActionEvents);

  const recentEventsResult = await readAdminRecentEvents(interval);

  const views24Result = await readAdminViews24();

  const data = { managersResult, priceStats, eventSummary, managerActivityResult, lastLoginResult, lastActionResult, recentEventsResult, views24Result };
  const aggregates = await measureAnalytics('aggregate_response', async () => aggregateAdminAnalytics(data, period, Date.now(), new Date(), () => new Date()));
  const [productInterest, comparison] = await Promise.all([
    getProductInterest(null, interval),
    getPeriodComparison(null, period),
  ]);
  return buildAdminAnalyticsResponse(data, aggregates, productInterest, comparison, period);
}
