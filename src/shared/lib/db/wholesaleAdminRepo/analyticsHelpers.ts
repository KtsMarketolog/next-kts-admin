import { isManagerSessionRole, type AdminSession } from '@/shared/lib/adminAuth';
import {
  getWholesalePriceWorkflowStatusLabel,
  normalizeWholesalePriceWorkflowStatus,
  type WholesalePriceWorkflowStatus,
} from '@/shared/lib/wholesalePriceWorkflowStatus';

import type { AnalyticsActorType, AnalyticsEventType } from '../analyticsRepo';
import { query } from '../client';
import { assertClientCompanyVisible } from '../clientCompaniesRepo';
import type {
  WholesaleAdminAnalyticsPeriod,
  WholesaleAnalyticsAttentionPrice,
  WholesaleAnalyticsClientHistory,
  WholesaleAnalyticsPeriodComparison,
  WholesaleAnalyticsPriorityClient,
  WholesaleAnalyticsProductInterest,
  WholesaleAnalyticsReactionNeeded,
  WholesaleAnalyticsStatusFunnel,
  WholesaleAnalyticsStatusFunnelStep,
  WholesaleManagerAnalyticsChange,
  WholesaleManagerAnalyticsEvent,
  WholesaleManagerAnalyticsPeriod,
  WholesaleManagerAnalyticsProblem,
  WholesaleManagerAnalyticsProblemPrice,
  WholesalePriceListEditor,
} from './types';

export type AnalyticsChangeRow = {
  id: string;
  price_id: string | null;
  price_title: string;
  action: string;
  changed_by: string | null;
  created_at: string;
  details: string | null;
};

export type AnalyticsProblemRow = {
  id: string;
  title: string;
  client_name: string;
  valid_until: string | null;
  created_at: string;
  updated_at: string;
  item_count: string;
  views: string;
  pdf_downloads: string;
};

export type AnalyticsSummaryRow = {
  total_prices: string;
  active_prices: string;
  expired_prices: string;
  expiring_soon_7_days: string;
  expiring_soon_30_days: string;
  prices_last_7_days: string;
  prices_last_30_days: string;
  period_prices: string;
  average_items_per_price: string | null;
  median_items_per_price: string | null;
  empty_prices: string;
  prices_without_client: string;
  prices_without_expiration: string;
  stale_prices_30_days: string;
  prices_without_views: string;
  disabled_prices: string;
  prices_without_pdf_downloads: string;
};

export type AnalyticsEventRow = {
  id: string;
  event_type: string;
  actor_type: string;
  price_id: string | null;
  price_title: string | null;
  client_id: string | null;
  client_name: string | null;
  manager_name: string | null;
  created_at: string;
  details: string | null;
  session_id: string | null;
  referer: string | null;
};

export function normalizeLogin(login: string) {
  return login.trim().toLowerCase();
}

export function sessionManagerId(session?: AdminSession | null) {
  return isManagerSessionRole(session?.role) ? session?.managerId ?? -1 : null;
}

export function periodSqlInterval(period: WholesaleManagerAnalyticsPeriod) {
  if (period === '7d') return '7 days';
  if (period === '30d') return '30 days';
  return null;
}

export function actorTypeFromRole(role: AdminSession['role'] | 'admin'): AnalyticsActorType {
  return isManagerSessionRole(role) ? 'manager' : 'admin';
}

export function actionEventType(action: string): AnalyticsEventType {
  if (action === 'create') return 'price_created';
  if (action === 'delete') return 'price_deleted';
  if (action === 'enable') return 'price_activated';
  if (action === 'disable') return 'price_deactivated';
  if (action === 'status') return 'price_status_changed';
  return 'price_updated';
}

export function clientIdFromName(clientName?: string | null) {
  const value = clientName?.trim();
  return value ? value.toLowerCase() : null;
}

