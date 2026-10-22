import { type WholesaleManagerAnalytics } from '../types';
import { type AnalyticsWorkflowRow } from './rows';
import { buildStatusFunnel } from './statusFunnel';
import { buildStuckPrices, buildReactionNeeded } from './attention';
import { buildPriorityClients, buildClientHistory } from './clients';
import type { ManagerExtendedData } from './managerExtendedData';
import type { aggregateManagerPrices } from './managerPriceAggregates';
import type { aggregateManagerEvents } from './managerEventAggregates';

export function aggregateManagerAttention(managerId: number, base: WholesaleManagerAnalytics, views24: ManagerExtendedData['views24'], prices: ReturnType<typeof aggregateManagerPrices>, events: ReturnType<typeof aggregateManagerEvents>) {
  const { rows, now, day, todayTime } = prices;
  const { clientMap } = events;
  for (const row of views24.rows) {
    const client = clientMap.get(row.client_id);
    if (client) client.viewsLast24Hours = Number(row.views);
  }

  const workflowRows: AnalyticsWorkflowRow[] = rows.map((row) => ({
    ...row,
    manager_id: String(managerId),
    manager_name: base.manager.name,
  }));

  const views24ByClient = new Map(views24.rows.map((row) => [row.client_id, Number(row.views)]));

  const statusFunnel = buildStatusFunnel(workflowRows);

  const stuckPrices = buildStuckPrices(workflowRows, now, todayTime, day);

  const managerReactionNeeded = buildReactionNeeded(workflowRows, now);

  const priorityClients = buildPriorityClients(workflowRows, views24ByClient, managerReactionNeeded);

  const clientHistory = buildClientHistory(workflowRows, now, todayTime);
  return { statusFunnel, stuckPrices, managerReactionNeeded, priorityClients, clientHistory };
}
