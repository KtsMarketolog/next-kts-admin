import type { AdminSession } from '@/shared/lib/adminAuth';
import {
  getWholesalePriceWorkflowStatusLabel,
  normalizeWholesalePriceWorkflowStatus,
  type WholesalePriceWorkflowStatus,
} from '@/shared/lib/wholesalePriceWorkflowStatus';

import { trackAnalyticsEvent, type AnalyticsActorType, type AnalyticsEventType } from './analyticsRepo';
import { query } from './client';
import { ensureSiteSchema } from './schema';

export type WholesaleManager = {
  id: number;
  name: string;
  login: string;
  email: string;
  phone: string;
  isActive: boolean;
  priceListCount: number;
  lastChangedAt: string | null;
  lastChangedPriceTitle: string | null;
};

export type WholesaleManagerAuth = {
  id: number;
  login: string;
  email: string;
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
  isActive: boolean;
};

export type WholesalePriceListSummary = {
  id: number;
  title: string;
  clientName: string;
  token: string;
  validUntil: string | null;
  workflowStatus: WholesalePriceWorkflowStatus;
  workflowStatusLabel: string;
  showRetailPrices: boolean;
  isActive: boolean;
  managerId: number | null;
  managerName: string | null;
  itemCount: number;
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
  description: string;
  imageUrl: string | null;
  priceGroup: string;
  priceEur: string | null;
  priceRub: string | null;
  priceCny: string | null;
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
  visible: boolean;
  sortOrder: number;
};

