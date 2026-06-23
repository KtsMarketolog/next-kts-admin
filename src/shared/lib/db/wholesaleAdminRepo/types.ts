import type { WholesalePriceWorkflowStatus } from '@/shared/lib/wholesalePriceWorkflowStatus';

export type WholesaleManager = {
  id: number;
  name: string;
  login: string;
  email: string;
  phone: string;
  displayPassword: string;
  role: WholesaleManagerRole;
  supportManagerId: number | null;
  supportManagerName: string;
  isActive: boolean;
  priceListCount: number;
  lastChangedAt: string | null;
  lastChangedPriceTitle: string | null;
};

export type WholesaleManagerRole = 'manager' | 'support_manager';

export type WholesaleManagerAuth = {
  id: number;
  login: string;
  email: string;
  role: WholesaleManagerRole;
  passwordHash: string;
  isActive: boolean;
  passwordChangedAt: string | null;
};

export type WholesaleManagerProfile = {
  id: number;
  name: string;
  login: string;
  email: string;
  phone: string;
  role: WholesaleManagerRole;
  isActive: boolean;
};

export type WholesalePriceListSummary = {
  id: number;
  title: string;
  clientCompanyId: number | null;
  clientName: string;
  token: string;
  validUntil: string | null;
  workflowStatus: WholesalePriceWorkflowStatus;
  workflowStatusLabel: string;
  showRetailPrices: boolean;
  showStock: boolean;
  showStockText: boolean;
  isActive: boolean;
  managerId: number | null;
  managerName: string | null;
  itemCount: number;
  priceGroupCount: number;
  createdAt: string;
  updatedAt: string;
  lastChangedAt: string | null;
  lastChangedTitle: string | null;
  lastChangedByName: string | null;
};

export type WholesaleCatalogVariant = {
  id: number | null;
  title: string;
  retailPrice: string | null;
  wholesalePrice: string | null;
};

export type WholesaleCatalogProduct = {
  id: number;
  title: string;
  sku: string;
  model: string;
  description: string;
  imageUrl: string | null;
  priceGroup: string;
  priceGroupImageUrl: string | null;
  priceEur: string | null;
  priceRub: string | null;
  priceCny: string | null;
  generalDiscount: string | null;
  manualDiscount: string | null;
  manualDiscountRop: string | null;
  stock: number;
  unit: string | null;
  isExpected: boolean;
  stockUpdatedAt: string | null;
  variants: WholesaleCatalogVariant[];
};

export type WholesaleCatalogCategory = {
  id: number;
  title: string;
  products: WholesaleCatalogProduct[];
};

export type WholesalePriceListItemInput = {
  productId: number;
  variantId: number | null;
  customWholesalePrice: string | null;
  priceManuallyChanged: boolean;
  visible: boolean;
  sortOrder: number;
};

export type WholesalePriceGroupStockSettingInput = {
  priceGroup: string;
  showStock: boolean;
  showStockText: boolean;
};

export type WholesalePriceListEditor = {
  id: number;
  title: string;
  clientCompanyId: number | null;
  clientName: string;
  token: string;
  validUntil: string | null;
  comment: string;
  workflowStatus: WholesalePriceWorkflowStatus;
  showRetailPrices: boolean;
  showStock: boolean;
  showStockText: boolean;
  isActive: boolean;
  managerId: number | null;
  supportManagerId: number | null;
  items: WholesalePriceListItemInput[];
  priceGroupStockSettings: WholesalePriceGroupStockSettingInput[];
};

export type WholesaleDiscountReportRow = {
  priceGroup: string;
  discount: string;
  company: string;
  manager: string;
  priceId: number;
  priceTitle: string;
};

export type WholesaleManagerAnalyticsPeriod = '7d' | '30d' | 'all';
export type WholesaleAdminAnalyticsPeriod = WholesaleManagerAnalyticsPeriod;

