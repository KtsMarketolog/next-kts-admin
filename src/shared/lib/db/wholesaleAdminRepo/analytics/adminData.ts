import type * as reads from './adminReads';

export type AdminAnalyticsData = {
  managersResult: Awaited<ReturnType<typeof reads.readAdminManagers>>;
  priceStats: Awaited<ReturnType<typeof reads.readAdminPriceStats>>;
  eventSummary: Awaited<ReturnType<typeof reads.readAdminEventSummary>>;
  managerActivityResult: Awaited<ReturnType<typeof reads.readAdminManagerActivity>>;
  lastLoginResult: Awaited<ReturnType<typeof reads.readAdminLastLogin>>;
  lastActionResult: Awaited<ReturnType<typeof reads.readAdminLastAction>>;
  recentEventsResult: Awaited<ReturnType<typeof reads.readAdminRecentEvents>>;
  views24Result: Awaited<ReturnType<typeof reads.readAdminViews24>>;
};
