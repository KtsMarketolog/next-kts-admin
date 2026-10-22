import type { WholesaleAnalyticsPeriodComparison, WholesaleAnalyticsProductInterest } from '../types';
import type { PeriodComparisonRow, ProductInterestRow } from './supplementalReads';

function percentChange(current: number, previous: number) {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 100);
}

export function mapPeriodComparison(result: { rows: PeriodComparisonRow[]; }): WholesaleAnalyticsPeriodComparison[] {
  const row = result.rows[0];
  const values = [
    ['Создано прайсов', Number(row?.current_prices ?? 0), Number(row?.previous_prices ?? 0)],
    ['Просмотры', Number(row?.current_views ?? 0), Number(row?.previous_views ?? 0)],
    ['PDF', Number(row?.current_pdf ?? 0), Number(row?.previous_pdf ?? 0)],
    ['Заявки', Number(row?.current_requests ?? 0), Number(row?.previous_requests ?? 0)],
  ] as const;
  return values.map(([label, current, previous]) => ({ label, current, previous, changePercent: percentChange(current, previous) }));
}

export function mapProductInterest(result: { rows: ProductInterestRow[]; }): WholesaleAnalyticsProductInterest[] {
  return result.rows.map((row) => ({
    productTitle: row.product_title,
    productId: row.product_id ? Number(row.product_id) : null,
    opens: Number(row.opens),
    quantityChanges: Number(row.quantity_changes),
    requests: Number(row.requests),
    lastActivityAt: row.last_activity_at,
  }));
}