export type WholesalePriceListEditor = {
  id: number;
  title: string;
  clientName: string;
  token: string;
  validUntil: string | null;
  comment: string;
  workflowStatus: WholesalePriceWorkflowStatus;
  showRetailPrices: boolean;
  isActive: boolean;
  managerId: number | null;
  items: WholesalePriceListItemInput[];
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

type ManagerRow = {
  id: string;
  name: string;
  login: string;
  email: string;
  phone: string;
  is_active: boolean;
  price_list_count: string;
  last_changed_at: string | null;
  last_changed_price_title: string | null;
};

type PriceListRow = {
  id: string;
  title: string;
  client_name: string;
  token: string;
  valid_until: string | null;
  workflow_status: string | null;
  show_retail_prices: boolean;
  is_active: boolean;
  manager_id: string | null;
  manager_name: string | null;
  item_count: string;
  created_at: string;
  updated_at: string;
  last_changed_at: string | null;
  last_changed_title: string | null;
  last_changed_by_name: string | null;
};

type PriceListEventInput = {
  priceListId: number;
  ownerManagerId: number | null;
  actorManagerId: number | null;
  actorRole: AdminSession['role'] | 'admin';
  title: string;
  action: string;
  details?: string;
};

type AnalyticsChangeRow = {
  id: string;
  price_id: string | null;
  price_title: string;
  action: string;
  changed_by: string | null;
  created_at: string;
  details: string | null;
};

type AnalyticsProblemRow = {
  id: string;
  title: string;
  client_name: string;
  valid_until: string | null;
  created_at: string;
  updated_at: string;
  item_count: string;
  views: string;
  pdf_downloads: string;
};

type AnalyticsSummaryRow = {
  total_prices: string;
  active_prices: string;
  expired_prices: string;
  expiring_soon_7_days: string;
  expiring_soon_30_days: string;
  prices_last_7_days: string;
  prices_last_30_days: string;
  period_prices: string;
  average_items_per_price: string | null;
  median_items_per_price: string | null;
  empty_prices: string;
  prices_without_client: string;
  prices_without_expiration: string;
  stale_prices_30_days: string;
  prices_without_views: string;
  disabled_prices: string;
  prices_without_pdf_downloads: string;
};

type AnalyticsEventRow = {
  id: string;
  event_type: string;
  actor_type: string;
  price_id: string | null;
  price_title: string | null;
  client_id: string | null;
  client_name: string | null;
  manager_name: string | null;
  created_at: string;
  details: string | null;
  session_id: string | null;
  referer: string | null;
};

function normalizeLogin(login: string) {
  return login.trim().toLowerCase();
}

function sessionManagerId(session?: AdminSession | null) {
  return session?.role === 'manager' ? session.managerId ?? -1 : null;
}

function periodSqlInterval(period: WholesaleManagerAnalyticsPeriod) {
  if (period === '7d') return '7 days';
  if (period === '30d') return '30 days';
  return null;
}

function actorTypeFromRole(role: AdminSession['role'] | 'admin'): AnalyticsActorType {
  return role === 'manager' ? 'manager' : 'admin';
}

function actionEventType(action: string): AnalyticsEventType {
  if (action === 'create') return 'price_created';
  if (action === 'delete') return 'price_deleted';
  if (action === 'enable') return 'price_activated';
  if (action === 'disable') return 'price_deactivated';
  if (action === 'status') return 'price_status_changed';
  return 'price_updated';
}

function clientIdFromName(clientName?: string | null) {
  const value = clientName?.trim();
  return value ? value.toLowerCase() : null;
}

function actorMeta(session?: AdminSession | null) {
  const actorManagerId = session?.role === 'manager' ? session.managerId ?? null : null;
  const actorRole: AdminSession['role'] =
    session?.role === 'manager' ? 'manager' : session?.role === 'wholesale_admin' ? 'wholesale_admin' : 'admin';
  const actorFallback =
    actorRole === 'admin' ? 'Администратор' : actorRole === 'wholesale_admin' ? 'Администратор прайсов' : 'Менеджер';

  return { actorManagerId, actorRole, actorFallback };
}

function priceListAction(previous: { is_active: boolean } | null, next: { isActive: boolean }) {
  if (!previous) return 'create';
  if (previous.is_active !== next.isActive) return next.isActive ? 'enable' : 'disable';
  return 'edit';
}

function priceListDetails(
  previous: { client_name: string; valid_until: string | null; is_active: boolean; workflow_status?: string | null } | null,
  next: Pick<WholesalePriceListEditor, 'clientName' | 'validUntil' | 'isActive' | 'workflowStatus'>,
) {
  if (!previous) return 'Прайс создан';

  const details: string[] = [];
  if ((previous.client_name || '') !== next.clientName) details.push('изменён клиент');
  if ((previous.valid_until || '') !== (next.validUntil || '')) details.push('изменён срок действия');
  if (normalizeWholesalePriceWorkflowStatus(previous.workflow_status) !== next.workflowStatus) details.push('изменён статус работы');
  if (previous.is_active !== next.isActive) details.push(next.isActive ? 'прайс включён' : 'прайс отключён');
  return details.length ? details.join(', ') : 'Прайс обновлён';
}

function mapAnalyticsChange(row: AnalyticsChangeRow): WholesaleManagerAnalyticsChange {
  return {
    id: Number(row.id),
    priceId: row.price_id ? Number(row.price_id) : null,
    priceTitle: row.price_title || 'Без названия',
    action: row.action,
    changedBy: row.changed_by || 'Не указано',
    createdAt: row.created_at,
    details: row.details || '',
  };
}

function mapProblemPrice(row: AnalyticsProblemRow): WholesaleManagerAnalyticsProblemPrice {
  const problems: WholesaleManagerAnalyticsProblem[] = [];
  const itemCount = Number(row.item_count);
  const views = Number(row.views ?? 0);
  const validUntil = row.valid_until ? new Date(row.valid_until) : null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiringSoonDate = new Date(today);
  expiringSoonDate.setDate(expiringSoonDate.getDate() + 7);
  const updatedAt = new Date(row.updated_at ?? row.created_at);
  const staleDate = new Date();
  staleDate.setDate(staleDate.getDate() - 30);

  if (itemCount === 0) problems.push('EMPTY');
  if (!row.client_name.trim()) problems.push('NO_CLIENT');
  if (!row.valid_until) problems.push('NO_EXPIRATION');
  if (validUntil && validUntil < today) problems.push('EXPIRED');
  if (validUntil && validUntil >= today && validUntil <= expiringSoonDate) problems.push('EXPIRING_SOON');
  if (!Number.isNaN(updatedAt.getTime()) && updatedAt < staleDate) problems.push('STALE');
  if (views === 0) problems.push('NO_VIEWS');

  return {
    id: Number(row.id),
    title: row.title || 'Без названия',
    clientName: row.client_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    validUntil: row.valid_until,
    views,
    pdfDownloads: Number(row.pdf_downloads ?? 0),
    problems,
  };
}

function mapAnalyticsEvent(row: AnalyticsEventRow): WholesaleManagerAnalyticsEvent {
  return {
    id: Number(row.id),
    eventType: row.event_type,
    actorType: row.actor_type,
    priceId: row.price_id ? Number(row.price_id) : null,
    priceTitle: row.price_title || 'Без названия',
    clientId: row.client_id || '',
    clientName: row.client_name || '',
    managerName: row.manager_name || '',
    createdAt: row.created_at,
    details: row.details || '',
    sessionId: row.session_id || '',
    referer: row.referer || '',
  };
}

function qualityScore(input: {
  emptyPrices: number;
  pricesWithoutClient: number;
  pricesWithoutExpiration: number;
  expiredPrices: number;
  pricesWithoutViews: number;
  stalePrices30Days: number;
}) {
  const score =
    100 -
    Math.min(input.emptyPrices * 20, 40) -
    Math.min(input.pricesWithoutClient * 15, 30) -
    Math.min(input.pricesWithoutExpiration * 10, 20) -
    Math.min(input.expiredPrices * 15, 30) -
    Math.min(input.pricesWithoutViews * 5, 20) -
    Math.min(input.stalePrices30Days * 5, 20);
  return Math.max(0, Math.min(100, score));
}

type AnalyticsWorkflowRow = {
  id: string;
  title: string;
  client_name: string;
  workflow_status?: string | null;
  valid_until: string | null;
  is_active: boolean;
  manager_id?: string | null;
  manager_name?: string | null;
  created_at: string;
  updated_at: string;
  views: string;
  views_last_7_days: string;
  repeat_views: string;
  pdf_downloads: string;
  requests_sent: string;
  last_view_at: string | null;
  last_pdf_at: string | null;
  last_request_at: string | null;
  first_view_at?: string | null;
  first_pdf_at?: string | null;
  first_request_at?: string | null;
  last_manager_activity_at?: string | null;
  last_client_event_type?: string | null;
};

const closedWorkflowStatuses = new Set<WholesalePriceWorkflowStatus>(['confirmed', 'rejected']);

function safeTime(value: string | null | undefined) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function maxDateString(values: Array<string | null | undefined>) {
  return values.filter(Boolean).sort().at(-1) ?? null;
}

function hoursBetween(start: string | null | undefined, end: string | null | undefined) {
  const startTime = safeTime(start);
  const endTime = safeTime(end);
  if (startTime === null || endTime === null || endTime < startTime) return null;
  return Math.round(((endTime - startTime) / (60 * 60 * 1000)) * 10) / 10;
}

function averageHours(rows: AnalyticsWorkflowRow[], from: keyof AnalyticsWorkflowRow, to: keyof AnalyticsWorkflowRow) {
  const values = rows
    .map((row) => hoursBetween(row[from] as string | null | undefined, row[to] as string | null | undefined))
    .filter((value): value is number => value !== null);
  if (!values.length) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

function rowManagerId(row: AnalyticsWorkflowRow) {
  return row.manager_id ? Number(row.manager_id) : null;
}

function rowManagerName(row: AnalyticsWorkflowRow) {
  return row.manager_name || '';
}

function rowStatus(row: AnalyticsWorkflowRow) {
  return normalizeWholesalePriceWorkflowStatus(row.workflow_status);
}

function rowStatusLabel(row: AnalyticsWorkflowRow) {
  return getWholesalePriceWorkflowStatusLabel(row.workflow_status);
}

function rowLastClientActivity(row: AnalyticsWorkflowRow) {
  return maxDateString([row.last_view_at, row.last_pdf_at, row.last_request_at]);
}

function rowLastClientEventType(row: AnalyticsWorkflowRow) {
  const lastActivity = rowLastClientActivity(row);
  if (!lastActivity) return row.last_client_event_type || '';
  if (row.last_request_at === lastActivity) return 'public_price_request_sent';
  if (row.last_pdf_at === lastActivity) return 'public_price_pdf_downloaded';
  if (row.last_view_at === lastActivity) return Number(row.repeat_views) > 0 ? 'public_price_reopened' : 'public_price_opened';
  return row.last_client_event_type || '';
}

function validUntilTime(value: string | null) {
  return value ? safeTime(`${value}T00:00:00`) : null;
}

function buildStatusFunnel(rows: AnalyticsWorkflowRow[]): WholesaleAnalyticsStatusFunnel {
  const total = rows.length;
  const reachedSent = rows.filter((row) => rowStatus(row) !== 'not_sent').length;
  const opened = rows.filter((row) => Number(row.views) > 0).length;
  const pdf = rows.filter((row) => Number(row.pdf_downloads) > 0).length;
  const requested = rows.filter((row) => Number(row.requests_sent) > 0).length;
  const negotiation = rows.filter((row) => ['negotiation', 'confirmed', 'rejected'].includes(rowStatus(row))).length;
  const confirmed = rows.filter((row) => rowStatus(row) === 'confirmed').length;
  const rejected = rows.filter((row) => rowStatus(row) === 'rejected').length;
  const rawSteps = [
    { key: 'created', label: 'Создано прайсов', count: total },
    { key: 'sent', label: 'Отправлено клиенту', count: reachedSent },
    { key: 'opened', label: 'Открыто клиентом', count: opened },
    { key: 'pdf', label: 'Скачали PDF', count: pdf },
    { key: 'request', label: 'Отправили заявку', count: requested },
    { key: 'negotiation', label: 'На согласовании', count: negotiation },
    { key: 'confirmed', label: 'Подтверждено', count: confirmed },
    { key: 'rejected', label: 'Отклонено', count: rejected },
  ];
  const steps = rawSteps.map<WholesaleAnalyticsStatusFunnelStep>((step, index) => {
    const previous = index === 0 ? step.count : rawSteps[index - 1].count;
    return {
      ...step,
      dropFromPrevious: Math.max(0, previous - step.count),
      conversionFromPrevious: previous > 0 ? Math.round((step.count / previous) * 100) : 0,
      conversionFromTotal: total > 0 ? Math.round((step.count / total) * 100) : 0,
    };
  });

  return {
    steps,
    biggestDrop: steps.slice(1).sort((a, b) => b.dropFromPrevious - a.dropFromPrevious)[0] ?? null,
    averageTimeToOpenHours: averageHours(rows, 'created_at', 'first_view_at'),
    averageTimeToPdfHours: averageHours(rows, 'first_view_at', 'first_pdf_at'),
    averageTimeToRequestHours: averageHours(rows, 'first_view_at', 'first_request_at'),
  };
}

function buildStuckPrices(rows: AnalyticsWorkflowRow[], now: number, todayTime: number, day: number, limit = 20): WholesaleAnalyticsAttentionPrice[] {
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

function buildReactionNeeded(rows: AnalyticsWorkflowRow[], now: number, limit = 20): WholesaleAnalyticsReactionNeeded[] {
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

function buildPriorityClients(rows: AnalyticsWorkflowRow[], views24ByClient: Map<string, number>, reactionRows: WholesaleAnalyticsReactionNeeded[], limit = 20) {
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

function buildClientHistory(rows: AnalyticsWorkflowRow[], now: number, todayTime: number, limit = 30): WholesaleAnalyticsClientHistory[] {
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

function percentChange(current: number, previous: number) {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 100);
}

async function getPeriodComparison(managerId: number | null, period: WholesaleAdminAnalyticsPeriod): Promise<WholesaleAnalyticsPeriodComparison[]> {
  const interval = periodSqlInterval(period);
  if (!interval) return [];

  const params = managerId ? [interval, managerId] : [interval];
  const managerClause = managerId ? 'and manager_id = $2' : '';
  const eventManagerClause = managerId ? 'and e.manager_id = $2' : '';

  const result = await query<{
    current_prices: string;
    previous_prices: string;
    current_views: string;
    previous_views: string;
    current_pdf: string;
    previous_pdf: string;
    current_requests: string;
    previous_requests: string;
  }>(
    `select
       (select count(*)::text from wholesale_price_lists where created_at >= now() - $1::interval ${managerClause}) as current_prices,
       (select count(*)::text from wholesale_price_lists where created_at >= now() - ($1::interval * 2) and created_at < now() - $1::interval ${managerClause}) as previous_prices,
       (select count(*)::text from wholesale_analytics_events e where e.actor_type = 'client' and e.event_type in ('public_price_opened', 'public_price_reopened') and e.created_at >= now() - $1::interval ${eventManagerClause}) as current_views,
       (select count(*)::text from wholesale_analytics_events e where e.actor_type = 'client' and e.event_type in ('public_price_opened', 'public_price_reopened') and e.created_at >= now() - ($1::interval * 2) and e.created_at < now() - $1::interval ${eventManagerClause}) as previous_views,
       (select count(*)::text from wholesale_analytics_events e where e.actor_type = 'client' and e.event_type = 'public_price_pdf_downloaded' and e.created_at >= now() - $1::interval ${eventManagerClause}) as current_pdf,
       (select count(*)::text from wholesale_analytics_events e where e.actor_type = 'client' and e.event_type = 'public_price_pdf_downloaded' and e.created_at >= now() - ($1::interval * 2) and e.created_at < now() - $1::interval ${eventManagerClause}) as previous_pdf,
       (select count(*)::text from wholesale_analytics_events e where e.actor_type = 'client' and e.event_type = 'public_price_request_sent' and e.created_at >= now() - $1::interval ${eventManagerClause}) as current_requests,
       (select count(*)::text from wholesale_analytics_events e where e.actor_type = 'client' and e.event_type = 'public_price_request_sent' and e.created_at >= now() - ($1::interval * 2) and e.created_at < now() - $1::interval ${eventManagerClause}) as previous_requests`,
    params,
  );
  const row = result.rows[0];
  const values = [
    ['Создано прайсов', Number(row?.current_prices ?? 0), Number(row?.previous_prices ?? 0)],
    ['Просмотры', Number(row?.current_views ?? 0), Number(row?.previous_views ?? 0)],
    ['PDF', Number(row?.current_pdf ?? 0), Number(row?.previous_pdf ?? 0)],
    ['Заявки', Number(row?.current_requests ?? 0), Number(row?.previous_requests ?? 0)],
  ] as const;
  return values.map(([label, current, previous]) => ({ label, current, previous, changePercent: percentChange(current, previous) }));
}

async function getProductInterest(managerId: number | null, interval: string | null): Promise<WholesaleAnalyticsProductInterest[]> {
  const params = managerId ? [interval, managerId] : [interval];
  const managerClause = managerId ? 'and e.manager_id = $2' : '';
  const result = await query<{
    product_title: string;
    product_id: string | null;
    opens: string;
    quantity_changes: string;
    requests: string;
    last_activity_at: string | null;
  }>(
    `with event_products as (
       select
         nullif(e.metadata->>'productTitle', '') as product_title,
         nullif(e.metadata->>'productId', '') as product_id,
         e.event_type,
         e.created_at
       from wholesale_analytics_events e
       where e.actor_type = 'client'
         and e.event_type in ('public_price_product_opened', 'public_price_quantity_changed')
         and ($1::text is null or e.created_at >= now() - $1::interval)
         ${managerClause}
       union all
       select
         nullif(item->>'productTitle', '') as product_title,
         null::text as product_id,
         'public_price_request_sent' as event_type,
         e.created_at
       from wholesale_analytics_events e
       cross join lateral jsonb_array_elements(
         case when jsonb_typeof(e.metadata->'items') = 'array' then e.metadata->'items' else '[]'::jsonb end
       ) item
       where e.actor_type = 'client'
         and e.event_type = 'public_price_request_sent'
         and ($1::text is null or e.created_at >= now() - $1::interval)
         ${managerClause}
     )
     select
       coalesce(product_title, 'Товар') as product_title,
       product_id,
       count(*) filter (where event_type = 'public_price_product_opened')::text as opens,
       count(*) filter (where event_type = 'public_price_quantity_changed')::text as quantity_changes,
       count(*) filter (where event_type = 'public_price_request_sent')::text as requests,
       max(created_at)::text as last_activity_at
     from event_products
     group by coalesce(product_title, 'Товар'), product_id
     order by
       (count(*) filter (where event_type = 'public_price_request_sent')) desc,
       (count(*) filter (where event_type = 'public_price_quantity_changed')) desc,
       (count(*) filter (where event_type = 'public_price_product_opened')) desc
     limit 15`,
    params,
  );

  return result.rows.map((row) => ({
    productTitle: row.product_title,
    productId: row.product_id ? Number(row.product_id) : null,
    opens: Number(row.opens),
    quantityChanges: Number(row.quantity_changes),
    requests: Number(row.requests),
    lastActivityAt: row.last_activity_at,
  }));
}

async function insertPriceListEvent(input: PriceListEventInput) {
  await query(
    `insert into wholesale_price_list_events (
       price_list_id, manager_id, owner_manager_id, action, title_snapshot, actor_role, actor_label, details
     )
     values (
       $1,
       $2,
       $3,
       $4,
       $5,
       $6,
       case
         when $6 = 'manager' then coalesce((select name from wholesale_managers where id = $2), $7)
         else $7
       end,
       $8
     )`,
    [
      input.priceListId,
      input.actorManagerId,
      input.ownerManagerId,
      input.action,
      input.title,
      input.actorRole,
      actorMeta({ role: input.actorRole as AdminSession['role'] }).actorFallback,
      input.details ?? '',
    ],
  );
  await trackAnalyticsEvent({
    eventType: actionEventType(input.action),
    actorType: actorTypeFromRole(input.actorRole),
    actorUserId: input.actorManagerId,
    managerId: input.ownerManagerId,
    priceListId: input.priceListId,
    metadata: {
      title: input.title,
      action: input.action,
      details: input.details ?? '',
    },
  });
}

function mapManager(row: ManagerRow): WholesaleManager {
  return {
    id: Number(row.id),
    name: row.name,
    login: row.login,
    email: row.email,
    phone: row.phone,
    isActive: row.is_active,
    priceListCount: Number(row.price_list_count),
    lastChangedAt: row.last_changed_at,
    lastChangedPriceTitle: row.last_changed_price_title,
  };
}

function mapPriceList(row: PriceListRow): WholesalePriceListSummary {
  return {
    id: Number(row.id),
    title: row.title,
    clientName: row.client_name,
    token: row.token,
    validUntil: row.valid_until,
    workflowStatus: normalizeWholesalePriceWorkflowStatus(row.workflow_status),
    workflowStatusLabel: getWholesalePriceWorkflowStatusLabel(row.workflow_status),
    showRetailPrices: row.show_retail_prices,
    isActive: row.is_active,
    managerId: row.manager_id ? Number(row.manager_id) : null,
    managerName: row.manager_name,
    itemCount: Number(row.item_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastChangedAt: row.last_changed_at,
    lastChangedTitle: row.last_changed_title,
    lastChangedByName: row.last_changed_by_name,
  };
}

export async function getWholesaleManagers() {
  await ensureSiteSchema();
  const result = await query<ManagerRow>(`
    select
      m.id::text,
      m.name,
      m.login,
      m.email,
      m.phone,
      m.is_active,
      count(pl.id)::text as price_list_count,
      last_event.created_at::text as last_changed_at,
      last_event.title_snapshot as last_changed_price_title
    from wholesale_managers m
    left join wholesale_price_lists pl on pl.manager_id = m.id
    left join lateral (
      select e.created_at, e.title_snapshot
      from wholesale_price_list_events e
      left join wholesale_price_lists event_price on event_price.id = e.price_list_id
      where coalesce(e.owner_manager_id, event_price.manager_id, e.manager_id) = m.id
      order by e.created_at desc, e.id desc
      limit 1
    ) last_event on true
    group by m.id, last_event.created_at, last_event.title_snapshot
    order by m.is_active desc, m.name asc, m.id asc
  `);
  return result.rows.map(mapManager);
}

export async function getWholesaleManagerByLogin(login: string): Promise<WholesaleManagerAuth | null> {
  await ensureSiteSchema();
  const result = await query<{
    id: string;
    login: string;
    email: string;
    password_hash: string;
    is_active: boolean;
    password_changed_at: string | null;
  }>(
    `select id::text, login, email, password_hash, is_active, password_changed_at::text
     from wholesale_managers
     where login = $1 or lower(email) = $1
     limit 1`,
    [normalizeLogin(login)],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    login: row.login,
    email: row.email,
    passwordHash: row.password_hash,
    isActive: row.is_active,
    passwordChangedAt: row.password_changed_at,
  };
}

export async function getWholesaleManagerById(id: number): Promise<WholesaleManagerProfile | null> {
  await ensureSiteSchema();
  const result = await query<{
    id: string;
    name: string;
    login: string;
    email: string;
    phone: string;
    is_active: boolean;
  }>(
    `select id::text, name, login, email, phone, is_active
     from wholesale_managers
     where id = $1
     limit 1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    login: row.login,
    email: row.email,
    phone: row.phone,
    isActive: row.is_active,
  };
}

export async function createWholesaleManager(input: {
  name: string;
  login: string;
  email: string;
  phone: string;
  passwordHash: string;
  isActive: boolean;
}) {
  await ensureSiteSchema();
  const result = await query<{ id: string }>(
    `insert into wholesale_managers (name, login, email, phone, password_hash, is_active, password_changed_at)
     values ($1, $2, $3, $4, $5, $6, now())
     returning id`,
    [input.name, normalizeLogin(input.login), input.email, input.phone, input.passwordHash, input.isActive],
  );
  return Number(result.rows[0].id);
}

export async function updateWholesaleManager(
  id: number,
  input: { name: string; login: string; email: string; phone: string; passwordHash?: string; isActive: boolean },
) {
  await ensureSiteSchema();
  await query(
    `update wholesale_managers
     set name = $2,
         login = $3,
         email = $4,
         phone = $5,
         password_hash = case when $6::text is null then password_hash else $6 end,
         password_changed_at = case when $6::text is null then password_changed_at else now() end,
         is_active = $7,
         updated_at = now()
     where id = $1`,
    [id, input.name, normalizeLogin(input.login), input.email, input.phone, input.passwordHash ?? null, input.isActive],
  );
}

export async function deleteWholesaleManager(id: number) {
  await ensureSiteSchema();
  await query(`delete from wholesale_managers where id = $1`, [id]);
}

export async function getWholesalePriceLists(session?: AdminSession | null) {
  await ensureSiteSchema();
  return getWholesalePriceListsByManagerId(sessionManagerId(session));
}

export async function getWholesalePriceListsForManager(managerId: number) {
  await ensureSiteSchema();
  return getWholesalePriceListsByManagerId(managerId);
}

async function getWholesalePriceListsByManagerId(managerId: number | null) {
  const result = await query<PriceListRow>(
    `select
       pl.id::text,
       pl.title,
       pl.client_name,
       pl.token,
       pl.valid_until::text,
       pl.workflow_status,
       pl.show_retail_prices,
       pl.is_active,
       pl.manager_id::text,
       m.name as manager_name,
       count(i.id)::text as item_count,
       pl.created_at::text,
       pl.updated_at::text,
       last_event.created_at::text as last_changed_at,
       last_event.title_snapshot as last_changed_title,
       last_event.actor_name as last_changed_by_name
     from wholesale_price_lists pl
     left join wholesale_managers m on m.id = pl.manager_id
     left join wholesale_price_list_items i on i.price_list_id = pl.id
     left join lateral (
       select
         e.created_at,
         e.title_snapshot,
         coalesce(
           nullif(e.actor_label, ''),
           em.name,
           case
             when e.actor_role = 'admin' then 'Администратор'
             when e.actor_role = 'wholesale_admin' then 'Администратор прайсов'
             else null
           end
         ) as actor_name
       from wholesale_price_list_events e
       left join wholesale_managers em on em.id = e.manager_id
       where e.price_list_id = pl.id
       order by e.created_at desc, e.id desc
       limit 1
     ) last_event on true
     where ($1::bigint is null or pl.manager_id = $1)
     group by pl.id, m.name, last_event.created_at, last_event.title_snapshot, last_event.actor_name
     order by pl.updated_at desc, pl.id desc`,
    [managerId],
  );
  return result.rows.map(mapPriceList);
}

export async function getWholesaleCatalog() {
  await ensureSiteSchema();
  const result = await query<{
    category_id: string | null;
    category_title: string | null;
    product_id: string;
    product_title: string;
    sku: string;
    series_description: string;
    image_url: string | null;
    price_group: string | null;
    price_eur: string | null;
    price_rub: string | null;
    price_cny: string | null;
    variant_id: string | null;
    variant_title: string | null;
    retail_price: string | null;
    wholesale_price: string | null;
  }>(`
    select
      c.id::text as category_id,
      coalesce(c.title, 'Без категории') as category_title,
      p.id::text as product_id,
      p.title as product_title,
      p.sku,
      p.series_description,
      img.image_url,
      p.price_group,
      p.price_eur::text,
      p.price_rub::text,
      p.price_cny::text,
      v.id::text as variant_id,
      v.title as variant_title,
      coalesce(v.retail_price, p.retail_price)::text as retail_price,
      coalesce(v.wholesale_price, p.wholesale_price)::text as wholesale_price
    from wholesale_products p
    left join wholesale_categories c on c.id = p.category_id
    left join wholesale_product_variants v on v.product_id = p.id and v.is_active = true
    left join lateral (
      select image_url
      from wholesale_product_images
      where product_id = p.id and is_active = true
      order by sort_order asc, id asc
      limit 1
    ) img on true
    where p.is_active = true
    order by c.sort_order asc nulls last, c.id asc nulls last, p.sort_order asc, p.id asc, v.sort_order asc nulls last, v.id asc nulls last
  `);

  const categories = new Map<number, WholesaleCatalogCategory>();
  const products = new Map<string, WholesaleCatalogProduct>();

  for (const row of result.rows) {
    const categoryId = Number(row.category_id ?? 0);
    const normalizedCategoryId = Number.isFinite(categoryId) && categoryId > 0 ? categoryId : 0;
    let category = categories.get(normalizedCategoryId);
    if (!category) {
      category = { id: normalizedCategoryId, title: row.category_title || 'Без категории', products: [] };
      categories.set(normalizedCategoryId, category);
    }

    const productId = Number(row.product_id);
    const productKey = `${normalizedCategoryId}:${productId}`;
    let product = products.get(productKey);
    if (!product) {
      product = {
        id: productId,
        title: row.product_title,
        sku: row.sku,
        description: row.series_description,
        imageUrl: row.image_url,
        priceGroup: row.price_group ?? '',
        priceEur: row.price_eur,
        priceRub: row.price_rub,
        priceCny: row.price_cny,
        variants: [],
      };
      products.set(productKey, product);
      category.products.push(product);
    }

    product.variants.push({
      id: row.variant_id ? Number(row.variant_id) : null,
      title: row.variant_title || 'Цена',
      retailPrice: row.retail_price,
      wholesalePrice: row.wholesale_price,
    });
  }

  return Array.from(categories.values());
}

export async function getWholesalePriceListEditor(id: number, session?: AdminSession | null) {
  await ensureSiteSchema();
  const managerId = sessionManagerId(session);
  const priceList = await query<Omit<WholesalePriceListEditor, 'items'> & { id: string; manager_id: string | null }>(
    `select id::text, title, client_name as "clientName", token, valid_until::text as "validUntil",
            comment, workflow_status as "workflowStatus", show_retail_prices as "showRetailPrices", is_active as "isActive", manager_id::text
     from wholesale_price_lists
     where id = $1 and ($2::bigint is null or manager_id = $2)
     limit 1`,
    [id, managerId],
  );
  const row = priceList.rows[0];
  if (!row) return null;

  const items = await query<{
    product_id: string;
    variant_id: string | null;
    custom_wholesale_price: string | null;
    visible: boolean;
    sort_order: number;
  }>(
    `select wholesale_product_id::text as product_id,
            wholesale_variant_id::text as variant_id,
            custom_wholesale_price::text,
            visible,
            sort_order
     from wholesale_price_list_items
     where price_list_id = $1
     order by sort_order asc, id asc`,
    [id],
  );

  return {
    id: Number(row.id),
    title: row.title,
    clientName: row.clientName,
    token: row.token,
    validUntil: row.validUntil,
    comment: row.comment,
    workflowStatus: normalizeWholesalePriceWorkflowStatus(row.workflowStatus),
    showRetailPrices: row.showRetailPrices,
    isActive: row.isActive,
    managerId: row.manager_id ? Number(row.manager_id) : null,
    items: items.rows.map((item) => ({
      productId: Number(item.product_id),
      variantId: item.variant_id ? Number(item.variant_id) : null,
      customWholesalePrice: item.custom_wholesale_price,
      visible: item.visible,
      sortOrder: item.sort_order,
    })),
  };
}

export async function createWholesalePriceList(
  input: Omit<WholesalePriceListEditor, 'id'>,
  session?: AdminSession | null,
) {
  await ensureSiteSchema();
  const managerId = session?.role === 'manager' ? session.managerId ?? null : input.managerId;
  const result = await query<{ id: string }>(
    `insert into wholesale_price_lists (
       title, client_name, manager_id, valid_until, token, comment, workflow_status, show_retail_prices, is_active
     )
     values ($1, $2, $3, nullif($4, '')::date, $5, $6, $7, $8, $9)
     returning id`,
    [
      input.title,
      input.clientName,
      managerId,
      input.validUntil ?? '',
      input.token,
      input.comment,
      input.workflowStatus,
      input.showRetailPrices,
      input.isActive,
    ],
  );
  const id = Number(result.rows[0].id);
  await replaceWholesalePriceListItems(id, input.items);
  const actor = actorMeta(session);
  await insertPriceListEvent({
    priceListId: id,
    ownerManagerId: managerId,
    actorManagerId: actor.actorManagerId,
    actorRole: actor.actorRole,
    title: input.title,
    action: 'create',
    details: 'Прайс создан',
  });
  await trackAnalyticsEvent({
    eventType: 'price_public_link_created',
    actorType: actorTypeFromRole(actor.actorRole),
    actorUserId: actor.actorManagerId,
    managerId,
    priceListId: id,
    token: input.token,
    metadata: {
      title: input.title,
      clientName: input.clientName,
    },
  });
  return id;
}

export async function updateWholesalePriceList(
  id: number,
  input: Omit<WholesalePriceListEditor, 'id'>,
  session?: AdminSession | null,
) {
  await ensureSiteSchema();
  const managerId = session?.role === 'manager' ? session.managerId ?? null : input.managerId;
  const previous = await query<{
    title: string;
    client_name: string;
    manager_id: string | null;
    valid_until: string | null;
    workflow_status: string | null;
    is_active: boolean;
  }>(
    `select title, client_name, manager_id::text, valid_until::text, workflow_status, is_active
     from wholesale_price_lists
     where id = $1 and ($2::bigint is null or manager_id = $2)
     limit 1`,
    [id, sessionManagerId(session)],
  );
  const previousRow = previous.rows[0];
  if (!previousRow) return;
  const previousItems = await query<{ count: string }>(
    `select count(*)::text as count
     from wholesale_price_list_items
     where price_list_id = $1 and visible = true`,
    [id],
  );
  const previousVisibleItems = Number(previousItems.rows[0]?.count ?? 0);
  const nextVisibleItems = input.items.filter((item) => item.visible).length;

  await query(
    `update wholesale_price_lists
     set title = $2,
         client_name = $3,
         manager_id = $4,
         valid_until = nullif($5, '')::date,
         token = $6,
         comment = $7,
         workflow_status = $8,
         show_retail_prices = $9,
         is_active = $10,
         updated_at = now()
     where id = $1 and ($11::bigint is null or manager_id = $11)`,
    [
      id,
      input.title,
      input.clientName,
      managerId,
      input.validUntil ?? '',
      input.token,
      input.comment,
      input.workflowStatus,
      input.showRetailPrices,
      input.isActive,
      sessionManagerId(session),
    ],
  );
  await replaceWholesalePriceListItems(id, input.items);
  const actor = actorMeta(session);
  await insertPriceListEvent({
    priceListId: id,
    ownerManagerId: managerId,
    actorManagerId: actor.actorManagerId,
    actorRole: actor.actorRole,
    title: input.title,
    action: priceListAction(previousRow, input),
    details: priceListDetails(previousRow, input),
  });
  const baseEvent = {
    actorType: actorTypeFromRole(actor.actorRole),
    actorUserId: actor.actorManagerId,
    managerId,
    priceListId: id,
    token: input.token,
  };
  if ((previousRow.client_name || '') !== input.clientName) {
    await trackAnalyticsEvent({
      ...baseEvent,
      eventType: 'price_client_changed',
      clientId: clientIdFromName(input.clientName),
      metadata: { from: previousRow.client_name, to: input.clientName, title: input.title },
    });
  }
  if ((previousRow.valid_until || '') !== (input.validUntil || '')) {
    await trackAnalyticsEvent({
      ...baseEvent,
      eventType: 'price_expiration_changed',
      metadata: { from: previousRow.valid_until, to: input.validUntil || null, title: input.title },
    });
  }
  if (normalizeWholesalePriceWorkflowStatus(previousRow.workflow_status) !== input.workflowStatus) {
    await trackAnalyticsEvent({
      ...baseEvent,
      eventType: 'price_status_changed',
      clientId: clientIdFromName(input.clientName),
      metadata: {
        from: getWholesalePriceWorkflowStatusLabel(previousRow.workflow_status),
        to: getWholesalePriceWorkflowStatusLabel(input.workflowStatus),
        title: input.title,
        clientName: input.clientName,
      },
    });
  }
  if (nextVisibleItems > previousVisibleItems) {
    await trackAnalyticsEvent({
      ...baseEvent,
      eventType: 'price_items_added',
      metadata: {
        added: nextVisibleItems - previousVisibleItems,
        from: previousVisibleItems,
        to: nextVisibleItems,
        title: input.title,
      },
    });
  }
  if (nextVisibleItems < previousVisibleItems) {
    await trackAnalyticsEvent({
      ...baseEvent,
      eventType: 'price_items_removed',
      metadata: {
        removed: previousVisibleItems - nextVisibleItems,
        from: previousVisibleItems,
        to: nextVisibleItems,
        title: input.title,
      },
    });
  }
}

export async function deleteWholesalePriceList(id: number, session?: AdminSession | null) {
  await ensureSiteSchema();
  const previous = await query<{
    title: string;
    manager_id: string | null;
  }>(
    `select title, manager_id::text
     from wholesale_price_lists
     where id = $1 and ($2::bigint is null or manager_id = $2)
     limit 1`,
    [id, sessionManagerId(session)],
  );
  const previousRow = previous.rows[0];
  if (!previousRow) return;

  const actor = actorMeta(session);
  await insertPriceListEvent({
    priceListId: id,
    ownerManagerId: previousRow.manager_id ? Number(previousRow.manager_id) : null,
    actorManagerId: actor.actorManagerId,
    actorRole: actor.actorRole,
    title: previousRow.title,
    action: 'delete',
    details: 'Прайс удалён',
  });

  await query(`delete from wholesale_price_lists where id = $1 and ($2::bigint is null or manager_id = $2)`, [
    id,
    sessionManagerId(session),
  ]);
}

export async function recordWholesaleManagerLogin(
  managerId: number,
  input: { ip?: string | null; userAgent?: string | null; referer?: string | null; actorType?: 'admin' | 'manager' },
) {
  await ensureSiteSchema();
  await query(
    `insert into wholesale_manager_login_logs (manager_id, ip, user_agent)
     values ($1, $2, $3)`,
    [managerId, input.ip ?? '', input.userAgent ?? ''],
  );
  await trackAnalyticsEvent({
    eventType: 'manager_login',
    actorType: input.actorType ?? 'manager',
    actorUserId: managerId,
    managerId,
    ip: input.ip,
    userAgent: input.userAgent,
    referer: input.referer,
  });
}

export async function recordWholesalePriceView(
  priceListId: number,
  token: string,
  input: {
    ip?: string | null;
    userAgent?: string | null;
    referer?: string | null;
    sessionId?: string | null;
    actorType?: 'admin' | 'manager' | 'client';
    actorUserId?: number | null;
    managerId?: number | null;
    clientName?: string | null;
    reopened?: boolean;
  },
) {
  await ensureSiteSchema();
  await query(
    `insert into wholesale_price_view_logs (price_list_id, token, ip, user_agent, referer)
     values ($1, $2, $3, $4, $5)`,
    [priceListId, token, input.ip ?? '', input.userAgent ?? '', input.referer ?? ''],
  );
  await trackAnalyticsEvent({
    eventType: input.reopened ? 'public_price_reopened' : 'public_price_opened',
    actorType: input.actorType ?? 'client',
    actorUserId: input.actorUserId,
    managerId: input.managerId,
    clientId: clientIdFromName(input.clientName),
    priceListId,
    token,
    sessionId: input.sessionId,
    ip: input.ip,
    userAgent: input.userAgent,
    referer: input.referer,
    metadata: {
      clientName: input.clientName ?? '',
    },
  });
}

export async function getWholesaleManagerAnalytics(
  managerId: number,
  period: WholesaleManagerAnalyticsPeriod = '30d',
): Promise<WholesaleManagerAnalytics | null> {
  await ensureSiteSchema();
  const interval = periodSqlInterval(period);

  const managerResult = await query<{
    id: string;
    name: string;
    login: string;
    email: string;
    phone: string;
    last_login_at: string | null;
  }>(
    `select
       m.id::text,
       m.name,
       m.login,
       m.email,
       m.phone,
       last_login.created_at::text as last_login_at
     from wholesale_managers m
     left join lateral (
       select created_at
       from wholesale_manager_login_logs
       where manager_id = m.id
       order by created_at desc, id desc
       limit 1
     ) last_login on true
     where m.id = $1
     limit 1`,
    [managerId],
  );
  const managerRow = managerResult.rows[0];
  if (!managerRow) return null;

  const summaryResult = await query<AnalyticsSummaryRow>(
    `with manager_prices as (
       select
         pl.id,
         pl.client_name,
         pl.valid_until,
         pl.is_active,
         pl.created_at,
         count(i.id)::integer as item_count
       from wholesale_price_lists pl
       left join wholesale_price_list_items i on i.price_list_id = pl.id
       where pl.manager_id = $1
       group by pl.id
     )
     select
       count(*)::text as total_prices,
       count(*) filter (where is_active)::text as active_prices,
       count(*) filter (where valid_until is not null and valid_until < current_date)::text as expired_prices,
       count(*) filter (where created_at >= now() - interval '7 days')::text as prices_last_7_days,
       count(*) filter (where created_at >= now() - interval '30 days')::text as prices_last_30_days,
       count(*) filter (where ($2::text is null or created_at >= now() - $2::interval))::text as period_prices,
       coalesce(round(avg(item_count)::numeric, 1), 0)::text as average_items_per_price,
       count(*) filter (where item_count = 0)::text as empty_prices,
       count(*) filter (where btrim(client_name) = '')::text as prices_without_client,
       count(*) filter (where valid_until is null)::text as prices_without_expiration
     from manager_prices`,
    [managerId, interval],
  );
  const summaryRow = summaryResult.rows[0];

  const lastCreatedResult = await query<{
    id: string;
    title: string;
    created_at: string;
  }>(
    `select id::text, title, created_at::text
     from wholesale_price_lists
     where manager_id = $1
     order by created_at desc, id desc
     limit 1`,
    [managerId],
  );

  const recentChangesResult = await query<AnalyticsChangeRow>(
    `select
       e.id::text,
       e.price_list_id::text as price_id,
       coalesce(nullif(e.title_snapshot, ''), pl.title, 'Без названия') as price_title,
       e.action,
       coalesce(
         nullif(e.actor_label, ''),
         actor.name,
         case
           when e.actor_role = 'admin' then 'Администратор'
           when e.actor_role = 'wholesale_admin' then 'Администратор прайсов'
           when e.actor_role = 'manager' then 'Менеджер'
           else 'Не указано'
         end
       ) as changed_by,
       e.created_at::text,
       e.details
     from wholesale_price_list_events e
     left join wholesale_price_lists pl on pl.id = e.price_list_id
     left join wholesale_managers actor on actor.id = e.manager_id
     where coalesce(e.owner_manager_id, pl.manager_id, e.manager_id) = $1
       and ($2::text is null or e.created_at >= now() - $2::interval)
     order by e.created_at desc, e.id desc
     limit 12`,
    [managerId, interval],
  );

  const lastChangeResult = await query<AnalyticsChangeRow>(
    `select
       e.id::text,
       e.price_list_id::text as price_id,
       coalesce(nullif(e.title_snapshot, ''), pl.title, 'Без названия') as price_title,
       e.action,
       coalesce(
         nullif(e.actor_label, ''),
         actor.name,
         case
           when e.actor_role = 'admin' then 'Администратор'
           when e.actor_role = 'wholesale_admin' then 'Администратор прайсов'
           when e.actor_role = 'manager' then 'Менеджер'
           else 'Не указано'
         end
       ) as changed_by,
       e.created_at::text,
       e.details
     from wholesale_price_list_events e
     left join wholesale_price_lists pl on pl.id = e.price_list_id
     left join wholesale_managers actor on actor.id = e.manager_id
     where coalesce(e.owner_manager_id, pl.manager_id, e.manager_id) = $1
     order by e.created_at desc, e.id desc
     limit 1`,
    [managerId],
  );

  const problemResult = await query<AnalyticsProblemRow>(
    `with manager_prices as (
       select
         pl.id,
         pl.title,
         pl.client_name,
         pl.valid_until::text as valid_until,
         pl.valid_until as valid_until_date,
         pl.created_at::text,
         count(i.id)::text as item_count
       from wholesale_price_lists pl
       left join wholesale_price_list_items i on i.price_list_id = pl.id
       where pl.manager_id = $1
       group by pl.id
     )
     select id::text, title, client_name, valid_until::text, created_at, item_count
     from manager_prices
     where item_count::integer = 0
        or btrim(client_name) = ''
        or valid_until_date is null
        or valid_until_date < current_date
     order by
       case when valid_until_date is not null and valid_until_date < current_date then 0 else 1 end,
       created_at desc,
       id desc
     limit 50`,
    [managerId],
  );

  const publicViewsResult = await query<{
    total: string;
    last_7_days: string;
    last_30_days: string;
    period_views: string;
    last_view_at: string | null;
  }>(
    `select
       count(v.id)::text as total,
       count(v.id) filter (where v.created_at >= now() - interval '7 days')::text as last_7_days,
       count(v.id) filter (where v.created_at >= now() - interval '30 days')::text as last_30_days,
       count(v.id) filter (where ($2::text is null or v.created_at >= now() - $2::interval))::text as period_views,
       max(v.created_at)::text as last_view_at
     from wholesale_price_lists pl
     left join wholesale_price_view_logs v on v.price_list_id = pl.id
     where pl.manager_id = $1`,
    [managerId, interval],
  );

  const topViewsResult = await query<{
    price_id: string;
    title: string;
    views: string;
    last_view_at: string | null;
  }>(
    `select
       pl.id::text as price_id,
       coalesce(nullif(pl.title, ''), 'Без названия') as title,
       count(v.id)::text as views,
       max(v.created_at)::text as last_view_at
     from wholesale_price_lists pl
     join wholesale_price_view_logs v on v.price_list_id = pl.id
     where pl.manager_id = $1
       and ($2::text is null or v.created_at >= now() - $2::interval)
     group by pl.id
     order by count(v.id) desc, max(v.created_at) desc
     limit 5`,
    [managerId, interval],
  );

  const lastCreatedRow = lastCreatedResult.rows[0];
  const publicViewsRow = publicViewsResult.rows[0];

  return {
    manager: {
      id: Number(managerRow.id),
      name: managerRow.name,
      login: managerRow.login,
      email: managerRow.email,
      role: 'Менеджер',
      phone: managerRow.phone,
      lastLoginAt: managerRow.last_login_at,
    },
    summary: {
      totalPrices: Number(summaryRow?.total_prices ?? 0),
      activePrices: Number(summaryRow?.active_prices ?? 0),
      expiredPrices: Number(summaryRow?.expired_prices ?? 0),
      pricesLast7Days: Number(summaryRow?.prices_last_7_days ?? 0),
      pricesLast30Days: Number(summaryRow?.prices_last_30_days ?? 0),
      periodPrices: Number(summaryRow?.period_prices ?? 0),
      averageItemsPerPrice: Number(summaryRow?.average_items_per_price ?? 0),
      emptyPrices: Number(summaryRow?.empty_prices ?? 0),
      pricesWithoutClient: Number(summaryRow?.prices_without_client ?? 0),
      pricesWithoutExpiration: Number(summaryRow?.prices_without_expiration ?? 0),
    },
    lastCreatedPrice: lastCreatedRow
      ? {
          id: Number(lastCreatedRow.id),
          title: lastCreatedRow.title || 'Без названия',
          createdAt: lastCreatedRow.created_at,
        }
      : null,
    lastChange: lastChangeResult.rows[0] ? mapAnalyticsChange(lastChangeResult.rows[0]) : null,
    problemPrices: problemResult.rows.map(mapProblemPrice).filter((price) => price.problems.length > 0),
    recentChanges: recentChangesResult.rows.map(mapAnalyticsChange),
    publicViews: {
      total: Number(publicViewsRow?.total ?? 0),
      last7Days: Number(publicViewsRow?.last_7_days ?? 0),
      last30Days: Number(publicViewsRow?.last_30_days ?? 0),
      periodViews: Number(publicViewsRow?.period_views ?? 0),
      lastViewAt: publicViewsRow?.last_view_at ?? null,
      topPrices: topViewsResult.rows.map((row) => ({
        priceId: Number(row.price_id),
        title: row.title,
        views: Number(row.views),
        lastViewAt: row.last_view_at,
      })),
    },
  };
}

export async function getWholesaleManagerAnalyticsExtended(
  managerId: number,
  period: WholesaleManagerAnalyticsPeriod = '30d',
): Promise<WholesaleManagerAnalytics | null> {
  const base = await getWholesaleManagerAnalytics(managerId, period);
  if (!base) return null;

  const interval = periodSqlInterval(period);
  const priceStats = await query<{
    id: string;
    title: string;
    client_name: string;
    token: string;
    valid_until: string | null;
    workflow_status: string | null;
    is_active: boolean;
    created_at: string;
    updated_at: string;
    item_count: string;
    views: string;
    views_last_7_days: string;
    views_last_30_days: string;
    views_period: string;
    last_view_at: string | null;
    unique_visitors: string;
    repeat_views: string;
    pdf_downloads: string;
    pdf_last_7_days: string;
    pdf_last_30_days: string;
    pdf_period: string;
    unique_downloaders: string;
    last_pdf_at: string | null;
    excel_downloads: string;
    excel_last_7_days: string;
    excel_last_30_days: string;
    excel_period: string;
    unique_excel_downloaders: string;
    last_excel_at: string | null;
    requests_sent: string;
    requests_period: string;
    last_request_at: string | null;
    first_view_at: string | null;
    first_pdf_at: string | null;
    first_request_at: string | null;
    last_manager_activity_at: string | null;
    last_client_event_type: string | null;
    change_count: string;
    last_changed_at: string | null;
    last_changed_by: string | null;
  }>(
    `select
       pl.id::text,
       coalesce(nullif(pl.title, ''), 'Без названия') as title,
       pl.client_name,
       pl.token,
       pl.valid_until::text,
       pl.workflow_status,
       pl.is_active,
       pl.created_at::text,
       pl.updated_at::text,
       coalesce(items.item_count, 0)::text as item_count,
       coalesce(views.views, 0)::text as views,
       coalesce(views.views_last_7_days, 0)::text as views_last_7_days,
       coalesce(views.views_last_30_days, 0)::text as views_last_30_days,
       coalesce(views.views_period, 0)::text as views_period,
       views.last_view_at::text,
       coalesce(view_events.unique_visitors, 0)::text as unique_visitors,
       coalesce(view_events.repeat_views, 0)::text as repeat_views,
       coalesce(pdf.pdf_downloads, 0)::text as pdf_downloads,
       coalesce(pdf.pdf_last_7_days, 0)::text as pdf_last_7_days,
       coalesce(pdf.pdf_last_30_days, 0)::text as pdf_last_30_days,
       coalesce(pdf.pdf_period, 0)::text as pdf_period,
       coalesce(pdf.unique_downloaders, 0)::text as unique_downloaders,
       pdf.last_pdf_at::text,
       coalesce(excel.excel_downloads, 0)::text as excel_downloads,
       coalesce(excel.excel_last_7_days, 0)::text as excel_last_7_days,
       coalesce(excel.excel_last_30_days, 0)::text as excel_last_30_days,
       coalesce(excel.excel_period, 0)::text as excel_period,
       coalesce(excel.unique_downloaders, 0)::text as unique_excel_downloaders,
       excel.last_excel_at::text,
       coalesce(requests.requests_sent, 0)::text as requests_sent,
       coalesce(requests.requests_period, 0)::text as requests_period,
       requests.last_request_at::text,
       views.first_view_at::text,
       pdf.first_pdf_at::text,
       requests.first_request_at::text,
       manager_actions.last_manager_activity_at::text,
       client_activity.last_client_event_type,
       coalesce(changes.change_count, 0)::text as change_count,
       changes.last_changed_at::text,
       changes.last_changed_by
     from wholesale_price_lists pl
     left join lateral (
       select count(*)::integer as item_count
       from wholesale_price_list_items i
       where i.price_list_id = pl.id and i.visible = true
     ) items on true
     left join lateral (
       select
         count(*)::integer as views,
         count(*) filter (where created_at >= now() - interval '7 days')::integer as views_last_7_days,
         count(*) filter (where created_at >= now() - interval '30 days')::integer as views_last_30_days,
         count(*) filter (where ($2::text is null or created_at >= now() - $2::interval))::integer as views_period,
         max(created_at) as last_view_at,
         min(created_at) as first_view_at
       from wholesale_price_view_logs v
       where v.price_list_id = pl.id
     ) views on true
     left join lateral (
       select
         count(distinct nullif(session_id, ''))::integer as unique_visitors,
         count(*) filter (where event_type = 'public_price_reopened')::integer as repeat_views
       from wholesale_analytics_events e
       where e.price_list_id = pl.id
         and e.actor_type = 'client'
         and e.event_type in ('public_price_opened', 'public_price_reopened')
         and ($2::text is null or e.created_at >= now() - $2::interval)
     ) view_events on true
     left join lateral (
       select
         count(*)::integer as pdf_downloads,
         count(*) filter (where created_at >= now() - interval '7 days')::integer as pdf_last_7_days,
         count(*) filter (where created_at >= now() - interval '30 days')::integer as pdf_last_30_days,
         count(*) filter (where ($2::text is null or created_at >= now() - $2::interval))::integer as pdf_period,
         count(distinct nullif(session_id, ''))::integer as unique_downloaders,
         max(created_at) as last_pdf_at,
         min(created_at) as first_pdf_at
       from wholesale_analytics_events e
       where e.price_list_id = pl.id
         and e.actor_type = 'client'
         and e.event_type = 'public_price_pdf_downloaded'
     ) pdf on true
     left join lateral (
       select
         count(*)::integer as excel_downloads,
         count(*) filter (where created_at >= now() - interval '7 days')::integer as excel_last_7_days,
         count(*) filter (where created_at >= now() - interval '30 days')::integer as excel_last_30_days,
         count(*) filter (where ($2::text is null or created_at >= now() - $2::interval))::integer as excel_period,
         count(distinct nullif(session_id, ''))::integer as unique_downloaders,
         max(created_at) as last_excel_at
       from wholesale_analytics_events e
       where e.price_list_id = pl.id
         and e.actor_type = 'client'
         and e.event_type = 'public_price_excel_downloaded'
     ) excel on true
     left join lateral (
       select
         count(*)::integer as requests_sent,
         count(*) filter (where ($2::text is null or created_at >= now() - $2::interval))::integer as requests_period,
         max(created_at) as last_request_at,
         min(created_at) as first_request_at
       from wholesale_analytics_events e
       where e.price_list_id = pl.id
         and e.actor_type = 'client'
         and e.event_type = 'public_price_request_sent'
     ) requests on true
     left join lateral (
       select max(e.created_at) as last_manager_activity_at
       from wholesale_analytics_events e
       where e.price_list_id = pl.id
         and e.actor_type in ('admin', 'manager')
         and e.event_type in (
           'price_updated',
           'price_status_changed',
           'price_client_changed',
           'price_expiration_changed',
           'price_items_added',
           'price_items_removed',
           'price_activated',
           'price_deactivated'
         )
     ) manager_actions on true
     left join lateral (
       select e.event_type as last_client_event_type
       from wholesale_analytics_events e
       where e.price_list_id = pl.id
         and e.actor_type = 'client'
         and e.event_type in (
           'public_price_opened',
           'public_price_reopened',
           'public_price_pdf_downloaded',
           'public_price_excel_downloaded',
           'public_price_request_sent',
           'public_price_phone_clicked',
           'public_price_email_clicked',
           'public_price_request_abandoned'
         )
       order by e.created_at desc, e.id desc
       limit 1
     ) client_activity on true
     left join lateral (
       select
         count(*)::integer as change_count,
         max(e.created_at) as last_changed_at,
         (array_agg(coalesce(nullif(e.actor_label, ''), actor.name, e.actor_role) order by e.created_at desc, e.id desc))[1] as last_changed_by
       from wholesale_price_list_events e
       left join wholesale_managers actor on actor.id = e.manager_id
       where e.price_list_id = pl.id
     ) changes on true
     where pl.manager_id = $1
     order by pl.updated_at desc, pl.id desc`,
    [managerId, interval],
  );

  const rows = priceStats.rows;
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayTime = today.getTime();
  const validTime = (value: string | null) => (value ? new Date(`${value}T00:00:00`).getTime() : null);
  const itemCounts = rows.map((row) => Number(row.item_count)).sort((a, b) => a - b);
  const medianItemsPerPrice =
    itemCounts.length === 0
      ? 0
      : itemCounts.length % 2
        ? itemCounts[Math.floor(itemCounts.length / 2)]
        : (itemCounts[itemCounts.length / 2 - 1] + itemCounts[itemCounts.length / 2]) / 2;
  const expiredPrices = rows.filter((row) => {
    const value = validTime(row.valid_until);
    return value !== null && value < todayTime;
  }).length;
  const expiringSoon7Days = rows.filter((row) => {
    const value = validTime(row.valid_until);
    return value !== null && value >= todayTime && value <= todayTime + 7 * day;
  }).length;
  const expiringSoon30Days = rows.filter((row) => {
    const value = validTime(row.valid_until);
    return value !== null && value >= todayTime && value <= todayTime + 30 * day;
  }).length;
  const stalePrices30Days = rows.filter((row) => new Date(row.updated_at).getTime() < now - 30 * day).length;
  const pricesWithoutViews = rows.filter((row) => Number(row.views) === 0).length;
  const pricesWithoutPdfDownloads = rows.filter((row) => Number(row.pdf_downloads) === 0).length;
  const extendedProblems = rows
    .map((row) =>
      mapProblemPrice({
        id: row.id,
        title: row.title,
        client_name: row.client_name,
        valid_until: row.valid_until,
        created_at: row.created_at,
        updated_at: row.updated_at,
        item_count: row.item_count,
        views: row.views,
        pdf_downloads: row.pdf_downloads,
      }),
    )
    .filter((price) => price.problems.length > 0);

  const activity = await query<{
    logins_last_7_days: string;
    logins_last_30_days: string;
    logins_period: string;
    active_days_period: string;
    actions_last_7_days: string;
    actions_last_30_days: string;
    actions_period: string;
    created_prices: string;
    updated_prices: string;
    activated_prices: string;
    deactivated_prices: string;
    deleted_prices: string;
  }>(
    `select
       count(*) filter (where event_type = 'manager_login' and created_at >= now() - interval '7 days')::text as logins_last_7_days,
       count(*) filter (where event_type = 'manager_login' and created_at >= now() - interval '30 days')::text as logins_last_30_days,
       count(*) filter (where event_type = 'manager_login' and ($2::text is null or created_at >= now() - $2::interval))::text as logins_period,
       count(distinct created_at::date) filter (where $2::text is null or created_at >= now() - $2::interval)::text as active_days_period,
       count(*) filter (where event_type <> 'manager_login' and created_at >= now() - interval '7 days')::text as actions_last_7_days,
       count(*) filter (where event_type <> 'manager_login' and created_at >= now() - interval '30 days')::text as actions_last_30_days,
       count(*) filter (where event_type <> 'manager_login' and ($2::text is null or created_at >= now() - $2::interval))::text as actions_period,
       count(*) filter (where event_type = 'price_created')::text as created_prices,
       count(*) filter (where event_type = 'price_updated')::text as updated_prices,
       count(*) filter (where event_type = 'price_activated')::text as activated_prices,
       count(*) filter (where event_type = 'price_deactivated')::text as deactivated_prices,
       count(*) filter (where event_type = 'price_deleted')::text as deleted_prices
     from wholesale_analytics_events
     where manager_id = $1
       and actor_type in ('admin', 'manager')`,
    [managerId, interval],
  );

  const recentEventsResult = await query<AnalyticsEventRow>(
    `select
       e.id::text,
       e.event_type,
       e.actor_type,
       e.price_list_id::text as price_id,
       coalesce(nullif(pl.title, ''), e.metadata->>'title', 'Без названия') as price_title,
       e.client_id,
       coalesce(nullif(pl.client_name, ''), e.metadata->>'clientName', '') as client_name,
       coalesce(m.name, '') as manager_name,
       e.created_at::text,
       coalesce(nullif(e.metadata->>'details', ''), e.metadata::text) as details,
       e.session_id,
       e.referer
     from wholesale_analytics_events e
     left join wholesale_price_lists pl on pl.id = e.price_list_id
     left join wholesale_managers m on m.id = e.manager_id
     where e.manager_id = $1
       and ($2::text is null or e.created_at >= now() - $2::interval)
     order by e.created_at desc, e.id desc
     limit 50`,
    [managerId, interval],
  );
  const recentEvents = recentEventsResult.rows.map(mapAnalyticsEvent);
  const recentViews = recentEvents.filter((event) => ['public_price_opened', 'public_price_reopened'].includes(event.eventType));
  const recentDownloads = recentEvents.filter((event) => event.eventType === 'public_price_pdf_downloaded');
  const lastAction = recentEvents.find((event) => event.actorType === 'admin' || event.actorType === 'manager') ?? null;

  const topViewed = [...rows].filter((row) => Number(row.views) > 0).sort((a, b) => Number(b.views) - Number(a.views));
  const topDownloaded = [...rows]
    .filter((row) => Number(row.pdf_downloads) > 0)
    .sort((a, b) => Number(b.pdf_downloads) - Number(a.pdf_downloads));
  const mostChanged = [...rows].filter((row) => Number(row.change_count) > 0).sort((a, b) => Number(b.change_count) - Number(a.change_count));

  const clientMap = new Map<string, WholesaleManagerAnalyticsClient>();
  for (const row of rows) {
    const clientName = row.client_name.trim();
    if (!clientName) continue;
    const key = clientName.toLowerCase();
    const current =
      clientMap.get(key) ??
      ({
        clientId: key,
        clientName,
        priceId: Number(row.id),
        priceTitle: row.title,
        priceCount: 0,
        viewsLast24Hours: 0,
        viewsLast7Days: 0,
        views: 0,
        uniqueVisitors: 0,
        pdfDownloads: 0,
        lastActivityAt: null,
        lastPriceCreatedAt: null,
        status: 'Не открывал',
      } satisfies WholesaleManagerAnalyticsClient);
    current.priceCount += 1;
    current.views += Number(row.views);
    current.viewsLast7Days += Number(row.views_last_7_days);
    current.uniqueVisitors += Number(row.unique_visitors);
    current.pdfDownloads += Number(row.pdf_downloads);
    const lastActivity = [row.last_view_at, row.last_pdf_at].filter(Boolean).sort().at(-1) ?? null;
    if (lastActivity && (!current.lastActivityAt || lastActivity > current.lastActivityAt)) {
      current.lastActivityAt = lastActivity;
      current.priceId = Number(row.id);
      current.priceTitle = row.title;
    }
    if (!current.lastPriceCreatedAt || row.created_at > current.lastPriceCreatedAt) current.lastPriceCreatedAt = row.created_at;
    clientMap.set(key, current);
  }

  const views24 = await query<{ client_id: string; views: string }>(
    `select coalesce(nullif(e.client_id, ''), lower(pl.client_name)) as client_id, count(*)::text as views
     from wholesale_analytics_events e
     left join wholesale_price_lists pl on pl.id = e.price_list_id
     where e.manager_id = $1
       and e.actor_type = 'client'
       and e.event_type in ('public_price_opened', 'public_price_reopened')
       and e.created_at >= now() - interval '24 hours'
     group by coalesce(nullif(e.client_id, ''), lower(pl.client_name))`,
    [managerId],
  );
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
  const [productInterest, comparison] = await Promise.all([
    getProductInterest(managerId, interval),
    getPeriodComparison(managerId, period),
  ]);
  const clients = Array.from(clientMap.values()).map((client) => {
    let status = 'Не открывал';
    if (client.views > 0) status = 'Смотрел';
    if (client.pdfDownloads > 0) status = 'Скачал PDF';
    if (client.viewsLast24Hours >= 2 || client.viewsLast7Days >= 3 || client.pdfDownloads > 0) status = 'Горячий';
    return { ...client, status };
  });

  const totalViews = rows.reduce((sum, row) => sum + Number(row.views), 0);
  const totalPdf = rows.reduce((sum, row) => sum + Number(row.pdf_downloads), 0);
  const activityRow = activity.rows[0];
  const quality = qualityScore({
    emptyPrices: base.summary.emptyPrices,
    pricesWithoutClient: base.summary.pricesWithoutClient,
    pricesWithoutExpiration: base.summary.pricesWithoutExpiration,
    expiredPrices,
    pricesWithoutViews,
    stalePrices30Days,
  });

  return {
    ...base,
    summary: {
      ...base.summary,
      expiredPrices,
      expiringSoon7Days,
      expiringSoon30Days,
      medianItemsPerPrice: Number(medianItemsPerPrice.toFixed(1)),
      stalePrices30Days,
      pricesWithoutViews,
      qualityScore: quality,
      disabledPrices: rows.length - rows.filter((row) => row.is_active).length,
      pricesWithoutPdfDownloads,
    },
    managerActivity: {
      loginsLast7Days: Number(activityRow?.logins_last_7_days ?? 0),
      loginsLast30Days: Number(activityRow?.logins_last_30_days ?? 0),
      loginsInSelectedPeriod: Number(activityRow?.logins_period ?? 0),
      activeDaysInSelectedPeriod: Number(activityRow?.active_days_period ?? 0),
      actionsLast7Days: Number(activityRow?.actions_last_7_days ?? 0),
      actionsLast30Days: Number(activityRow?.actions_last_30_days ?? 0),
      actionsInSelectedPeriod: Number(activityRow?.actions_period ?? 0),
      lastAction: lastAction ? { eventType: lastAction.eventType, priceTitle: lastAction.priceTitle, clientName: lastAction.clientName, createdAt: lastAction.createdAt } : null,
      createdPrices: Number(activityRow?.created_prices ?? 0),
      updatedPrices: Number(activityRow?.updated_prices ?? 0),
      activatedPrices: Number(activityRow?.activated_prices ?? 0),
      deactivatedPrices: Number(activityRow?.deactivated_prices ?? 0),
      deletedPrices: Number(activityRow?.deleted_prices ?? 0),
    },
    problemPrices: extendedProblems,
    publicViews: {
      ...base.publicViews,
      total: totalViews,
      uniqueVisitors: rows.reduce((sum, row) => sum + Number(row.unique_visitors), 0),
      last7Days: rows.reduce((sum, row) => sum + Number(row.views_last_7_days), 0),
      last30Days: rows.reduce((sum, row) => sum + Number(row.views_last_30_days), 0),
      periodViews: rows.reduce((sum, row) => sum + Number(row.views_period), 0),
      repeatViews: rows.reduce((sum, row) => sum + Number(row.repeat_views), 0),
      lastViewAt: rows.map((row) => row.last_view_at).filter(Boolean).sort().at(-1) ?? null,
      pricesWithoutViews,
      averageViewsPerPrice: rows.length ? Number((totalViews / rows.length).toFixed(1)) : 0,
      topPrices: topViewed.slice(0, 5).map((row) => ({
        priceId: Number(row.id),
        title: row.title,
        clientName: row.client_name,
        views: Number(row.views),
        uniqueVisitors: Number(row.unique_visitors),
        lastViewAt: row.last_view_at,
      })),
      recentViews,
      pricesWithoutViewsList: extendedProblems.filter((price) => price.problems.includes('NO_VIEWS')),
    },
    pdf: {
      totalDownloads: totalPdf,
      downloadsLast7Days: rows.reduce((sum, row) => sum + Number(row.pdf_last_7_days), 0),
      downloadsLast30Days: rows.reduce((sum, row) => sum + Number(row.pdf_last_30_days), 0),
      downloadsInSelectedPeriod: rows.reduce((sum, row) => sum + Number(row.pdf_period), 0),
      uniqueDownloaders: rows.reduce((sum, row) => sum + Number(row.unique_downloaders), 0),
      lastDownloadAt: rows.map((row) => row.last_pdf_at).filter(Boolean).sort().at(-1) ?? null,
      pricesWithDownloads: rows.filter((row) => Number(row.pdf_downloads) > 0).length,
      pricesWithoutDownloads: pricesWithoutPdfDownloads,
      topDownloadedPrices: topDownloaded.slice(0, 5).map((row) => ({
        priceId: Number(row.id),
        title: row.title,
        clientName: row.client_name,
        downloads: Number(row.pdf_downloads),
        uniqueDownloaders: Number(row.unique_downloaders),
        views: Number(row.views),
        lastDownloadAt: row.last_pdf_at,
      })),
      recentDownloads,
      clientsWithPdfDownloads: clients
        .filter((client) => client.pdfDownloads > 0 && client.priceId)
        .slice(0, 10)
        .map((client) => ({
          clientId: client.clientId,
          clientName: client.clientName,
          priceId: client.priceId ?? 0,
          priceTitle: client.priceTitle,
          downloads: client.pdfDownloads,
          lastDownloadAt: client.lastActivityAt,
        })),
    },
    clients: {
      totalClients: clients.length,
      clientsWithPrices: clients.length,
      clientsWithViews: clients.filter((client) => client.views > 0).length,
      clientsWithoutViews: clients.filter((client) => client.views === 0).length,
      clientsWithPdfDownloads: clients.filter((client) => client.pdfDownloads > 0).length,
      hotClients: clients.filter((client) => client.status === 'Горячий').slice(0, 10),
      topClientsByViews: [...clients].sort((a, b) => b.views - a.views).slice(0, 10),
      clientsWithoutRecentActivity: clients.filter((client) => client.views === 0).slice(0, 20),
    },
    funnel: {
      createdPrices: rows.length,
      activePublicLinks: rows.filter((row) => row.is_active).length,
      openedPrices: rows.filter((row) => Number(row.views) > 0).length,
      pricesWithRepeatViews: rows.filter((row) => Number(row.repeat_views) > 0).length,
      pdfDownloadedPrices: rows.filter((row) => Number(row.pdf_downloads) > 0).length,
      requestsSent: rows.filter((row) => Number(row.requests_sent) > 0).length,
      contactClicks: recentEvents.filter((event) => ['public_price_phone_clicked', 'public_price_email_clicked'].includes(event.eventType)).length,
    },
    attention: {
      statusFunnel,
      stuckPrices,
      managerReactionNeeded,
      priorityClients,
      clientHistory,
      productInterest,
      comparison,
    },
    priceInsights: {
      expiringSoon: extendedProblems.filter((price) => price.problems.includes('EXPIRING_SOON')),
      pricesWithoutViews: extendedProblems.filter((price) => price.problems.includes('NO_VIEWS')),
      topViewedPrices: topViewed.slice(0, 10).map((row) => ({
        priceId: Number(row.id),
        title: row.title,
        clientName: row.client_name,
        views: Number(row.views),
        uniqueVisitors: Number(row.unique_visitors),
        pdfDownloads: Number(row.pdf_downloads),
        lastViewAt: row.last_view_at,
      })),
      mostChangedPrices: mostChanged.slice(0, 10).map((row) => ({
        priceId: Number(row.id),
        title: row.title,
        clientName: row.client_name,
        changes: Number(row.change_count),
        lastChangedAt: row.last_changed_at,
        lastChangedBy: row.last_changed_by || 'Не указано',
      })),
      largestPrice: rows.length
        ? [...rows].sort((a, b) => Number(b.item_count) - Number(a.item_count)).map((row) => ({ id: Number(row.id), title: row.title, itemCount: Number(row.item_count) }))[0]
        : null,
      smallestNonEmptyPrice:
        rows.filter((row) => Number(row.item_count) > 0).length > 0
          ? [...rows]
              .filter((row) => Number(row.item_count) > 0)
              .sort((a, b) => Number(a.item_count) - Number(b.item_count))
              .map((row) => ({ id: Number(row.id), title: row.title, itemCount: Number(row.item_count) }))[0]
          : null,
    },
    recentEvents,
  };
}

export async function getWholesaleAdminAnalytics(period: WholesaleAdminAnalyticsPeriod = '30d'): Promise<WholesaleAdminAnalytics> {
  await ensureSiteSchema();

  const interval = periodSqlInterval(period);
  const managerActionEvents = [
    'price_created',
    'price_updated',
    'price_deleted',
    'price_activated',
    'price_deactivated',
    'price_client_changed',
    'price_expiration_changed',
    'price_items_added',
    'price_items_removed',
    'price_status_changed',
    'price_public_link_created',
    'price_public_link_copied',
  ];
  const trackedManagerEvents = [...managerActionEvents, 'manager_login'];

  type AdminManagerRow = {
    id: string;
    name: string;
    login: string;
    email: string;
    phone: string;
    is_active: boolean;
    last_login_at: string | null;
  };

  type AdminPriceRow = {
    id: string;
    title: string;
    client_name: string;
    valid_until: string | null;
    workflow_status: string | null;
    is_active: boolean;
    manager_id: string | null;
    manager_name: string;
    created_at: string;
    updated_at: string;
    item_count: string;
    views: string;
    views_last_7_days: string;
    views_last_30_days: string;
    views_period: string;
    last_view_at: string | null;
    unique_visitors: string;
    repeat_views: string;
    pdf_downloads: string;
    pdf_last_7_days: string;
    pdf_last_30_days: string;
    pdf_period: string;
    unique_downloaders: string;
    last_pdf_at: string | null;
    excel_downloads: string;
    excel_last_7_days: string;
    excel_last_30_days: string;
    excel_period: string;
    unique_excel_downloaders: string;
    last_excel_at: string | null;
    requests_sent: string;
    requests_period: string;
    last_request_at: string | null;
    first_view_at: string | null;
    first_pdf_at: string | null;
    first_request_at: string | null;
    last_manager_activity_at: string | null;
    last_client_event_type: string | null;
  };

  type AdminEventRow = AnalyticsEventRow & {
    manager_id: string | null;
  };

  const managersResult = await query<AdminManagerRow>(
    `select
       m.id::text,
       m.name,
       m.login,
       m.email,
       m.phone,
       m.is_active,
       login_events.last_login_at::text
     from wholesale_managers m
     left join lateral (
       select max(e.created_at) as last_login_at
       from wholesale_analytics_events e
       where e.manager_id = m.id and e.event_type = 'manager_login'
     ) login_events on true
     order by m.name asc, m.id asc`,
  );

  const priceStats = await query<AdminPriceRow>(
    `select
       pl.id::text,
       coalesce(nullif(pl.title, ''), 'Без названия') as title,
       coalesce(pl.client_name, '') as client_name,
       pl.valid_until::text,
       pl.workflow_status,
       pl.is_active,
       pl.manager_id::text,
       coalesce(m.name, 'Не назначен') as manager_name,
       pl.created_at::text,
       pl.updated_at::text,
       coalesce(items.item_count, 0)::text as item_count,
       coalesce(views.views, 0)::text as views,
       coalesce(views.views_last_7_days, 0)::text as views_last_7_days,
       coalesce(views.views_last_30_days, 0)::text as views_last_30_days,
       coalesce(views.views_period, 0)::text as views_period,
       views.last_view_at::text,
       coalesce(view_events.unique_visitors, 0)::text as unique_visitors,
       coalesce(view_events.repeat_views, 0)::text as repeat_views,
       coalesce(pdf.pdf_downloads, 0)::text as pdf_downloads,
       coalesce(pdf.pdf_last_7_days, 0)::text as pdf_last_7_days,
       coalesce(pdf.pdf_last_30_days, 0)::text as pdf_last_30_days,
       coalesce(pdf.pdf_period, 0)::text as pdf_period,
       coalesce(pdf.unique_downloaders, 0)::text as unique_downloaders,
       pdf.last_pdf_at::text,
       coalesce(excel.excel_downloads, 0)::text as excel_downloads,
       coalesce(excel.excel_last_7_days, 0)::text as excel_last_7_days,
       coalesce(excel.excel_last_30_days, 0)::text as excel_last_30_days,
       coalesce(excel.excel_period, 0)::text as excel_period,
       coalesce(excel.unique_downloaders, 0)::text as unique_excel_downloaders,
       excel.last_excel_at::text,
       coalesce(requests.requests_sent, 0)::text as requests_sent,
       coalesce(requests.requests_period, 0)::text as requests_period,
       requests.last_request_at::text,
       views.first_view_at::text,
       pdf.first_pdf_at::text,
       requests.first_request_at::text,
       manager_actions.last_manager_activity_at::text,
       client_activity.last_client_event_type
     from wholesale_price_lists pl
     left join wholesale_managers m on m.id = pl.manager_id
     left join lateral (
       select count(*)::integer as item_count
       from wholesale_price_list_items i
       where i.price_list_id = pl.id and i.visible = true
     ) items on true
     left join lateral (
       select
         count(*)::integer as views,
         count(*) filter (where created_at >= now() - interval '7 days')::integer as views_last_7_days,
         count(*) filter (where created_at >= now() - interval '30 days')::integer as views_last_30_days,
         count(*) filter (where ($1::text is null or created_at >= now() - $1::interval))::integer as views_period,
         max(created_at) as last_view_at,
         min(created_at) as first_view_at
       from wholesale_price_view_logs v
       where v.price_list_id = pl.id
     ) views on true
     left join lateral (
       select
         count(distinct nullif(session_id, ''))::integer as unique_visitors,
         count(*) filter (where event_type = 'public_price_reopened')::integer as repeat_views
       from wholesale_analytics_events e
       where e.price_list_id = pl.id
         and e.actor_type = 'client'
         and e.event_type in ('public_price_opened', 'public_price_reopened')
         and ($1::text is null or e.created_at >= now() - $1::interval)
     ) view_events on true
     left join lateral (
       select
         count(*)::integer as pdf_downloads,
         count(*) filter (where created_at >= now() - interval '7 days')::integer as pdf_last_7_days,
         count(*) filter (where created_at >= now() - interval '30 days')::integer as pdf_last_30_days,
         count(*) filter (where ($1::text is null or created_at >= now() - $1::interval))::integer as pdf_period,
         count(distinct nullif(session_id, ''))::integer as unique_downloaders,
         max(created_at) as last_pdf_at,
         min(created_at) as first_pdf_at
       from wholesale_analytics_events e
       where e.price_list_id = pl.id
         and e.actor_type = 'client'
         and e.event_type = 'public_price_pdf_downloaded'
     ) pdf on true
     left join lateral (
       select
         count(*)::integer as excel_downloads,
         count(*) filter (where created_at >= now() - interval '7 days')::integer as excel_last_7_days,
         count(*) filter (where created_at >= now() - interval '30 days')::integer as excel_last_30_days,
         count(*) filter (where ($1::text is null or created_at >= now() - $1::interval))::integer as excel_period,
         count(distinct nullif(session_id, ''))::integer as unique_downloaders,
         max(created_at) as last_excel_at
       from wholesale_analytics_events e
       where e.price_list_id = pl.id
         and e.actor_type = 'client'
         and e.event_type = 'public_price_excel_downloaded'
     ) excel on true
     left join lateral (
       select
         count(*)::integer as requests_sent,
         count(*) filter (where ($1::text is null or created_at >= now() - $1::interval))::integer as requests_period,
         max(created_at) as last_request_at,
         min(created_at) as first_request_at
       from wholesale_analytics_events e
       where e.price_list_id = pl.id
         and e.actor_type = 'client'
         and e.event_type = 'public_price_request_sent'
     ) requests on true
     left join lateral (
       select max(e.created_at) as last_manager_activity_at
       from wholesale_analytics_events e
       where e.price_list_id = pl.id
         and e.actor_type in ('admin', 'manager')
         and e.event_type in (
           'price_updated',
           'price_status_changed',
           'price_client_changed',
           'price_expiration_changed',
           'price_items_added',
           'price_items_removed',
           'price_activated',
           'price_deactivated'
         )
     ) manager_actions on true
     left join lateral (
       select e.event_type as last_client_event_type
       from wholesale_analytics_events e
       where e.price_list_id = pl.id
         and e.actor_type = 'client'
         and e.event_type in (
           'public_price_opened',
           'public_price_reopened',
           'public_price_pdf_downloaded',
           'public_price_excel_downloaded',
           'public_price_request_sent',
           'public_price_phone_clicked',
           'public_price_email_clicked',
           'public_price_request_abandoned'
         )
       order by e.created_at desc, e.id desc
       limit 1
     ) client_activity on true
     order by pl.created_at desc, pl.id desc`,
    [interval],
  );

  const eventSummary = await query<{
    actions_last_7_days: string;
    actions_last_30_days: string;
    actions_period: string;
    logins_last_7_days: string;
    logins_last_30_days: string;
    logins_period: string;
    active_days_period: string;
    active_managers_period: string;
  }>(
    `select
       count(*) filter (where event_type = any($2::text[]) and created_at >= now() - interval '7 days')::text as actions_last_7_days,
       count(*) filter (where event_type = any($2::text[]) and created_at >= now() - interval '30 days')::text as actions_last_30_days,
       count(*) filter (where event_type = any($2::text[]) and ($1::text is null or created_at >= now() - $1::interval))::text as actions_period,
       count(*) filter (where event_type = 'manager_login' and created_at >= now() - interval '7 days')::text as logins_last_7_days,
       count(*) filter (where event_type = 'manager_login' and created_at >= now() - interval '30 days')::text as logins_last_30_days,
       count(*) filter (where event_type = 'manager_login' and ($1::text is null or created_at >= now() - $1::interval))::text as logins_period,
       count(distinct created_at::date) filter (where event_type = any($3::text[]) and ($1::text is null or created_at >= now() - $1::interval))::text as active_days_period,
       count(distinct manager_id) filter (where manager_id is not null and event_type = any($3::text[]) and ($1::text is null or created_at >= now() - $1::interval))::text as active_managers_period
     from wholesale_analytics_events
     where actor_type in ('admin', 'manager')`,
    [interval, managerActionEvents, trackedManagerEvents],
  );

  const managerActivityResult = await query<{
    manager_id: string;
    actions_period: string;
    logins_period: string;
    active_days_period: string;
    last_action_at: string | null;
  }>(
    `select
       manager_id::text,
       count(*) filter (where event_type = any($2::text[]) and ($1::text is null or created_at >= now() - $1::interval))::text as actions_period,
       count(*) filter (where event_type = 'manager_login' and ($1::text is null or created_at >= now() - $1::interval))::text as logins_period,
       count(distinct created_at::date) filter (where event_type = any($3::text[]) and ($1::text is null or created_at >= now() - $1::interval))::text as active_days_period,
       max(created_at) filter (where event_type = any($2::text[]))::text as last_action_at
     from wholesale_analytics_events
     where manager_id is not null
       and actor_type in ('admin', 'manager')
       and event_type = any($3::text[])
     group by manager_id`,
    [interval, managerActionEvents, trackedManagerEvents],
  );

  const lastLoginResult = await query<{ manager_id: string | null; manager_name: string; created_at: string }>(
    `select e.manager_id::text, coalesce(m.name, 'Не назначен') as manager_name, e.created_at::text
     from wholesale_analytics_events e
     left join wholesale_managers m on m.id = e.manager_id
     where e.event_type = 'manager_login' and e.manager_id is not null
     order by e.created_at desc, e.id desc
     limit 1`,
  );

  const lastActionResult = await query<{
    event_type: string;
    manager_id: string | null;
    manager_name: string;
    price_title: string | null;
    client_name: string | null;
    created_at: string;
  }>(
    `select
       e.event_type,
       e.manager_id::text,
       coalesce(m.name, 'Не назначен') as manager_name,
       coalesce(nullif(pl.title, ''), e.metadata->>'title', 'Без названия') as price_title,
       coalesce(nullif(pl.client_name, ''), e.metadata->>'clientName', '') as client_name,
       e.created_at::text
     from wholesale_analytics_events e
     left join wholesale_price_lists pl on pl.id = e.price_list_id
     left join wholesale_managers m on m.id = e.manager_id
     where e.event_type = any($1::text[])
     order by e.created_at desc, e.id desc
     limit 1`,
    [managerActionEvents],
  );

  const recentEventsResult = await query<AdminEventRow>(
    `select
       e.id::text,
       e.event_type,
       e.actor_type,
       e.manager_id::text,
       e.price_list_id::text as price_id,
       coalesce(nullif(pl.title, ''), e.metadata->>'title', 'Без названия') as price_title,
       e.client_id,
       coalesce(nullif(pl.client_name, ''), e.metadata->>'clientName', '') as client_name,
       coalesce(m.name, '') as manager_name,
       e.created_at::text,
       coalesce(nullif(e.metadata->>'details', ''), e.metadata::text, '') as details,
       e.session_id,
       e.referer
     from wholesale_analytics_events e
     left join wholesale_price_lists pl on pl.id = e.price_list_id
     left join wholesale_managers m on m.id = e.manager_id
     where ($1::text is null or e.created_at >= now() - $1::interval)
     order by e.created_at desc, e.id desc
     limit 50`,
    [interval],
  );

  const views24Result = await query<{ client_id: string; views: string }>(
    `select coalesce(nullif(e.client_id, ''), lower(pl.client_name)) as client_id, count(*)::text as views
     from wholesale_analytics_events e
     left join wholesale_price_lists pl on pl.id = e.price_list_id
     where e.actor_type = 'client'
       and e.event_type in ('public_price_opened', 'public_price_reopened')
       and e.created_at >= now() - interval '24 hours'
       and coalesce(nullif(e.client_id, ''), lower(pl.client_name)) is not null
       and btrim(coalesce(nullif(e.client_id, ''), lower(pl.client_name))) <> ''
     group by coalesce(nullif(e.client_id, ''), lower(pl.client_name))`,
  );

  const rows = priceStats.rows;
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayTime = today.getTime();
  const selectedCutoff = period === '7d' ? now - 7 * day : period === '30d' ? now - 30 * day : null;
  const validTime = (value: string | null) => (value ? new Date(`${value}T00:00:00`).getTime() : null);
  const isInSelectedPeriod = (value: string) => selectedCutoff === null || new Date(value).getTime() >= selectedCutoff;
  const daysLeft = (value: string | null) => {
    const time = validTime(value);
    return time === null ? null : Math.ceil((time - todayTime) / day);
  };
  const itemCounts = rows.map((row) => Number(row.item_count)).sort((a, b) => a - b);
  const medianItemsPerPrice =
    itemCounts.length === 0
      ? 0
      : itemCounts.length % 2
        ? itemCounts[Math.floor(itemCounts.length / 2)]
        : (itemCounts[itemCounts.length / 2 - 1] + itemCounts[itemCounts.length / 2]) / 2;
  const averageItemsPerPrice = rows.length ? rows.reduce((sum, row) => sum + Number(row.item_count), 0) / rows.length : 0;

  const toProblemPrice = (row: AdminPriceRow): WholesaleAdminAnalyticsProblemPrice => {
    const price = mapProblemPrice({
      id: row.id,
      title: row.title,
      client_name: row.client_name,
      valid_until: row.valid_until,
      created_at: row.created_at,
      updated_at: row.updated_at,
      item_count: row.item_count,
      views: row.views,
      pdf_downloads: row.pdf_downloads,
    });
    return {
      ...price,
      managerId: row.manager_id ? Number(row.manager_id) : null,
      managerName: row.manager_name,
      isActive: row.is_active,
      daysLeft: daysLeft(row.valid_until),
    };
  };

  const problemPrices = rows.map(toProblemPrice).filter((price) => price.problems.length > 0);
  const expiredPrices = rows.filter((row) => {
    const value = validTime(row.valid_until);
    return value !== null && value < todayTime;
  }).length;
  const expiringSoon7Days = rows.filter((row) => {
    const value = validTime(row.valid_until);
    return value !== null && value >= todayTime && value <= todayTime + 7 * day;
  }).length;
  const expiringSoon30Days = rows.filter((row) => {
    const value = validTime(row.valid_until);
    return value !== null && value >= todayTime && value <= todayTime + 30 * day;
  }).length;
  const stalePrices30Days = rows.filter((row) => new Date(row.updated_at).getTime() < now - 30 * day).length;
  const emptyPrices = rows.filter((row) => Number(row.item_count) === 0).length;
  const pricesWithoutClient = rows.filter((row) => !row.client_name.trim()).length;
  const pricesWithoutExpiration = rows.filter((row) => !row.valid_until).length;
  const pricesWithoutViews = rows.filter((row) => Number(row.views) === 0).length;
  const pricesWithoutPdfDownloads = rows.filter((row) => Number(row.pdf_downloads) === 0).length;
  const pricesWithoutExcelDownloads = rows.filter((row) => Number(row.excel_downloads) === 0).length;
  const pricesCreatedLast7Days = rows.filter((row) => new Date(row.created_at).getTime() >= now - 7 * day).length;
  const pricesCreatedLast30Days = rows.filter((row) => new Date(row.created_at).getTime() >= now - 30 * day).length;
  const pricesCreatedInSelectedPeriod = rows.filter((row) => isInSelectedPeriod(row.created_at)).length;
  const totalPublicViews = rows.reduce((sum, row) => sum + Number(row.views), 0);
  const publicViewsInSelectedPeriod = rows.reduce((sum, row) => sum + Number(row.views_period), 0);
  const totalPdfDownloads = rows.reduce((sum, row) => sum + Number(row.pdf_downloads), 0);
  const pdfDownloadsInSelectedPeriod = rows.reduce((sum, row) => sum + Number(row.pdf_period), 0);
  const totalExcelDownloads = rows.reduce((sum, row) => sum + Number(row.excel_downloads), 0);
  const excelDownloadsInSelectedPeriod = rows.reduce((sum, row) => sum + Number(row.excel_period), 0);
  const uniquePublicVisitors = rows.reduce((sum, row) => sum + Number(row.unique_visitors), 0);
  const uniqueDownloaders = rows.reduce((sum, row) => sum + Number(row.unique_downloaders), 0);
  const uniqueExcelDownloaders = rows.reduce((sum, row) => sum + Number(row.unique_excel_downloaders), 0);
  const repeatViews = rows.reduce((sum, row) => sum + Number(row.repeat_views), 0);

  const managerActivityById = new Map(
    managerActivityResult.rows.map((row) => [
      Number(row.manager_id),
      {
        actionsInSelectedPeriod: Number(row.actions_period),
        loginsInSelectedPeriod: Number(row.logins_period),
        activeDaysInSelectedPeriod: Number(row.active_days_period),
        lastActionAt: row.last_action_at,
      },
    ]),
  );
  const priceRowsByManager = new Map<number, AdminPriceRow[]>();
  for (const row of rows) {
    if (!row.manager_id) continue;
    const managerId = Number(row.manager_id);
    priceRowsByManager.set(managerId, [...(priceRowsByManager.get(managerId) ?? []), row]);
  }

  const managers = managersResult.rows
    .map<WholesaleAdminAnalyticsManager>((manager) => {
      const managerId = Number(manager.id);
      const managerRows = priceRowsByManager.get(managerId) ?? [];
      const activity = managerActivityById.get(managerId);
      const managerProblems = managerRows.map(toProblemPrice).filter((price) => price.problems.length > 0);
      const managerStuckPrices = buildStuckPrices(managerRows, now, todayTime, day, 1000);
      const managerReactionRows = buildReactionNeeded(managerRows, now, 1000);
      const managerExpired = managerRows.filter((row) => {
        const value = validTime(row.valid_until);
        return value !== null && value < todayTime;
      }).length;
      const managerStale = managerRows.filter((row) => new Date(row.updated_at).getTime() < now - 30 * day).length;
      const activePriceCount = managerRows.filter((row) => row.is_active).length;
      const openedPriceCount = managerRows.filter((row) => Number(row.views) > 0).length;
      const pdfPriceCount = managerRows.filter((row) => Number(row.pdf_downloads) > 0).length;
      const requestPriceCount = managerRows.filter((row) => Number(row.requests_sent) > 0).length;
      const sentPriceCount = managerRows.filter((row) => rowStatus(row) !== 'not_sent').length;
      const confirmedPriceCount = managerRows.filter((row) => rowStatus(row) === 'confirmed').length;
      const averageReactionHours = managerReactionRows.length
        ? Math.round((managerReactionRows.reduce((sum, row) => sum + row.hoursWithoutReaction, 0) / managerReactionRows.length) * 10) / 10
        : null;
      const clientsWithActivity = new Set(
        managerRows
          .filter((row) => Number(row.views_period) > 0 || Number(row.pdf_period) > 0 || Number(row.requests_period) > 0)
          .map((row) => clientIdFromName(row.client_name))
          .filter(Boolean) as string[],
      ).size;
      return {
        id: managerId,
        name: manager.name,
        login: manager.login,
        email: manager.email,
        phone: manager.phone,
        isActive: manager.is_active,
        totalPrices: managerRows.length,
        activePrices: activePriceCount,
        expiredPrices: managerExpired,
        problemPrices: managerProblems.length,
        pricesCreatedInSelectedPeriod: managerRows.filter((row) => isInSelectedPeriod(row.created_at)).length,
        actionsInSelectedPeriod: activity?.actionsInSelectedPeriod ?? 0,
        publicViews: managerRows.reduce((sum, row) => sum + Number(row.views_period), 0),
        uniqueVisitors: managerRows.reduce((sum, row) => sum + Number(row.unique_visitors), 0),
        pdfDownloads: managerRows.reduce((sum, row) => sum + Number(row.pdf_period), 0),
        clientsWithActivity,
        qualityScore: qualityScore({
          emptyPrices: managerRows.filter((row) => Number(row.item_count) === 0).length,
          pricesWithoutClient: managerRows.filter((row) => !row.client_name.trim()).length,
          pricesWithoutExpiration: managerRows.filter((row) => !row.valid_until).length,
          expiredPrices: managerExpired,
          pricesWithoutViews: managerRows.filter((row) => Number(row.views) === 0).length,
          stalePrices30Days: managerStale,
        }),
        lastLoginAt: manager.last_login_at,
        lastActionAt: activity?.lastActionAt ?? null,
        viewsPerActivePrice: activePriceCount ? Number((managerRows.reduce((sum, row) => sum + Number(row.views_period), 0) / activePriceCount).toFixed(1)) : 0,
        pdfPerActivePrice: activePriceCount ? Number((managerRows.reduce((sum, row) => sum + Number(row.pdf_period), 0) / activePriceCount).toFixed(1)) : 0,
        requestsPerActivePrice: activePriceCount ? Number((managerRows.reduce((sum, row) => sum + Number(row.requests_period), 0) / activePriceCount).toFixed(1)) : 0,
        sentToOpenedConversion: sentPriceCount ? Math.round((openedPriceCount / sentPriceCount) * 100) : 0,
        openedToPdfConversion: openedPriceCount ? Math.round((pdfPriceCount / openedPriceCount) * 100) : 0,
        openedToRequestConversion: openedPriceCount ? Math.round((requestPriceCount / openedPriceCount) * 100) : 0,
        stuckPriceRate: managerRows.length ? Math.round((managerStuckPrices.length / managerRows.length) * 100) : 0,
        confirmedPriceRate: managerRows.length ? Math.round((confirmedPriceCount / managerRows.length) * 100) : 0,
        averageReactionHours,
      };
    })
    .sort((a, b) => {
      const aActive = a.actionsInSelectedPeriod > 0 || (managerActivityById.get(a.id)?.loginsInSelectedPeriod ?? 0) > 0;
      const bActive = b.actionsInSelectedPeriod > 0 || (managerActivityById.get(b.id)?.loginsInSelectedPeriod ?? 0) > 0;
      if (aActive !== bActive) return aActive ? -1 : 1;
      if (a.actionsInSelectedPeriod !== b.actionsInSelectedPeriod) return b.actionsInSelectedPeriod - a.actionsInSelectedPeriod;
      return b.totalPrices - a.totalPrices;
    });

  const averageQualityScore = managers.length
    ? Math.round(managers.reduce((sum, manager) => sum + manager.qualityScore, 0) / managers.length)
    : 0;
  const bestManager = managers.length ? [...managers].sort((a, b) => b.qualityScore - a.qualityScore)[0] : null;
  const managersNeedAttention = managers.filter((manager) => manager.qualityScore < 70 || manager.problemPrices > 0).slice(0, 10);
  const activityRow = eventSummary.rows[0];
  const activeManagersInSelectedPeriod = Number(activityRow?.active_managers_period ?? 0);

  const problemsByManager = managers
    .map((manager) => {
      const managerRows = priceRowsByManager.get(manager.id) ?? [];
      const managerExpired = managerRows.filter((row) => {
        const value = validTime(row.valid_until);
        return value !== null && value < todayTime;
      }).length;
      const row = {
        managerId: manager.id,
        managerName: manager.name,
        emptyPrices: managerRows.filter((price) => Number(price.item_count) === 0).length,
        pricesWithoutClient: managerRows.filter((price) => !price.client_name.trim()).length,
        pricesWithoutExpiration: managerRows.filter((price) => !price.valid_until).length,
        expiredPrices: managerExpired,
        pricesWithoutViews: managerRows.filter((price) => Number(price.views) === 0).length,
        stalePrices30Days: managerRows.filter((price) => new Date(price.updated_at).getTime() < now - 30 * day).length,
        totalProblems: 0,
      };
      row.totalProblems =
        row.emptyPrices +
        row.pricesWithoutClient +
        row.pricesWithoutExpiration +
        row.expiredPrices +
        row.pricesWithoutViews +
        row.stalePrices30Days;
      return row;
    })
    .filter((row) => row.totalProblems > 0)
    .sort((a, b) => b.totalProblems - a.totalProblems);

  const mapAdminEvent = (row: AdminEventRow): WholesaleAdminAnalyticsEvent => ({
    ...mapAnalyticsEvent(row),
    managerId: row.manager_id ? Number(row.manager_id) : null,
  });
  const recentEvents = recentEventsResult.rows.map(mapAdminEvent);
  const latestViews = recentEvents.filter((event) => ['public_price_opened', 'public_price_reopened'].includes(event.eventType));
  const latestDownloads = recentEvents.filter((event) => event.eventType === 'public_price_pdf_downloaded');
  const latestExcelDownloads = recentEvents.filter((event) => event.eventType === 'public_price_excel_downloaded');

  const clientMap = new Map<string, WholesaleAdminAnalyticsClient>();
  for (const row of rows) {
    const clientName = row.client_name.trim();
    if (!clientName) continue;
    const key = clientName.toLowerCase();
    const current =
      clientMap.get(key) ??
      ({
        clientId: key,
        clientName,
        managerId: row.manager_id ? Number(row.manager_id) : null,
        managerName: row.manager_name,
        priceId: Number(row.id),
        priceTitle: row.title,
        priceCount: 0,
        viewsLast24Hours: 0,
        viewsLast7Days: 0,
        views: 0,
        uniqueVisitors: 0,
        pdfDownloads: 0,
        lastActivityAt: null,
        lastPriceCreatedAt: null,
        status: 'Не открывал',
      } satisfies WholesaleAdminAnalyticsClient);
    current.priceCount += 1;
    current.views += Number(row.views_period);
    current.viewsLast7Days += Number(row.views_last_7_days);
    current.uniqueVisitors += Number(row.unique_visitors);
    current.pdfDownloads += Number(row.pdf_period);
    const lastActivity = [row.last_view_at, row.last_pdf_at, row.last_excel_at, row.last_request_at].filter(Boolean).sort().at(-1) ?? null;
    if (lastActivity && (!current.lastActivityAt || lastActivity > current.lastActivityAt)) {
      current.lastActivityAt = lastActivity;
      current.managerId = row.manager_id ? Number(row.manager_id) : null;
      current.managerName = row.manager_name;
      current.priceId = Number(row.id);
      current.priceTitle = row.title;
    }
    if (!current.lastPriceCreatedAt || row.created_at > current.lastPriceCreatedAt) current.lastPriceCreatedAt = row.created_at;
    clientMap.set(key, current);
  }
  for (const row of views24Result.rows) {
    const client = clientMap.get(row.client_id);
    if (client) client.viewsLast24Hours = Number(row.views);
  }
  const workflowRows: AnalyticsWorkflowRow[] = rows;
  const views24ByClient = new Map(views24Result.rows.map((row) => [row.client_id, Number(row.views)]));
  const statusFunnel = buildStatusFunnel(workflowRows);
  const stuckPrices = buildStuckPrices(workflowRows, now, todayTime, day);
  const managerReactionNeeded = buildReactionNeeded(workflowRows, now);
  const priorityClients = buildPriorityClients(workflowRows, views24ByClient, managerReactionNeeded);
  const clientHistory = buildClientHistory(workflowRows, now, todayTime);
  const [productInterest, comparison] = await Promise.all([
    getProductInterest(null, interval),
    getPeriodComparison(null, period),
  ]);
  const clients = Array.from(clientMap.values()).map((client) => {
    let status = 'Не открывал';
    if (client.views > 0) status = 'Смотрел';
    if (client.pdfDownloads > 0) status = 'Скачал PDF';
    if (client.viewsLast24Hours >= 2 || client.viewsLast7Days >= 3 || client.pdfDownloads > 0) status = 'Горячий';
    return { ...client, status };
  });

  const topViewedRows = [...rows].filter((row) => Number(row.views_period) > 0).sort((a, b) => Number(b.views_period) - Number(a.views_period));
  const topDownloadedRows = [...rows].filter((row) => Number(row.pdf_period) > 0).sort((a, b) => Number(b.pdf_period) - Number(a.pdf_period));
  const topExcelRows = [...rows].filter((row) => Number(row.excel_period) > 0).sort((a, b) => Number(b.excel_period) - Number(a.excel_period));
  const topViewedPrice = topViewedRows[0]
    ? { priceId: Number(topViewedRows[0].id), title: topViewedRows[0].title, managerName: topViewedRows[0].manager_name, views: Number(topViewedRows[0].views_period) }
    : null;
  const topDownloadedPrice = topDownloadedRows[0]
    ? {
        priceId: Number(topDownloadedRows[0].id),
        title: topDownloadedRows[0].title,
        managerName: topDownloadedRows[0].manager_name,
        downloads: Number(topDownloadedRows[0].pdf_period),
      }
    : null;
  const largestPrice = rows.length
    ? [...rows]
        .sort((a, b) => Number(b.item_count) - Number(a.item_count))
        .map((row) => ({ id: Number(row.id), title: row.title, managerName: row.manager_name, itemCount: Number(row.item_count) }))[0]
    : null;
  const managerViews = managers
    .map((manager) => ({ managerId: manager.id, managerName: manager.name, views: manager.publicViews }))
    .filter((manager) => manager.views > 0)
    .sort((a, b) => b.views - a.views);
  const managerPdf = managers
    .map((manager) => ({ managerId: manager.id, managerName: manager.name, downloads: manager.pdfDownloads }))
    .filter((manager) => manager.downloads > 0)
    .sort((a, b) => b.downloads - a.downloads);
  const managerExcel = managers
    .map((manager) => {
      const managerRows = priceRowsByManager.get(manager.id) ?? [];
      return {
        managerId: manager.id,
        managerName: manager.name,
        downloads: managerRows.reduce((sum, row) => sum + Number(row.excel_period), 0),
      };
    })
    .filter((manager) => manager.downloads > 0)
    .sort((a, b) => b.downloads - a.downloads);
  const managersByDownloads = managers
    .map((manager) => {
      const managerRows = priceRowsByManager.get(manager.id) ?? [];
      return {
        managerId: manager.id,
        managerName: manager.name,
        pricesWithDownloads: managerRows.filter((row) => Number(row.pdf_period) > 0).length,
        downloads: managerRows.reduce((sum, row) => sum + Number(row.pdf_period), 0),
        uniqueDownloaders: managerRows.reduce((sum, row) => sum + Number(row.unique_downloaders), 0),
        lastDownloadAt: managerRows.map((row) => row.last_pdf_at).filter(Boolean).sort().at(-1) ?? null,
      };
    })
    .filter((manager) => manager.downloads > 0)
    .sort((a, b) => b.downloads - a.downloads)
    .slice(0, 10);
  const managersByExcelDownloads = managers
    .map((manager) => {
      const managerRows = priceRowsByManager.get(manager.id) ?? [];
      return {
        managerId: manager.id,
        managerName: manager.name,
        pricesWithDownloads: managerRows.filter((row) => Number(row.excel_period) > 0).length,
        downloads: managerRows.reduce((sum, row) => sum + Number(row.excel_period), 0),
        uniqueDownloaders: managerRows.reduce((sum, row) => sum + Number(row.unique_excel_downloaders), 0),
        lastDownloadAt: managerRows.map((row) => row.last_excel_at).filter(Boolean).sort().at(-1) ?? null,
      };
    })
    .filter((manager) => manager.downloads > 0)
    .sort((a, b) => b.downloads - a.downloads)
    .slice(0, 10);

  const clientsWithActivity = clients.filter((client) => {
    const hasRequest = rows.some((row) => client.clientId === clientIdFromName(row.client_name) && Number(row.requests_period) > 0);
    return client.views > 0 || client.pdfDownloads > 0 || hasRequest;
  }).length;
  const clientsWithExpiredPrices = new Set(
    rows
      .filter((row) => {
        const value = validTime(row.valid_until);
        return row.client_name.trim() && value !== null && value < todayTime;
      })
      .map((row) => clientIdFromName(row.client_name))
      .filter(Boolean) as string[],
  ).size;
  const clientsWithActivePrices = new Set(
    rows
      .filter((row) => row.client_name.trim() && row.is_active)
      .map((row) => clientIdFromName(row.client_name))
      .filter(Boolean) as string[],
  ).size;
  const clientsWithoutActualActivePrice = clients.length - clientsWithActivePrices;

  return {
    period,
    summary: {
      totalManagers: managers.length,
      activeManagers: activeManagersInSelectedPeriod,
      inactiveManagers: Math.max(0, managers.length - activeManagersInSelectedPeriod),
      totalPrices: rows.length,
      activePrices: rows.filter((row) => row.is_active).length,
      inactivePrices: rows.filter((row) => !row.is_active).length,
      expiredPrices,
      expiringSoon7Days,
      expiringSoon30Days,
      pricesCreatedLast7Days,
      pricesCreatedLast30Days,
      pricesCreatedInSelectedPeriod,
      problemPrices: problemPrices.length,
      averageItemsPerPrice: Number(averageItemsPerPrice.toFixed(1)),
      medianItemsPerPrice: Number(medianItemsPerPrice.toFixed(1)),
      emptyPrices,
      pricesWithoutClient,
      pricesWithoutExpiration,
      stalePrices30Days,
      pricesWithoutViews,
      pricesWithoutPdfDownloads,
      totalPublicViews,
      uniquePublicVisitors,
      publicViewsInSelectedPeriod,
      totalPdfDownloads,
      pdfDownloadsInSelectedPeriod,
      clientsWithActivity,
      averageQualityScore,
    },
    managerActivity: {
      actionsLast7Days: Number(activityRow?.actions_last_7_days ?? 0),
      actionsLast30Days: Number(activityRow?.actions_last_30_days ?? 0),
      actionsInSelectedPeriod: Number(activityRow?.actions_period ?? 0),
      loginsLast7Days: Number(activityRow?.logins_last_7_days ?? 0),
      loginsLast30Days: Number(activityRow?.logins_last_30_days ?? 0),
      loginsInSelectedPeriod: Number(activityRow?.logins_period ?? 0),
      activeDaysInSelectedPeriod: Number(activityRow?.active_days_period ?? 0),
      activeManagersInSelectedPeriod,
      inactiveManagersInSelectedPeriod: Math.max(0, managers.length - activeManagersInSelectedPeriod),
      lastLogin: lastLoginResult.rows[0]
        ? {
            managerId: lastLoginResult.rows[0].manager_id ? Number(lastLoginResult.rows[0].manager_id) : null,
            managerName: lastLoginResult.rows[0].manager_name,
            createdAt: lastLoginResult.rows[0].created_at,
          }
        : null,
      lastAction: lastActionResult.rows[0]
        ? {
            eventType: lastActionResult.rows[0].event_type,
            managerId: lastActionResult.rows[0].manager_id ? Number(lastActionResult.rows[0].manager_id) : null,
            managerName: lastActionResult.rows[0].manager_name,
            priceTitle: lastActionResult.rows[0].price_title || 'Без названия',
            clientName: lastActionResult.rows[0].client_name || '',
            createdAt: lastActionResult.rows[0].created_at,
          }
        : null,
    },
    managers,
    priceQuality: {
      emptyPrices,
      pricesWithoutClient,
      pricesWithoutExpiration,
      expiredPrices,
      expiringSoon7Days,
      expiringSoon30Days,
      stalePrices30Days,
      pricesWithoutViews,
      pricesWithoutPdfDownloads,
      averageQualityScore,
      bestManager,
      managersNeedAttention,
      problemsByManager,
    },
    priceInsights: {
      latestPrices: rows.slice(0, 10).map(toProblemPrice),
      expiringSoonPrices: problemPrices.filter((price) => price.problems.includes('EXPIRING_SOON')).slice(0, 10),
      pricesWithoutViews: problemPrices.filter((price) => price.problems.includes('NO_VIEWS')).slice(0, 20),
      topViewedPrice,
      topDownloadedPrice,
      largestPrice,
    },
    publicLinks: {
      totalViews: totalPublicViews,
      uniqueVisitors: uniquePublicVisitors,
      repeatViews,
      viewsLast7Days: rows.reduce((sum, row) => sum + Number(row.views_last_7_days), 0),
      viewsLast30Days: rows.reduce((sum, row) => sum + Number(row.views_last_30_days), 0),
      viewsInSelectedPeriod: publicViewsInSelectedPeriod,
      lastViewAt: rows.map((row) => row.last_view_at).filter(Boolean).sort().at(-1) ?? null,
      pricesWithoutViews,
      averageViewsPerPrice: rows.length ? Number((totalPublicViews / rows.length).toFixed(1)) : 0,
      topManager: managerViews[0] ?? null,
      topViewedPrices: topViewedRows.slice(0, 10).map((row) => ({
        priceId: Number(row.id),
        title: row.title,
        clientName: row.client_name,
        managerId: row.manager_id ? Number(row.manager_id) : null,
        managerName: row.manager_name,
        views: Number(row.views_period),
        uniqueVisitors: Number(row.unique_visitors),
        repeatViews: Number(row.repeat_views),
        lastViewAt: row.last_view_at,
      })),
      latestViews,
      pricesWithoutViewsList: problemPrices.filter((price) => price.problems.includes('NO_VIEWS')).slice(0, 20),
    },
    pdf: {
      totalDownloads: totalPdfDownloads,
      downloadsLast7Days: rows.reduce((sum, row) => sum + Number(row.pdf_last_7_days), 0),
      downloadsLast30Days: rows.reduce((sum, row) => sum + Number(row.pdf_last_30_days), 0),
      downloadsInSelectedPeriod: pdfDownloadsInSelectedPeriod,
      uniqueDownloaders,
      lastDownloadAt: rows.map((row) => row.last_pdf_at).filter(Boolean).sort().at(-1) ?? null,
      pricesWithDownloads: rows.filter((row) => Number(row.pdf_downloads) > 0).length,
      pricesWithoutDownloads: pricesWithoutPdfDownloads,
      topManager: managerPdf[0] ?? null,
      topDownloadedPrices: topDownloadedRows.slice(0, 10).map((row) => ({
        priceId: Number(row.id),
        title: row.title,
        clientName: row.client_name,
        managerId: row.manager_id ? Number(row.manager_id) : null,
        managerName: row.manager_name,
        downloads: Number(row.pdf_period),
        uniqueDownloaders: Number(row.unique_downloaders),
        views: Number(row.views_period),
        lastDownloadAt: row.last_pdf_at,
      })),
      latestDownloads,
      managersByDownloads,
    },
    excel: {
      totalDownloads: totalExcelDownloads,
      downloadsLast7Days: rows.reduce((sum, row) => sum + Number(row.excel_last_7_days), 0),
      downloadsLast30Days: rows.reduce((sum, row) => sum + Number(row.excel_last_30_days), 0),
      downloadsInSelectedPeriod: excelDownloadsInSelectedPeriod,
      uniqueDownloaders: uniqueExcelDownloaders,
      lastDownloadAt: rows.map((row) => row.last_excel_at).filter(Boolean).sort().at(-1) ?? null,
      pricesWithDownloads: rows.filter((row) => Number(row.excel_downloads) > 0).length,
      pricesWithoutDownloads: pricesWithoutExcelDownloads,
      topManager: managerExcel[0] ?? null,
      topDownloadedPrices: topExcelRows.slice(0, 10).map((row) => ({
        priceId: Number(row.id),
        title: row.title,
        clientName: row.client_name,
        managerId: row.manager_id ? Number(row.manager_id) : null,
        managerName: row.manager_name,
        downloads: Number(row.excel_period),
        uniqueDownloaders: Number(row.unique_excel_downloaders),
        views: Number(row.views_period),
        lastDownloadAt: row.last_excel_at,
      })),
      latestDownloads: latestExcelDownloads,
      managersByDownloads: managersByExcelDownloads,
    },
    clients: {
      totalClients: clients.length,
      clientsWithActivePrices,
      clientsWithViews: clients.filter((client) => client.views > 0).length,
      clientsWithoutViews: clients.filter((client) => client.views === 0).length,
      clientsWithPdfDownloads: clients.filter((client) => client.pdfDownloads > 0).length,
      hotClientsCount: clients.filter((client) => client.status === 'Горячий').length,
      clientsWithExpiredPrices,
      clientsWithoutActualActivePrice,
      hotClients: clients.filter((client) => client.status === 'Горячий').slice(0, 10),
      clientsWithoutViewsList: clients.filter((client) => client.views === 0).slice(0, 20),
      topClientsByActivity: [...clients].sort((a, b) => b.views + b.pdfDownloads - (a.views + a.pdfDownloads)).slice(0, 10),
    },
    funnel: {
      createdPrices: rows.length,
      activePublicLinks: rows.filter((row) => row.is_active).length,
      openedPrices: rows.filter((row) => Number(row.views) > 0).length,
      pricesWithRepeatViews: rows.filter((row) => Number(row.repeat_views) > 0).length,
      pdfDownloadedPrices: rows.filter((row) => Number(row.pdf_downloads) > 0).length,
      requestsSent: rows.filter((row) => Number(row.requests_sent) > 0).length,
      clientsWithActivity,
    },
    attention: {
      statusFunnel,
      stuckPrices,
      managerReactionNeeded,
      priorityClients,
      clientHistory,
      productInterest,
      comparison,
    },
    problemPrices: problemPrices.slice(0, 50),
    recentEvents,
  };
}

async function replaceWholesalePriceListItems(id: number, items: WholesalePriceListItemInput[]) {
  await query(`delete from wholesale_price_list_items where price_list_id = $1`, [id]);

  for (const item of items) {
    await query(
      `insert into wholesale_price_list_items (
         price_list_id, wholesale_product_id, wholesale_variant_id, custom_wholesale_price, visible, sort_order
       )
       select $1, p.id, v.id, nullif($4, '')::numeric, $5, $6
       from wholesale_products p
       left join wholesale_product_variants v on v.id = $3 and v.product_id = p.id
       where p.id = $2
         and ($3::bigint is null or v.id is not null)`,
      [id, item.productId, item.variantId, item.customWholesalePrice ?? '', item.visible, item.sortOrder],
    );
  }
}