export type WholesaleManagerAnalytics = {
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
    lastAction: {
      eventType: string;
      priceTitle: string;
      clientName: string;
      createdAt: string;
    } | null;
    createdPrices: number;
    updatedPrices: number;
    activatedPrices: number;
    deactivatedPrices: number;
    deletedPrices: number;
  };
  lastCreatedPrice: {
    id: number;
    title: string;
    createdAt: string;
  } | null;
  lastChange: WholesaleManagerAnalyticsChange | null;
  problemPrices: WholesaleManagerAnalyticsProblemPrice[];
  recentChanges: WholesaleManagerAnalyticsChange[];
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
    recentViews?: WholesaleManagerAnalyticsEvent[];
    pricesWithoutViewsList?: WholesaleManagerAnalyticsProblemPrice[];
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
    recentDownloads: WholesaleManagerAnalyticsEvent[];
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
    hotClients: WholesaleManagerAnalyticsClient[];
    topClientsByViews: WholesaleManagerAnalyticsClient[];
    clientsWithoutRecentActivity: WholesaleManagerAnalyticsClient[];
  };
  funnel?: {
    createdPrices: number;
    activePublicLinks: number;
    openedPrices: number;
    pricesWithRepeatViews: number;
    pdfDownloadedPrices: number;
    requestsSent: number;
    contactClicks: number;
  };
  attention?: {
    statusFunnel: WholesaleAnalyticsStatusFunnel;
    stuckPrices: WholesaleAnalyticsAttentionPrice[];
    managerReactionNeeded: WholesaleAnalyticsReactionNeeded[];
    priorityClients: WholesaleAnalyticsPriorityClient[];
    clientHistory: WholesaleAnalyticsClientHistory[];
    productInterest: WholesaleAnalyticsProductInterest[];
    comparison: WholesaleAnalyticsPeriodComparison[];
  };
  priceInsights?: {
    expiringSoon: WholesaleManagerAnalyticsProblemPrice[];
    pricesWithoutViews: WholesaleManagerAnalyticsProblemPrice[];
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
  recentEvents?: WholesaleManagerAnalyticsEvent[];
};

export type WholesaleManagerAnalyticsProblem =
  | 'EMPTY'
  | 'NO_CLIENT'
  | 'NO_EXPIRATION'
  | 'EXPIRED'
  | 'EXPIRING_SOON'
  | 'STALE'
  | 'NO_VIEWS';

export type WholesaleManagerAnalyticsProblemPrice = {
  id: number;
  title: string;
  clientName: string;
  createdAt: string;
  updatedAt?: string;
  validUntil: string | null;
  views?: number;
  pdfDownloads?: number;
  problems: WholesaleManagerAnalyticsProblem[];
};

export type WholesaleManagerAnalyticsChange = {
  id: number;
  priceId: number | null;
  priceTitle: string;
  action: string;
  changedBy: string;
  createdAt: string;
  details: string;
};

