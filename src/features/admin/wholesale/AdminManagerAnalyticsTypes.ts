export type Period = '7d' | '30d' | 'all';
export type Tab = 'overview' | 'prices' | 'clients' | 'links' | 'pdf' | 'events';
export type Problem = 'EMPTY' | 'NO_CLIENT' | 'NO_EXPIRATION' | 'EXPIRED' | 'EXPIRING_SOON' | 'STALE' | 'NO_VIEWS';

export type AnalyticsEvent = {
  id: number;
  eventType: string;
  actorType: string;
  priceId: number | null;
  priceTitle: string;
  clientId: string;
  clientName: string;
  managerName: string;
  createdAt: string;
  details: string;
  sessionId: string;
  referer: string;
};

export type AnalyticsChange = {
  id: number;
  priceId: number | null;
  priceTitle: string;
  action: string;
  changedBy: string;
  createdAt: string;
  details: string;
};

export type ProblemPrice = {
  id: number;
  title: string;
  clientName: string;
  createdAt: string;
  updatedAt?: string;
  validUntil: string | null;
  views?: number;
  pdfDownloads?: number;
  problems: Problem[];
};

export type AnalyticsClient = {
  clientId: string;
  clientName: string;
  priceId: number | null;
  priceTitle: string;
  priceCount: number;
  viewsLast24Hours: number;
  viewsLast7Days: number;
  views: number;
  uniqueVisitors: number;
  pdfDownloads: number;
  lastActivityAt: string | null;
  lastPriceCreatedAt: string | null;
  status: string;
};

export type StatusFunnelStep = {
  key: string;
  label: string;
  count: number;
  dropFromPrevious: number;
  conversionFromPrevious: number;
  conversionFromTotal: number;
};

export type StatusFunnel = {
  steps: StatusFunnelStep[];
  biggestDrop: StatusFunnelStep | null;
  averageTimeToOpenHours: number | null;
  averageTimeToPdfHours: number | null;
  averageTimeToRequestHours: number | null;
};

export type AttentionPrice = {
  id: number;
  title: string;
  clientName: string;
  managerId: number | null;
  managerName: string;
  workflowStatus: string;
  workflowStatusLabel: string;
  reason: string;
  daysInStage: number;
  views: number;
  pdfDownloads: number;
  requestsSent: number;
  lastClientActivityAt: string | null;
  lastManagerActivityAt: string | null;
};

export type ReactionNeeded = {
  priceId: number;
  priceTitle: string;
  clientName: string;
  managerId: number | null;
  managerName: string;
  lastClientEventType: string;
  lastClientActivityAt: string;
  lastManagerActivityAt: string | null;
  hoursWithoutReaction: number;
  workflowStatus: string;
  workflowStatusLabel: string;
};

export type PriorityClient = {
  clientId: string;
  clientName: string;
  managerId: number | null;
  managerName: string;
  priceId: number;
  priceTitle: string;
  score: number;
  reasons: string[];
  viewsLast24Hours: number;
  viewsLast7Days: number;
  repeatViews: number;
  pdfDownloads: number;
  requestsSent: number;
  lastActivityAt: string | null;
  workflowStatus: string;
  workflowStatusLabel: string;
};

export type ClientHistory = {
  clientId: string;
  clientName: string;
  managerId: number | null;
  managerName: string;
  priceCount: number;
  activePrices: number;
  activeActualPrices: number;
  expiredPrices: number;
  statuses: string[];
  views: number;
  pdfDownloads: number;
  requestsSent: number;
  lastPriceCreatedAt: string | null;
  lastViewAt: string | null;
  lastActivityAt: string | null;
  hasActiveActualPrice: boolean;
};

export type PeriodComparison = {
  label: string;
  current: number;
  previous: number;
  changePercent: number | null;
};

