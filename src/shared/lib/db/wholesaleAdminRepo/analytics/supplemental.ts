import type { WholesaleAdminAnalyticsPeriod, WholesaleAnalyticsPeriodComparison, WholesaleAnalyticsProductInterest } from '../types';
import { periodSqlInterval } from './calculations';
import { readPeriodComparison, readProductInterest } from './supplementalReads';
import { mapPeriodComparison, mapProductInterest } from './supplementalResponse';

export async function getPeriodComparison(managerId: number | null, period: WholesaleAdminAnalyticsPeriod): Promise<WholesaleAnalyticsPeriodComparison[]> {
  const interval = periodSqlInterval(period);
  if (!interval) return [];
  return mapPeriodComparison(await readPeriodComparison(managerId, interval));
}

export async function getProductInterest(managerId: number | null, interval: string | null): Promise<WholesaleAnalyticsProductInterest[]> {

  return mapProductInterest(await readProductInterest(managerId, interval));
}