export type WholesaleManagerAnalyticsEvent = {
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

export type WholesaleManagerAnalyticsClient = {
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

export type WholesaleAnalyticsStatusFunnelStep = {
  key: string;
  label: string;
  count: number;
  dropFromPrevious: number;
  conversionFromPrevious: number;
  conversionFromTotal: number;
};

export type WholesaleAnalyticsStatusFunnel = {
  steps: WholesaleAnalyticsStatusFunnelStep[];
  biggestDrop: WholesaleAnalyticsStatusFunnelStep | null;
  averageTimeToOpenHours: number | null;
  averageTimeToPdfHours: number | null;
  averageTimeToRequestHours: number | null;
};

export type WholesaleAnalyticsAttentionPrice = {
  id: number;
  title: string;
  clientName: string;
  managerId: number | null;
  managerName: string;
  workflowStatus: WholesalePriceWorkflowStatus;
  workflowStatusLabel: string;
  reason: string;
  daysInStage: number;
  views: number;
  pdfDownloads: number;
  requestsSent: number;
  lastClientActivityAt: string | null;
  lastManagerActivityAt: string | null;
};

export type WholesaleAnalyticsReactionNeeded = {
  priceId: number;
  priceTitle: string;
  clientName: string;
  managerId: number | null;
  managerName: string;
  lastClientEventType: string;
  lastClientActivityAt: string;
  lastManagerActivityAt: string | null;
  hoursWithoutReaction: number;
  workflowStatus: WholesalePriceWorkflowStatus;
  workflowStatusLabel: string;
};

export type WholesaleAnalyticsPriorityClient = {
  clientId: string;
  clientName: string;
  managerId: number | null;
  managerName: string;
  priceId: number | null;
  priceTitle: string;
  score: number;
  reasons: string[];
  viewsLast24Hours: number;
  viewsLast7Days: number;
  repeatViews: number;
  pdfDownloads: number;
  requestsSent: number;
  lastActivityAt: string | null;
  workflowStatus: WholesalePriceWorkflowStatus;
  workflowStatusLabel: string;
};

export type WholesaleAnalyticsClientHistory = {
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

export type WholesaleAnalyticsProductInterest = {
  productTitle: string;
  productId: number | null;
  opens: number;
  quantityChanges: number;
  requests: number;
  lastActivityAt: string | null;
};

export type WholesaleAnalyticsPeriodComparison = {
  label: string;
  current: number;
  previous: number;
  changePercent: number | null;
};

export type WholesaleAdminAnalyticsManager = {
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
  viewsPerActivePrice: number;
  pdfPerActivePrice: number;
  requestsPerActivePrice: number;
  sentToOpenedConversion: number;
  openedToPdfConversion: number;
  openedToRequestConversion: number;
  stuckPriceRate: number;
  confirmedPriceRate: number;
  averageReactionHours: number | null;
};

export type WholesaleAdminAnalyticsProblemPrice = WholesaleManagerAnalyticsProblemPrice & {
  managerId: number | null;
  managerName: string;
  isActive: boolean;
  daysLeft: number | null;
};

export type WholesaleAdminAnalyticsEvent = WholesaleManagerAnalyticsEvent & {
  managerId: number | null;
};

export type WholesaleAdminAnalyticsClient = WholesaleManagerAnalyticsClient & {
  managerId: number | null;
  managerName: string;
};

export type WholesaleAdminAnalytics = {
  period: WholesaleAdminAnalyticsPeriod;
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
  managers: WholesaleAdminAnalyticsManager[];
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
    bestManager: WholesaleAdminAnalyticsManager | null;
    managersNeedAttention: WholesaleAdminAnalyticsManager[];
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
    latestPrices: WholesaleAdminAnalyticsProblemPrice[];
    expiringSoonPrices: WholesaleAdminAnalyticsProblemPrice[];
    pricesWithoutViews: WholesaleAdminAnalyticsProblemPrice[];
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
    latestViews: WholesaleAdminAnalyticsEvent[];
    pricesWithoutViewsList: WholesaleAdminAnalyticsProblemPrice[];
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
    latestDownloads: WholesaleAdminAnalyticsEvent[];
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
    latestDownloads: WholesaleAdminAnalyticsEvent[];
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
    hotClients: WholesaleAdminAnalyticsClient[];
    clientsWithoutViewsList: WholesaleAdminAnalyticsClient[];
    topClientsByActivity: WholesaleAdminAnalyticsClient[];
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
    statusFunnel: WholesaleAnalyticsStatusFunnel;
    stuckPrices: WholesaleAnalyticsAttentionPrice[];
    managerReactionNeeded: WholesaleAnalyticsReactionNeeded[];
    priorityClients: WholesaleAnalyticsPriorityClient[];
    clientHistory: WholesaleAnalyticsClientHistory[];
    productInterest: WholesaleAnalyticsProductInterest[];
    comparison: WholesaleAnalyticsPeriodComparison[];
  };
  problemPrices: WholesaleAdminAnalyticsProblemPrice[];
  recentEvents: WholesaleAdminAnalyticsEvent[];
};
