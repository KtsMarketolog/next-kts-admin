import type { WholesaleAnalyticsPriorityClient, WholesaleAnalyticsClientHistory, WholesaleAnalyticsReactionNeeded } from '../types';
import type { AnalyticsWorkflowRow } from './rows';
import { clientIdFromName } from './calculations';
import {
  safeTime,
  rowManagerId,
  rowManagerName,
  rowStatus,
  rowStatusLabel,
  rowLastClientActivity,
  validUntilTime,
} from './workflowValues';

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
