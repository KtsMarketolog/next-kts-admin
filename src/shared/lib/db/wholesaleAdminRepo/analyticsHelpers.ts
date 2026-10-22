// Compatibility facade: callers retain their existing exports while SQL,
// authorization, calculations and response mapping have separate ownership.
export type { AnalyticsChangeRow, AnalyticsProblemRow, AnalyticsSummaryRow, AnalyticsEventRow, AnalyticsWorkflowRow } from './analytics/rows';
export { normalizeLogin, periodSqlInterval, actionEventType, clientIdFromName, priceListAction, priceListDetails, qualityScore } from './analytics/calculations';
export { sessionManagerId, actorTypeFromRole, resolveWholesaleClientCompany, actorMeta } from './analytics/access';
export { mapAnalyticsChange, mapProblemPrice, mapAnalyticsEvent } from './analytics/mappers';
export { rowStatus } from './analytics/workflowValues';
export { buildStatusFunnel } from './analytics/statusFunnel';
export { buildStuckPrices, buildReactionNeeded } from './analytics/attention';
export { buildPriorityClients, buildClientHistory } from './analytics/clients';
export { getPeriodComparison, getProductInterest } from './analytics/supplemental';
