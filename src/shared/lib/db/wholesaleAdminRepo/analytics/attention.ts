import type { WholesaleAnalyticsAttentionPrice, WholesaleAnalyticsReactionNeeded } from '../types';
import type { AnalyticsWorkflowRow } from './rows';
import {
  closedWorkflowStatuses,
  safeTime,
  rowManagerId,
  rowManagerName,
  rowStatus,
  rowStatusLabel,
  rowLastClientActivity,
  rowLastClientEventType,
  validUntilTime,
} from './workflowValues';

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
