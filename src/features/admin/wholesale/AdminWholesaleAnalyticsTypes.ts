export type Period = '7d' | '30d' | 'all';
export type ExportFormat = 'pdf' | 'xls';
export type Tab = 'overview' | 'managers' | 'managerRatings' | 'prices' | 'clients' | 'publicActivity' | 'events';
export type PublicActivityTab = 'public' | 'pdf' | 'excel';
export type AdminWholesaleAnalyticsTab = Tab;

export type Problem = 'EMPTY' | 'NO_CLIENT' | 'NO_EXPIRATION' | 'EXPIRED' | 'EXPIRING_SOON' | 'STALE' | 'NO_VIEWS';

export type ProblemPrice = {
  id: number;
  title: string;
  clientName: string;
  managerId: number | null;
  managerName: string;
  createdAt: string;
  updatedAt?: string;
  validUntil: string | null;
  views?: number;
  pdfDownloads?: number;
  isActive?: boolean;
  daysLeft?: number | null;
  problems: Problem[];
};

export type ManagerRow = {
  id: number;
  name: string;
  login: string;
  email: string;
  phone: string;
  isActive: boolean;
  totalPrices: number;
  activePrices: number;
  expiredPrices: number;
  problemPrices: number;
  pricesCreatedInSelectedPeriod: number;
  actionsInSelectedPeriod: number;
  publicViews: number;
  uniqueVisitors: number;
  pdfDownloads: number;
  clientsWithActivity: number;
  qualityScore: number;
  lastLoginAt: string | null;
  lastActionAt: string | null;
  viewsPerActivePrice?: number;
  pdfPerActivePrice?: number;
  requestsPerActivePrice?: number;
  sentToOpenedConversion?: number;
  openedToPdfConversion?: number;
  openedToRequestConversion?: number;
  stuckPriceRate?: number;
  confirmedPriceRate?: number;
  averageReactionHours?: number | null;
};

export type AnalyticsEvent = {
  id: number;
  eventType: string;
  actorType: string;
  managerId: number | null;
  managerName: string;
  priceId: number | null;
  priceTitle: string;
  clientId: string;
  clientName: string;
  createdAt: string;
  details: string;
  sessionId: string;
  referer: string;
  eventLabelOverride?: string;
};