export type ManagerAnalytics = {
  manager: {
    id: number;
    name: string;
    login: string;
    email: string;
    phone: string;
    role: string;
    lastLoginAt: string | null;
  };
  summary: {
    totalPrices: number;
    activePrices: number;
    expiredPrices: number;
    expiringSoon7Days?: number;
    expiringSoon30Days?: number;
    pricesLast7Days: number;
    pricesLast30Days: number;
    periodPrices: number;
    averageItemsPerPrice: number;
    medianItemsPerPrice?: number;
    emptyPrices: number;
    pricesWithoutClient: number;
    pricesWithoutExpiration: number;
    stalePrices30Days?: number;
    pricesWithoutViews?: number;
    qualityScore?: number;
    disabledPrices?: number;
    pricesWithoutPdfDownloads?: number;
  };
  managerActivity?: {
    loginsLast7Days: number;
    loginsLast30Days: number;
    loginsInSelectedPeriod: number;
    activeDaysInSelectedPeriod: number;
    actionsLast7Days: number;
    actionsLast30Days: number;
    actionsInSelectedPeriod: number;
    lastAction: { eventType: string; priceTitle: string; clientName: string; createdAt: string } | null;
    createdPrices: number;
    updatedPrices: number;
    activatedPrices: number;
    deactivatedPrices: number;
    deletedPrices: number;
  };
  lastCreatedPrice: { id: number; title: string; createdAt: string } | null;
  lastChange: AnalyticsChange | null;
  problemPrices: ProblemPrice[];
  recentChanges: AnalyticsChange[];
  publicViews: {
    total: number;
    uniqueVisitors?: number;
    last7Days: number;
    last30Days: number;
    periodViews: number;
    repeatViews?: number;
    lastViewAt: string | null;
    pricesWithoutViews?: number;
    averageViewsPerPrice?: number;
    topPrices: Array<{
      priceId: number;
      title: string;
      clientName?: string;
      views: number;
      uniqueVisitors?: number;
      lastViewAt: string | null;
    }>;
    recentViews?: AnalyticsEvent[];
    pricesWithoutViewsList?: ProblemPrice[];
  };
  pdf?: {
    totalDownloads: number;
    downloadsLast7Days: number;
    downloadsLast30Days: number;
    downloadsInSelectedPeriod: number;
    uniqueDownloaders: number;
    lastDownloadAt: string | null;
    pricesWithDownloads: number;
    pricesWithoutDownloads: number;
    topDownloadedPrices: Array<{
      priceId: number;
      title: string;
      clientName: string;
      downloads: number;
      uniqueDownloaders: number;
      views: number;
      lastDownloadAt: string | null;
    }>;
    recentDownloads: AnalyticsEvent[];
    clientsWithPdfDownloads: Array<{
      clientId: string;
      clientName: string;
      priceId: number;
      priceTitle: string;
      downloads: number;
      lastDownloadAt: string | null;
    }>;
  };
  clients?: {
    totalClients: number;
    clientsWithPrices: number;
    clientsWithViews: number;
    clientsWithoutViews: number;
    clientsWithPdfDownloads: number;
    hotClients: AnalyticsClient[];
    topClientsByViews: AnalyticsClient[];
    clientsWithoutRecentActivity: AnalyticsClient[];
  };
  funnel?: {
    createdPrices: number;
    activePublicLinks: number;
    openedPrices: number;
    pricesWithRepeatViews: number;
    pdfDownloadedPrices: number;
    requestsSent?: number;
    contactClicks: number;
  };
  priceInsights?: {
    expiringSoon: ProblemPrice[];
    pricesWithoutViews: ProblemPrice[];
    topViewedPrices: Array<{
      priceId: number;
      title: string;
      clientName: string;
      views: number;
      uniqueVisitors: number;
      pdfDownloads: number;
      lastViewAt: string | null;
    }>;
    mostChangedPrices: Array<{
      priceId: number;
      title: string;
      clientName: string;
      changes: number;
      lastChangedAt: string | null;
      lastChangedBy: string;
    }>;
    largestPrice: { id: number; title: string; itemCount: number } | null;
    smallestNonEmptyPrice: { id: number; title: string; itemCount: number } | null;
  };
  attention?: {
    statusFunnel: StatusFunnel;
    stuckPrices: AttentionPrice[];
    managerReactionNeeded: ReactionNeeded[];
    priorityClients: PriorityClient[];
    clientHistory: ClientHistory[];
    comparison: PeriodComparison[];
  };
  recentEvents?: AnalyticsEvent[];
};

export type AdminManagerAnalyticsProps = {
  managerId: number;
};