export async function resolveWholesaleClientCompany(clientCompanyId: number | null | undefined, session?: AdminSession | null) {
  const id = Number(clientCompanyId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('Выберите клиента из списка');
  }
  if (session) await assertClientCompanyVisible(id, session);

  const result = await query<{ id: string; title: string }>(
    `select id::text, title
     from client_companies
     where id = $1 and is_active = true
     limit 1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Клиент не найден или отключен');
  return { id: Number(row.id), title: row.title };
}

function managerRoleLabel(role: string | null | undefined) {
  return role === 'support_manager' ? 'Менеджер по сопровождению' : 'Менеджер по развитию';
}

export function actorMeta(session?: AdminSession | null) {
  const actorManagerId = isManagerSessionRole(session?.role) ? session?.managerId ?? null : null;
  const actorRole: AdminSession['role'] =
    isManagerSessionRole(session?.role) ? session.role : session?.role === 'wholesale_admin' ? 'wholesale_admin' : 'admin';
  const actorFallback =
    actorRole === 'admin'
      ? 'Администратор'
      : actorRole === 'wholesale_admin'
        ? 'Администратор прайсов'
        : managerRoleLabel(actorRole);

  return { actorManagerId, actorRole, actorFallback };
}

export function priceListAction(previous: { is_active: boolean } | null, next: { isActive: boolean }) {
  if (!previous) return 'create';
  if (previous.is_active !== next.isActive) return next.isActive ? 'enable' : 'disable';
  return 'edit';
}

export function priceListDetails(
  previous: { client_name: string; valid_until: string | null; is_active: boolean; workflow_status?: string | null } | null,
  next: Pick<WholesalePriceListEditor, 'clientName' | 'validUntil' | 'isActive' | 'workflowStatus'>,
) {
  if (!previous) return 'Прайс создан';

  const details: string[] = [];
  if ((previous.client_name || '') !== next.clientName) details.push('изменён клиент');
  if ((previous.valid_until || '') !== (next.validUntil || '')) details.push('изменён срок действия');
  if (normalizeWholesalePriceWorkflowStatus(previous.workflow_status) !== next.workflowStatus) details.push('изменён статус работы');
  if (previous.is_active !== next.isActive) details.push(next.isActive ? 'прайс включён' : 'прайс отключён');
  return details.length ? details.join(', ') : 'Прайс обновлён';
}

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
  const problems: WholesaleManagerAnalyticsProblem[] = [];
  const itemCount = Number(row.item_count);
  const views = Number(row.views ?? 0);
  const validUntil = row.valid_until ? new Date(row.valid_until) : null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiringSoonDate = new Date(today);
  expiringSoonDate.setDate(expiringSoonDate.getDate() + 7);
  const updatedAt = new Date(row.updated_at ?? row.created_at);
  const staleDate = new Date();
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

export function qualityScore(input: {
  emptyPrices: number;
  pricesWithoutClient: number;
  pricesWithoutExpiration: number;
  expiredPrices: number;
  pricesWithoutViews: number;
  stalePrices30Days: number;
}) {
  const score =
    100 -
    Math.min(input.emptyPrices * 20, 40) -
    Math.min(input.pricesWithoutClient * 15, 30) -
    Math.min(input.pricesWithoutExpiration * 10, 20) -
    Math.min(input.expiredPrices * 15, 30) -
    Math.min(input.pricesWithoutViews * 5, 20) -
    Math.min(input.stalePrices30Days * 5, 20);
  return Math.max(0, Math.min(100, score));
}

export type AnalyticsWorkflowRow = {
  id: string;
  title: string;
  client_name: string;
  workflow_status?: string | null;
  valid_until: string | null;
  is_active: boolean;
  manager_id?: string | null;
  manager_name?: string | null;
  created_at: string;
  updated_at: string;
  views: string;
  views_last_7_days: string;
  repeat_views: string;
  pdf_downloads: string;
  requests_sent: string;
  last_view_at: string | null;
  last_pdf_at: string | null;
  last_request_at: string | null;
  first_view_at?: string | null;
  first_pdf_at?: string | null;
  first_request_at?: string | null;
  last_manager_activity_at?: string | null;
  last_client_event_type?: string | null;
};

const closedWorkflowStatuses = new Set<WholesalePriceWorkflowStatus>(['confirmed', 'rejected']);

function safeTime(value: string | null | undefined) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function maxDateString(values: Array<string | null | undefined>) {
  return values.filter(Boolean).sort().at(-1) ?? null;
}

function hoursBetween(start: string | null | undefined, end: string | null | undefined) {
  const startTime = safeTime(start);
  const endTime = safeTime(end);
  if (startTime === null || endTime === null || endTime < startTime) return null;
  return Math.round(((endTime - startTime) / (60 * 60 * 1000)) * 10) / 10;
}

function averageHours(rows: AnalyticsWorkflowRow[], from: keyof AnalyticsWorkflowRow, to: keyof AnalyticsWorkflowRow) {
  const values = rows
    .map((row) => hoursBetween(row[from] as string | null | undefined, row[to] as string | null | undefined))
    .filter((value): value is number => value !== null);
  if (!values.length) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

function rowManagerId(row: AnalyticsWorkflowRow) {
  return row.manager_id ? Number(row.manager_id) : null;
}

function rowManagerName(row: AnalyticsWorkflowRow) {
  return row.manager_name || '';
}

export function rowStatus(row: AnalyticsWorkflowRow) {
  return normalizeWholesalePriceWorkflowStatus(row.workflow_status);
}

function rowStatusLabel(row: AnalyticsWorkflowRow) {
  return getWholesalePriceWorkflowStatusLabel(row.workflow_status);
}

function rowLastClientActivity(row: AnalyticsWorkflowRow) {
  return maxDateString([row.last_view_at, row.last_pdf_at, row.last_request_at]);
}

function rowLastClientEventType(row: AnalyticsWorkflowRow) {
  const lastActivity = rowLastClientActivity(row);
  if (!lastActivity) return row.last_client_event_type || '';
  if (row.last_request_at === lastActivity) return 'public_price_request_sent';
  if (row.last_pdf_at === lastActivity) return 'public_price_pdf_downloaded';
  if (row.last_view_at === lastActivity) return Number(row.repeat_views) > 0 ? 'public_price_reopened' : 'public_price_opened';
  return row.last_client_event_type || '';
}

function validUntilTime(value: string | null) {
  return value ? safeTime(`${value}T00:00:00`) : null;
}

export function buildStatusFunnel(rows: AnalyticsWorkflowRow[]): WholesaleAnalyticsStatusFunnel {
  const total = rows.length;
  const reachedSent = rows.filter((row) => rowStatus(row) !== 'not_sent').length;
  const opened = rows.filter((row) => Number(row.views) > 0).length;
  const pdf = rows.filter((row) => Number(row.pdf_downloads) > 0).length;
  const requested = rows.filter((row) => Number(row.requests_sent) > 0).length;
  const negotiation = rows.filter((row) => ['negotiation', 'confirmed', 'rejected'].includes(rowStatus(row))).length;
  const confirmed = rows.filter((row) => rowStatus(row) === 'confirmed').length;
  const rejected = rows.filter((row) => rowStatus(row) === 'rejected').length;
  const rawSteps = [
    { key: 'created', label: 'Создано прайсов', count: total },
    { key: 'sent', label: 'Отправлено клиенту', count: reachedSent },
    { key: 'opened', label: 'Открыто клиентом', count: opened },
    { key: 'pdf', label: 'Скачали PDF', count: pdf },
    { key: 'request', label: 'Отправили заявку', count: requested },
    { key: 'negotiation', label: 'На согласовании', count: negotiation },
    { key: 'confirmed', label: 'Подтверждено', count: confirmed },
    { key: 'rejected', label: 'Отклонено', count: rejected },
  ];
  const steps = rawSteps.map<WholesaleAnalyticsStatusFunnelStep>((step, index) => {
    const previous = index === 0 ? step.count : rawSteps[index - 1].count;
    return {
      ...step,
      dropFromPrevious: Math.max(0, previous - step.count),
      conversionFromPrevious: previous > 0 ? Math.round((step.count / previous) * 100) : 0,
      conversionFromTotal: total > 0 ? Math.round((step.count / total) * 100) : 0,
    };
  });

  return {
    steps,
    biggestDrop: steps.slice(1).sort((a, b) => b.dropFromPrevious - a.dropFromPrevious)[0] ?? null,
    averageTimeToOpenHours: averageHours(rows, 'created_at', 'first_view_at'),
    averageTimeToPdfHours: averageHours(rows, 'first_view_at', 'first_pdf_at'),
    averageTimeToRequestHours: averageHours(rows, 'first_view_at', 'first_request_at'),
  };
}

export function buildStuckPrices(rows: AnalyticsWorkflowRow[], now: number, todayTime: number, day: number, limit = 20): WholesaleAnalyticsAttentionPrice[] {
  return rows
    .map<WholesaleAnalyticsAttentionPrice | null>((row) => {
      const status = rowStatus(row);
      const updatedAt = safeTime(row.updated_at) ?? safeTime(row.created_at) ?? now;
      const createdAt = safeTime(row.created_at) ?? now;
      const lastManagerAt = row.last_manager_activity_at ?? row.updated_at;
      const lastClientActivityAt = rowLastClientActivity(row);
      const daysSinceUpdated = Math.floor((now - updatedAt) / day);
      const daysSinceCreated = Math.floor((now - createdAt) / day);
      const validTime = validUntilTime(row.valid_until);
      let reason = '';
      let daysInStage = Math.max(0, daysSinceUpdated);

      if (status === 'not_sent' && daysSinceCreated >= 1) {
        reason = 'Не отправлен больше 1 дня';
        daysInStage = daysSinceCreated;
      } else if (status === 'sent' && Number(row.views) === 0 && daysSinceUpdated >= 2) {
        reason = 'Отправлен, но клиент не открыл 2+ дня';
      } else if (status === 'sent' && (Number(row.views) > 0 || Number(row.pdf_downloads) > 0 || Number(row.requests_sent) > 0)) {
        reason = 'Клиент проявил интерес, статус не обновлен';
      } else if (status === 'negotiation' && daysSinceUpdated >= 5) {
        reason = 'На согласовании больше 5 дней';
      } else if (status === 'needs_correction' && daysSinceUpdated >= 2) {
        reason = 'Требует корректировки, но прайс не обновлялся';
      } else if (validTime !== null && validTime < todayTime && !closedWorkflowStatuses.has(status)) {
        reason = 'Просрочен, но не закрыт';
      }

      if (!reason) return null;
      return {
        id: Number(row.id),
        title: row.title,
        clientName: row.client_name,
        managerId: rowManagerId(row),
        managerName: rowManagerName(row),
        workflowStatus: status,
        workflowStatusLabel: rowStatusLabel(row),
        reason,
        daysInStage,
        views: Number(row.views),
        pdfDownloads: Number(row.pdf_downloads),
        requestsSent: Number(row.requests_sent),
        lastClientActivityAt,
        lastManagerActivityAt: lastManagerAt,
      } satisfies WholesaleAnalyticsAttentionPrice;
    })
    .filter((row): row is WholesaleAnalyticsAttentionPrice => Boolean(row))
    .sort((a, b) => b.daysInStage - a.daysInStage)
    .slice(0, limit);
}

export function buildReactionNeeded(rows: AnalyticsWorkflowRow[], now: number, limit = 20): WholesaleAnalyticsReactionNeeded[] {
  return rows
    .map((row) => {
      const lastClientActivityAt = rowLastClientActivity(row);
      if (!lastClientActivityAt || closedWorkflowStatuses.has(rowStatus(row))) return null;
      const lastClientTime = safeTime(lastClientActivityAt);
      const lastManagerTime = safeTime(row.last_manager_activity_at);
      if (lastClientTime === null || (lastManagerTime !== null && lastManagerTime >= lastClientTime)) return null;
      return {
        priceId: Number(row.id),
        priceTitle: row.title,
        clientName: row.client_name,
        managerId: rowManagerId(row),
        managerName: rowManagerName(row),
        lastClientEventType: rowLastClientEventType(row),
        lastClientActivityAt,
        lastManagerActivityAt: row.last_manager_activity_at ?? null,
        hoursWithoutReaction: Math.max(0, Math.round(((now - lastClientTime) / (60 * 60 * 1000)) * 10) / 10),
        workflowStatus: rowStatus(row),
        workflowStatusLabel: rowStatusLabel(row),
      } satisfies WholesaleAnalyticsReactionNeeded;
    })
    .filter((row): row is WholesaleAnalyticsReactionNeeded => Boolean(row))
    .sort((a, b) => b.hoursWithoutReaction - a.hoursWithoutReaction)
    .slice(0, limit);
}

export function buildPriorityClients(rows: AnalyticsWorkflowRow[], views24ByClient: Map<string, number>, reactionRows: WholesaleAnalyticsReactionNeeded[], limit = 20) {
  const reactionPriceIds = new Set(reactionRows.map((row) => row.priceId));
  const clientMap = new Map<string, WholesaleAnalyticsPriorityClient>();

  for (const row of rows) {
    const clientId = clientIdFromName(row.client_name);
    if (!clientId) continue;
    const status = rowStatus(row);
    const reasons: string[] = [];
    let score = 0;
    const views24 = views24ByClient.get(clientId) ?? 0;
    const repeatViews = Number(row.repeat_views);
    const pdfDownloads = Number(row.pdf_downloads);
    const requestsSent = Number(row.requests_sent);
    if (repeatViews > 0) {
      score += 3;
      reasons.push('повторные просмотры');
    }
    if (pdfDownloads > 0) {
      score += 5;
      reasons.push('скачивал PDF');
    }
    if (requestsSent > 0) {
      score += 10;
      reasons.push('отправил заявку');
    }
    if (views24 > 0) {
      score += 2;
      reasons.push('активен сегодня');
    }
    const firstViewTime = safeTime(row.first_view_at);
    const updatedTime = safeTime(row.updated_at);
    if (firstViewTime !== null && updatedTime !== null && firstViewTime > updatedTime) {
      score += 4;
      reasons.push('открыл после обновления');
    }
    if (status === 'negotiation') {
      score += 3;
      reasons.push('на согласовании');
    }
    if (reactionPriceIds.has(Number(row.id))) {
      score += 5;
      reasons.push('нужна реакция менеджера');
    }
    if (score === 0) continue;
    const lastActivityAt = rowLastClientActivity(row);
    const current = clientMap.get(clientId);
    if (current && current.score >= score) {
      current.viewsLast24Hours = views24;
      current.viewsLast7Days += Number(row.views_last_7_days);
      current.repeatViews += repeatViews;
      current.pdfDownloads += pdfDownloads;
      current.requestsSent += requestsSent;
      continue;
    }
    clientMap.set(clientId, {
      clientId,
      clientName: row.client_name,
      managerId: rowManagerId(row),
      managerName: rowManagerName(row),
      priceId: Number(row.id),
      priceTitle: row.title,
      score,
      reasons,
      viewsLast24Hours: views24,
      viewsLast7Days: Number(row.views_last_7_days),
      repeatViews,
      pdfDownloads,
      requestsSent,
      lastActivityAt,
      workflowStatus: status,
      workflowStatusLabel: rowStatusLabel(row),
    });
  }

  return Array.from(clientMap.values()).sort((a, b) => b.score - a.score).slice(0, limit);
}

export function buildClientHistory(rows: AnalyticsWorkflowRow[], now: number, todayTime: number, limit = 30): WholesaleAnalyticsClientHistory[] {
  const clientMap = new Map<string, WholesaleAnalyticsClientHistory>();

  for (const row of rows) {
    const clientId = clientIdFromName(row.client_name);
    if (!clientId) continue;
    const validTime = validUntilTime(row.valid_until);
    const isExpired = validTime !== null && validTime < todayTime;
    const isActiveActual = row.is_active && !isExpired;
    const lastActivityAt = rowLastClientActivity(row);
    const statusLabel = rowStatusLabel(row);
    const current =
      clientMap.get(clientId) ??
      ({
        clientId,
        clientName: row.client_name,
        managerId: rowManagerId(row),
        managerName: rowManagerName(row),
        priceCount: 0,
        activePrices: 0,
        activeActualPrices: 0,
        expiredPrices: 0,
        statuses: [],
        views: 0,
        pdfDownloads: 0,
        requestsSent: 0,
        lastPriceCreatedAt: null,
        lastViewAt: null,
        lastActivityAt: null,
        hasActiveActualPrice: false,
      } satisfies WholesaleAnalyticsClientHistory);
    current.priceCount += 1;
    if (row.is_active) current.activePrices += 1;
    if (isActiveActual) current.activeActualPrices += 1;
    if (isExpired) current.expiredPrices += 1;
    if (!current.statuses.includes(statusLabel)) current.statuses.push(statusLabel);
    current.views += Number(row.views);
    current.pdfDownloads += Number(row.pdf_downloads);
    current.requestsSent += Number(row.requests_sent);
    if (!current.lastPriceCreatedAt || row.created_at > current.lastPriceCreatedAt) current.lastPriceCreatedAt = row.created_at;
    if (row.last_view_at && (!current.lastViewAt || row.last_view_at > current.lastViewAt)) current.lastViewAt = row.last_view_at;
    if (lastActivityAt && (!current.lastActivityAt || lastActivityAt > current.lastActivityAt)) {
      current.lastActivityAt = lastActivityAt;
      current.managerId = rowManagerId(row);
      current.managerName = rowManagerName(row);
    }
    current.hasActiveActualPrice ||= isActiveActual;
    clientMap.set(clientId, current);
  }

  return Array.from(clientMap.values())
    .sort((a, b) => (safeTime(b.lastActivityAt) ?? 0) - (safeTime(a.lastActivityAt) ?? 0) || b.priceCount - a.priceCount)
    .slice(0, limit);
}

function percentChange(current: number, previous: number) {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 100);
}

export async function getPeriodComparison(managerId: number | null, period: WholesaleAdminAnalyticsPeriod): Promise<WholesaleAnalyticsPeriodComparison[]> {
  const interval = periodSqlInterval(period);
  if (!interval) return [];

  const params = managerId ? [interval, managerId] : [interval];
  const managerClause = managerId ? 'and manager_id = $2' : '';
  const eventManagerClause = managerId ? 'and e.manager_id = $2' : '';

  const result = await query<{
    current_prices: string;
    previous_prices: string;
    current_views: string;
    previous_views: string;
    current_pdf: string;
    previous_pdf: string;
    current_requests: string;
    previous_requests: string;
  }>(
    `select
       (select count(*)::text from wholesale_price_lists where created_at >= now() - $1::interval ${managerClause}) as current_prices,
       (select count(*)::text from wholesale_price_lists where created_at >= now() - ($1::interval * 2) and created_at < now() - $1::interval ${managerClause}) as previous_prices,
       (select count(*)::text from wholesale_analytics_events e where e.actor_type = 'client' and e.event_type in ('public_price_opened', 'public_price_reopened') and e.created_at >= now() - $1::interval ${eventManagerClause}) as current_views,
       (select count(*)::text from wholesale_analytics_events e where e.actor_type = 'client' and e.event_type in ('public_price_opened', 'public_price_reopened') and e.created_at >= now() - ($1::interval * 2) and e.created_at < now() - $1::interval ${eventManagerClause}) as previous_views,
       (select count(*)::text from wholesale_analytics_events e where e.actor_type = 'client' and e.event_type = 'public_price_pdf_downloaded' and e.created_at >= now() - $1::interval ${eventManagerClause}) as current_pdf,
       (select count(*)::text from wholesale_analytics_events e where e.actor_type = 'client' and e.event_type = 'public_price_pdf_downloaded' and e.created_at >= now() - ($1::interval * 2) and e.created_at < now() - $1::interval ${eventManagerClause}) as previous_pdf,
       (select count(*)::text from wholesale_analytics_events e where e.actor_type = 'client' and e.event_type = 'public_price_request_sent' and e.created_at >= now() - $1::interval ${eventManagerClause}) as current_requests,
       (select count(*)::text from wholesale_analytics_events e where e.actor_type = 'client' and e.event_type = 'public_price_request_sent' and e.created_at >= now() - ($1::interval * 2) and e.created_at < now() - $1::interval ${eventManagerClause}) as previous_requests`,
    params,
  );
  const row = result.rows[0];
  const values = [
    ['Создано прайсов', Number(row?.current_prices ?? 0), Number(row?.previous_prices ?? 0)],
    ['Просмотры', Number(row?.current_views ?? 0), Number(row?.previous_views ?? 0)],
    ['PDF', Number(row?.current_pdf ?? 0), Number(row?.previous_pdf ?? 0)],
    ['Заявки', Number(row?.current_requests ?? 0), Number(row?.previous_requests ?? 0)],
  ] as const;
  return values.map(([label, current, previous]) => ({ label, current, previous, changePercent: percentChange(current, previous) }));
}

export async function getProductInterest(managerId: number | null, interval: string | null): Promise<WholesaleAnalyticsProductInterest[]> {
  const params = managerId ? [interval, managerId] : [interval];
  const managerClause = managerId ? 'and e.manager_id = $2' : '';
  const result = await query<{
    product_title: string;
    product_id: string | null;
    opens: string;
    quantity_changes: string;
    requests: string;
    last_activity_at: string | null;
  }>(
    `with event_products as (
       select
         nullif(e.metadata->>'productTitle', '') as product_title,
         nullif(e.metadata->>'productId', '') as product_id,
         e.event_type,
         e.created_at
       from wholesale_analytics_events e
       where e.actor_type = 'client'
         and e.event_type in ('public_price_product_opened', 'public_price_quantity_changed')
         and ($1::text is null or e.created_at >= now() - $1::interval)
         ${managerClause}
       union all
       select
         nullif(item->>'productTitle', '') as product_title,
         null::text as product_id,
         'public_price_request_sent' as event_type,
         e.created_at
       from wholesale_analytics_events e
       cross join lateral jsonb_array_elements(
         case when jsonb_typeof(e.metadata->'items') = 'array' then e.metadata->'items' else '[]'::jsonb end
       ) item
       where e.actor_type = 'client'
         and e.event_type = 'public_price_request_sent'
         and ($1::text is null or e.created_at >= now() - $1::interval)
         ${managerClause}
     )
     select
       coalesce(product_title, 'Товар') as product_title,
       product_id,
       count(*) filter (where event_type = 'public_price_product_opened')::text as opens,
       count(*) filter (where event_type = 'public_price_quantity_changed')::text as quantity_changes,
       count(*) filter (where event_type = 'public_price_request_sent')::text as requests,
       max(created_at)::text as last_activity_at
     from event_products
     group by coalesce(product_title, 'Товар'), product_id
     order by
       (count(*) filter (where event_type = 'public_price_request_sent')) desc,
       (count(*) filter (where event_type = 'public_price_quantity_changed')) desc,
       (count(*) filter (where event_type = 'public_price_product_opened')) desc
     limit 15`,
    params,
  );

  return result.rows.map((row) => ({
    productTitle: row.product_title,
    productId: row.product_id ? Number(row.product_id) : null,
    opens: Number(row.opens),
    quantityChanges: Number(row.quantity_changes),
    requests: Number(row.requests),
    lastActivityAt: row.last_activity_at,
  }));
}
