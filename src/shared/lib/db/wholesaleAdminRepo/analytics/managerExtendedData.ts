import type * as reads from './managerExtendedReads';

export type ManagerExtendedData = {
  priceStats: Awaited<ReturnType<typeof reads.readManagerExtendedPriceStats>>;
  activity: Awaited<ReturnType<typeof reads.readManagerExtendedActivity>>;
  recentEventsResult: Awaited<ReturnType<typeof reads.readManagerExtendedRecentEvents>>;
  views24: Awaited<ReturnType<typeof reads.readManagerExtendedViews24>>;
};