export type ClientRow = {
  clientId: string;
  clientName: string;
  managerId: number | null;
  managerName: string;
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

export type Analytics = {
  period: Period;
  summary: {
    totalManagers: number;
    activeManagers: number;
    inactiveManagers: number;
    totalPrices: number;
    activePrices: number;
    inactivePrices: number;
    expiredPrices: number;
    expiringSoon7Days: number;
    expiringSoon30Days: number;
    pricesCreatedLast7Days: number;
    pricesCreatedLast30Days: number;
    pricesCreatedInSelectedPeriod: number;
    problemPrices: number;
    averageItemsPerPrice: number;
    medianItemsPerPrice: number;
    emptyPrices: number;
    pricesWithoutClient: number;
    pricesWithoutExpiration: number;
    stalePrices30Days: number;
    pricesWithoutViews: number;
    pricesWithoutPdfDownloads: number;
    totalPublicViews: number;
    uniquePublicVisitors: number;
    publicViewsInSelectedPeriod: number;
    totalPdfDownloads: number;
    pdfDownloadsInSelectedPeriod: number;
    clientsWithActivity: number;
    averageQualityScore: number;
  };
  managerActivity: {
    actionsLast7Days: number;
    actionsLast30Days: number;
    actionsInSelectedPeriod: number;
    loginsLast7Days: number;
    loginsLast30Days: number;
    loginsInSelectedPeriod: number;
    activeDaysInSelectedPeriod: number;
    activeManagersInSelectedPeriod: number;
    inactiveManagersInSelectedPeriod: number;
    lastLogin: { managerId: number | null; managerName: string; createdAt: string } | null;
    lastAction: { eventType: string; managerId: number | null; managerName: string; priceTitle: string; clientName: string; createdAt: string } | null;
  };
  managers: ManagerRow[];
  priceQuality: {
    emptyPrices: number;
    pricesWithoutClient: number;
    pricesWithoutExpiration: number;
    expiredPrices: number;
    expiringSoon7Days: number;
    expiringSoon30Days: number;
    stalePrices30Days: number;
    pricesWithoutViews: number;
    pricesWithoutPdfDownloads: number;
    averageQualityScore: number;
    bestManager: ManagerRow | null;
    managersNeedAttention: ManagerRow[];
    problemsByManager: Array<{
      managerId: number;
      managerName: string;
      emptyPrices: number;
      pricesWithoutClient: number;
      pricesWithoutExpiration: number;
      expiredPrices: number;
      pricesWithoutViews: number;
      stalePrices30Days: number;
      totalProblems: number;
    }>;
  };
  priceInsights: {
    latestPrices: ProblemPrice[];
    expiringSoonPrices: ProblemPrice[];
    pricesWithoutViews: ProblemPrice[];
    topViewedPrice: { priceId: number; title: string; managerName: string; views: number } | null;
    topDownloadedPrice: { priceId: number; title: string; managerName: string; downloads: number } | null;
    largestPrice: { id: number; title: string; managerName: string; itemCount: number } | null;
  };
  publicLinks: {
    totalViews: number;
    uniqueVisitors: number;
    repeatViews: number;
    viewsLast7Days: number;
    viewsLast30Days: number;
    viewsInSelectedPeriod: number;
    lastViewAt: string | null;
    pricesWithoutViews: number;
    averageViewsPerPrice: number;
    topManager: { managerId: number | null; managerName: string; views: number } | null;
    topViewedPrices: Array<{
      priceId: number;
      title: string;
      clientName: string;
      managerId: number | null;
      managerName: string;
      views: number;
      uniqueVisitors: number;
      repeatViews: number;
      lastViewAt: string | null;
    }>;
    latestViews: AnalyticsEvent[];
    pricesWithoutViewsList: ProblemPrice[];
  };
  pdf: {
    totalDownloads: number;
    downloadsLast7Days: number;
    downloadsLast30Days: number;
    downloadsInSelectedPeriod: number;
    uniqueDownloaders: number;
    lastDownloadAt: string | null;
    pricesWithDownloads: number;
    pricesWithoutDownloads: number;
    topManager: { managerId: number | null; managerName: string; downloads: number } | null;
    topDownloadedPrices: Array<{
      priceId: number;
      title: string;
      clientName: string;
      managerId: number | null;
      managerName: string;
      downloads: number;
      uniqueDownloaders: number;
      views: number;
      lastDownloadAt: string | null;
    }>;
    latestDownloads: AnalyticsEvent[];
    managersByDownloads: Array<{
      managerId: number | null;
      managerName: string;
      pricesWithDownloads: number;
      downloads: number;
      uniqueDownloaders: number;
      lastDownloadAt: string | null;
    }>;
  };
  excel: {
    totalDownloads: number;
    downloadsLast7Days: number;
    downloadsLast30Days: number;
    downloadsInSelectedPeriod: number;
    uniqueDownloaders: number;
    lastDownloadAt: string | null;
    pricesWithDownloads: number;
    pricesWithoutDownloads: number;
    topManager: { managerId: number | null; managerName: string; downloads: number } | null;
    topDownloadedPrices: Array<{
      priceId: number;
      title: string;
      clientName: string;
      managerId: number | null;
      managerName: string;
      downloads: number;
      uniqueDownloaders: number;
      views: number;
      lastDownloadAt: string | null;
    }>;
    latestDownloads: AnalyticsEvent[];
    managersByDownloads: Array<{
      managerId: number | null;
      managerName: string;
      pricesWithDownloads: number;
      downloads: number;
      uniqueDownloaders: number;
      lastDownloadAt: string | null;
    }>;
  };
  clients: {
    totalClients: number;
    clientsWithActivePrices: number;
    clientsWithViews: number;
    clientsWithoutViews: number;
    clientsWithPdfDownloads: number;
    hotClientsCount: number;
    clientsWithExpiredPrices: number;
    clientsWithoutActualActivePrice: number;
    hotClients: ClientRow[];
    clientsWithoutViewsList: ClientRow[];
    topClientsByActivity: ClientRow[];
  };
  funnel: {
    createdPrices: number;
    activePublicLinks: number;
    openedPrices: number;
    pricesWithRepeatViews: number;
    pdfDownloadedPrices: number;
    requestsSent: number;
    clientsWithActivity: number;
  };
  attention: {
    statusFunnel: StatusFunnel;
    stuckPrices: AttentionPrice[];
    managerReactionNeeded: ReactionNeeded[];
    priorityClients: PriorityClient[];
    clientHistory: ClientHistory[];
    comparison: PeriodComparison[];
  };
  problemPrices: ProblemPrice[];
  recentEvents: AnalyticsEvent[];
};
