import type { WholesaleManagerAnalyticsChange, WholesaleManagerAnalyticsEvent, WholesaleManagerAnalyticsProblem, WholesaleManagerAnalyticsProblemPrice } from '../types';
import type { AnalyticsChangeRow, AnalyticsEventRow, AnalyticsProblemRow } from './rows';

export function mapAnalyticsChange(row: AnalyticsChangeRow): WholesaleManagerAnalyticsChange {
  return {
    id: Number(row.id),
    priceId: row.price_id ? Number(row.price_id) : null,
    priceTitle: row.price_title || 'Без названия',
    action: row.action,
    changedBy: row.changed_by || 'Не указано',
    createdAt: row.created_at,
    details: row.details || '',
  };
}

export function mapProblemPrice(row: AnalyticsProblemRow): WholesaleManagerAnalyticsProblemPrice {
  return mapProblemPriceWithClock(row, () => new Date());
}

// A clock is passed explicitly to calculations; the compatibility mapper above
// retains the original per-row clock reads when used with Array.map.
export function mapProblemPriceWithClock(row: AnalyticsProblemRow, readDate: () => Date): WholesaleManagerAnalyticsProblemPrice {
  const problems: WholesaleManagerAnalyticsProblem[] = [];
  const itemCount = Number(row.item_count);
  const views = Number(row.views ?? 0);
  const validUntil = row.valid_until ? new Date(row.valid_until) : null;
  const today = new Date(readDate().getTime());
  today.setHours(0, 0, 0, 0);
  const expiringSoonDate = new Date(today);
  expiringSoonDate.setDate(expiringSoonDate.getDate() + 7);
  const updatedAt = new Date(row.updated_at ?? row.created_at);
  const staleDate = new Date(readDate().getTime());
  staleDate.setDate(staleDate.getDate() - 30);

  if (itemCount === 0) problems.push('EMPTY');
  if (!row.client_name.trim()) problems.push('NO_CLIENT');
  if (!row.valid_until) problems.push('NO_EXPIRATION');
  if (validUntil && validUntil < today) problems.push('EXPIRED');
  if (validUntil && validUntil >= today && validUntil <= expiringSoonDate) problems.push('EXPIRING_SOON');
  if (!Number.isNaN(updatedAt.getTime()) && updatedAt < staleDate) problems.push('STALE');
  if (views === 0) problems.push('NO_VIEWS');

  return {
    id: Number(row.id),
    title: row.title || 'Без названия',
    clientName: row.client_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    validUntil: row.valid_until,
    views,
    pdfDownloads: Number(row.pdf_downloads ?? 0),
    problems,
  };
}

export function mapAnalyticsEvent(row: AnalyticsEventRow): WholesaleManagerAnalyticsEvent {
  return {
    id: Number(row.id),
    eventType: row.event_type,
    actorType: row.actor_type,
    priceId: row.price_id ? Number(row.price_id) : null,
    priceTitle: row.price_title || 'Без названия',
    clientId: row.client_id || '',
    clientName: row.client_name || '',
    managerName: row.manager_name || '',
    createdAt: row.created_at,
    details: row.details || '',
    sessionId: row.session_id || '',
    referer: row.referer || '',
  };
}
