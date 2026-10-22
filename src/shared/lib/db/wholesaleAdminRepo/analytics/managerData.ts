import type * as reads from './managerReads';

export type ManagerAnalyticsData = {
  managerResult: Awaited<ReturnType<typeof reads.readManagerManager>>;
  summaryResult: Awaited<ReturnType<typeof reads.readManagerSummary>>;
  lastCreatedResult: Awaited<ReturnType<typeof reads.readManagerLastCreated>>;
  recentChangesResult: Awaited<ReturnType<typeof reads.readManagerRecentChanges>>;
  lastChangeResult: Awaited<ReturnType<typeof reads.readManagerLastChange>>;
  problemResult: Awaited<ReturnType<typeof reads.readManagerProblem>>;
  publicViewsResult: Awaited<ReturnType<typeof reads.readManagerPublicViews>>;
  topViewsResult: Awaited<ReturnType<typeof reads.readManagerTopViews>>;
};
