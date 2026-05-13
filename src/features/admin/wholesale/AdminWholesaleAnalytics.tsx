'use client';

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import styles from '@/app/admin/admin.module.scss';

type Period = '7d' | '30d' | 'all';
type ExportFormat = 'pdf' | 'xls';
type Tab = 'overview' | 'managers' | 'managerRatings' | 'prices' | 'clients' | 'public' | 'pdf' | 'excel' | 'events';
export type AdminWholesaleAnalyticsTab = Tab;

type Problem = 'EMPTY' | 'NO_CLIENT' | 'NO_EXPIRATION' | 'EXPIRED' | 'EXPIRING_SOON' | 'STALE' | 'NO_VIEWS';

type ProblemPrice = {
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

type ManagerRow = {
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

type AnalyticsEvent = {
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
};

type ClientRow = {
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

type StatusFunnelStep = {
  key: string;
  label: string;
  count: number;
  dropFromPrevious: number;
  conversionFromPrevious: number;
  conversionFromTotal: number;
};

type StatusFunnel = {
  steps: StatusFunnelStep[];
  biggestDrop: StatusFunnelStep | null;
  averageTimeToOpenHours: number | null;
  averageTimeToPdfHours: number | null;
  averageTimeToRequestHours: number | null;
};

type AttentionPrice = {
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

type ReactionNeeded = {
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

type PriorityClient = {
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

type ClientHistory = {
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

type ProductInterest = {
  productId: string | null;
  productTitle: string;
  opens: number;
  quantityChanges: number;
  requests: number;
  lastActivityAt: string | null;
};

type PeriodComparison = {
  label: string;
  current: number;
  previous: number;
  changePercent: number | null;
};

type Analytics = {
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
    productInterest: ProductInterest[];
    comparison: PeriodComparison[];
  };
  problemPrices: ProblemPrice[];
  recentEvents: AnalyticsEvent[];
};

const periods: Array<{ value: Period; label: string }> = [
  { value: '7d', label: '7 дней' },
  { value: '30d', label: '30 дней' },
  { value: 'all', label: 'Всё время' },
];

const tabs: Array<{ value: Tab; label: string; description: string }> = [
  { value: 'overview', label: 'Обзор', description: 'Главные KPI, воронка и риски' },
  { value: 'managers', label: 'Менеджеры', description: 'Добавление, управление и статистика' },
  { value: 'managerRatings', label: 'Рейтинг менеджеров', description: 'Рейтинг и качество воронки' },
  { value: 'prices', label: 'Статистика прайсов', description: 'Проблемы, сроки и карточки' },
  { value: 'clients', label: 'Клиенты', description: 'Активность, приоритет и история' },
  { value: 'public', label: 'Публичные ссылки', description: 'Открытия и повторные просмотры' },
  { value: 'pdf', label: 'PDF', description: 'Скачивания PDF' },
  { value: 'excel', label: 'EXCEL', description: 'Скачивания Excel' },
  { value: 'events', label: 'Журнал событий', description: 'Действия и фильтры' },
];

function resolveTab(value: string | null): Tab {
  return tabs.some((item) => item.value === value) ? (value as Tab) : 'overview';
}

const eventLabels: Record<string, string> = {
  manager_login: 'Вход менеджера',
  price_created: 'Создан прайс',
  price_updated: 'Изменён прайс',
  price_deleted: 'Удалён прайс',
  price_activated: 'Прайс включён',
  price_deactivated: 'Прайс отключён',
  price_client_changed: 'Изменён клиент',
  price_expiration_changed: 'Изменён срок действия',
  price_items_added: 'Добавлены позиции',
  price_items_removed: 'Удалены позиции',
  price_status_changed: 'Изменён статус прайса',
  price_public_link_created: 'Создана публичная ссылка',
  price_public_link_copied: 'Скопирована публичная ссылка',
  public_price_opened: 'Клиент открыл прайс',
  public_price_reopened: 'Клиент повторно открыл прайс',
  public_price_pdf_downloaded: 'Клиент скачал PDF',
  public_price_excel_downloaded: 'Клиент скачал Excel',
  public_price_phone_clicked: 'Клиент нажал телефон',
  public_price_email_clicked: 'Клиент нажал email',
  public_price_product_opened: 'Клиент открыл товар',
  public_price_search_used: 'Клиент использовал поиск',
  public_price_filter_used: 'Клиент использовал фильтр',
  public_price_request_started: 'Клиент начал заявку',
  public_price_quantity_changed: 'Клиент выбрал количество',
  public_price_request_abandoned: 'Клиент бросил заявку',
  public_price_request_sent: 'Клиент отправил заявку',
};

const problemLabels: Record<Problem, string> = {
  EMPTY: 'Пустой',
  NO_CLIENT: 'Без клиента',
  NO_EXPIRATION: 'Без срока',
  EXPIRED: 'Просрочен',
  EXPIRING_SOON: 'Скоро истекает',
  STALE: 'Не обновлялся',
  NO_VIEWS: 'Без просмотров',
};

function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDateOnly(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('ru-RU');
}

function shortValue(value: string | null | undefined) {
  if (!value) return '—';
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function qualityLabel(score: number) {
  if (score >= 90) return 'Отлично';
  if (score >= 70) return 'Хорошо';
  if (score >= 50) return 'Требует внимания';
  return 'Плохо';
}

function problemClass(problem: Problem) {
  if (problem === 'EXPIRED' || problem === 'NO_CLIENT') return styles.analyticsBadgeDanger;
  if (problem === 'NO_EXPIRATION' || problem === 'EXPIRING_SOON' || problem === 'NO_VIEWS') return styles.analyticsBadgeWarning;
  return styles.analyticsBadgeOrange;
}

function managerHref(managerId: number) {
  return `/admin/wholesale/admin/managers/${managerId}`;
}

function managerAnalyticsHref(managerId: number) {
  return `/admin/wholesale/admin/managers/${managerId}/analytics`;
}

function priceEditHref(price: { id?: number; priceId?: number; managerId?: number | null }) {
  const id = price.id ?? price.priceId;
  const suffix = price.managerId ? `?analyticsManagerId=${price.managerId}` : '';
  return `/admin/wholesale/${id}/edit${suffix}`;
}

function KpiCard({ title, value, text, tone }: { title: string; value: string | number; text: string; tone?: string }) {
  return (
    <article className={`${styles.analyticsKpiCard} ${tone ?? styles.analyticsToneBlue}`}>
      <span>{title}</span>
      <strong>{value}</strong>
      <p>{text}</p>
    </article>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className={styles.mutedText}>{text}</p>;
}

function Badge({ children, tone }: { children: string; tone?: 'danger' | 'warning' | 'orange' }) {
  const className = tone === 'danger' ? styles.analyticsBadgeDanger : tone === 'warning' ? styles.analyticsBadgeWarning : styles.analyticsBadgeOrange;
  return <span className={className}>{children}</span>;
}

function formatHours(value: number | null | undefined) {
  return value === null || value === undefined ? 'Нет данных' : `${value} ч`;
}

function formatChange(value: number | null) {
  if (value === null) return 'новый рост';
  if (value > 0) return `+${value}%`;
  return `${value}%`;
}

function StatusFunnelPanel({ funnel }: { funnel: StatusFunnel }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}>
        <h3>Воронка по статусам</h3>
        <span>{funnel.biggestDrop ? `Провал: ${funnel.biggestDrop.label}` : 'По всем прайсам'}</span>
      </div>
      <div className={styles.analyticsTopList}>
        {funnel.steps.map((step) => (
          <div className={styles.analyticsTopItem} key={step.key}>
            <span>{step.label}</span>
            <span className={styles.analyticsTopViewedAt}>
              {step.conversionFromTotal}% от всех • {step.conversionFromPrevious}% от прошлого
            </span>
            <strong>{step.count}</strong>
          </div>
        ))}
      </div>
      <dl className={styles.analyticsList}>
        <div><dt>Создание → открытие</dt><dd>{formatHours(funnel.averageTimeToOpenHours)}</dd></div>
        <div><dt>Открытие → PDF</dt><dd>{formatHours(funnel.averageTimeToPdfHours)}</dd></div>
        <div><dt>Открытие → заявка</dt><dd>{formatHours(funnel.averageTimeToRequestHours)}</dd></div>
      </dl>
    </article>
  );
}

function PeriodComparisonPanel({ rows }: { rows: PeriodComparison[] }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}>
        <h3>Сравнение периодов</h3>
        <span>Текущий период против прошлого</span>
      </div>
      {rows.length === 0 ? <EmptyState text="Для всего времени сравнение не считается" /> : (
        <div className={styles.analyticsTopList}>
          {rows.map((row) => (
            <div className={styles.analyticsTopItem} key={row.label}>
              <span>{row.label}</span>
              <span className={styles.analyticsTopViewedAt}>прошлый: {row.previous} • {formatChange(row.changePercent)}</span>
              <strong>{row.current}</strong>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

function AttentionPricesTable({ title, rows, routerPush, empty }: { title: string; rows: AttentionPrice[]; routerPush: (href: string) => void; empty: string }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>{title}</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text={empty} /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Прайс</th><th>Клиент</th><th>Менеджер</th><th>Причина</th><th>Статус</th><th>Дней</th><th>Активность клиента</th><th>Просмотры</th><th>PDF</th><th>Заявки</th><th>Действие</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${title}-${row.id}-${row.reason}`}>
                  <td><strong>{row.title}</strong></td>
                  <td>{row.clientName || '—'}</td>
                  <td>{row.managerName || '—'}</td>
                  <td><Badge tone="danger">{row.reason}</Badge></td>
                  <td>{row.workflowStatusLabel}</td>
                  <td>{row.daysInStage}</td>
                  <td>{formatDate(row.lastClientActivityAt)}</td>
                  <td>{row.views}</td>
                  <td>{row.pdfDownloads}</td>
                  <td>{row.requestsSent}</td>
                  <td><button type="button" onClick={() => routerPush(priceEditHref({ priceId: row.id, managerId: row.managerId }))}>Редактировать</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}

function ReactionNeededTable({ rows, routerPush }: { rows: ReactionNeeded[]; routerPush: (href: string) => void }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Клиент проявил интерес, реакции нет</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text="Неотработанных клиентских действий нет" /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Клиент</th><th>Прайс</th><th>Менеджер</th><th>Действие клиента</th><th>Без реакции</th><th>Статус</th><th>Последнее действие менеджера</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={`${row.priceId}-${row.lastClientActivityAt}`}><td>{row.clientName || '—'}</td><td>{row.priceTitle}</td><td>{row.managerName || '—'}</td><td>{eventLabels[row.lastClientEventType] ?? row.lastClientEventType}<br /><span>{formatDate(row.lastClientActivityAt)}</span></td><td>{formatHours(row.hoursWithoutReaction)}</td><td>{row.workflowStatusLabel}</td><td>{formatDate(row.lastManagerActivityAt)}</td><td><button type="button" onClick={() => routerPush(priceEditHref({ priceId: row.priceId, managerId: row.managerId }))}>Открыть</button></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

function PriorityClientsTable({ rows, routerPush }: { rows: PriorityClient[]; routerPush: (href: string) => void }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Клиенты, с которыми связаться сегодня</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text="Приоритетных клиентов пока нет" /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Клиент</th><th>Прайс</th><th>Менеджер</th><th>Приоритет</th><th>Причины</th><th>24 часа</th><th>7 дней</th><th>PDF</th><th>Заявки</th><th>Последняя активность</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={`${row.clientId}-${row.priceId}`}><td>{row.clientName}</td><td>{row.priceTitle}</td><td>{row.managerName || '—'}</td><td><strong>{row.score}</strong></td><td><div className={styles.analyticsBadgesRow}>{row.reasons.map((reason) => <Badge key={reason} tone="orange">{reason}</Badge>)}</div></td><td>{row.viewsLast24Hours}</td><td>{row.viewsLast7Days}</td><td>{row.pdfDownloads}</td><td>{row.requestsSent}</td><td>{formatDate(row.lastActivityAt)}</td><td><button type="button" onClick={() => routerPush(priceEditHref({ priceId: row.priceId, managerId: row.managerId }))}>Открыть</button></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

function ClientHistoryTable({ rows, routerPush }: { rows: ClientHistory[]; routerPush: (href: string) => void }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>История клиентов</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text="История клиентов пока пустая" /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Клиент</th><th>Менеджер</th><th>Прайсов</th><th>Активных</th><th>Актуальных</th><th>Просроченных</th><th>Статусы</th><th>Просмотры</th><th>PDF</th><th>Заявки</th><th>Последняя активность</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.clientId}><td>{row.clientName}</td><td>{row.managerName || '—'}</td><td>{row.priceCount}</td><td>{row.activePrices}</td><td>{row.activeActualPrices}</td><td>{row.expiredPrices}</td><td><div className={styles.analyticsBadgesRow}>{row.statuses.map((status) => <Badge key={status} tone={row.hasActiveActualPrice ? 'orange' : 'warning'}>{status}</Badge>)}</div></td><td>{row.views}</td><td>{row.pdfDownloads}</td><td>{row.requestsSent}</td><td>{formatDate(row.lastActivityAt)}</td><td>{row.managerId ? <button type="button" onClick={() => routerPush(managerAnalyticsHref(row.managerId!))}>Аналитика</button> : '—'}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

function ProductInterestTable({ rows }: { rows: ProductInterest[] }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Товарный интерес</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text="Интерес к товарам пока не зафиксирован" /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Товар</th><th>Открывали</th><th>Меняли количество</th><th>В заявках</th><th>Последняя активность</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={`${row.productId ?? row.productTitle}`}><td>{row.productTitle}</td><td>{row.opens}</td><td>{row.quantityChanges}</td><td>{row.requests}</td><td>{formatDate(row.lastActivityAt)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

function ManagerFunnelQualityTable({ rows, routerPush }: { rows: ManagerRow[]; routerPush: (href: string) => void }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Качество воронки менеджеров</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text="Нет данных" /> : null}
      <div className={styles.analyticsManagerFunnelList}>
        {rows.map((manager) => {
          const metrics = [
            { label: 'Просмотров / активный', value: manager.viewsPerActivePrice ?? 0 },
            { label: 'PDF / активный', value: manager.pdfPerActivePrice ?? 0 },
            { label: 'Заявок / активный', value: manager.requestsPerActivePrice ?? 0 },
            { label: 'Отправлен → открыт', value: `${manager.sentToOpenedConversion ?? 0}%` },
            { label: 'Открыт → PDF', value: `${manager.openedToPdfConversion ?? 0}%` },
            { label: 'Открыт → заявка', value: `${manager.openedToRequestConversion ?? 0}%` },
            { label: 'Застряли', value: `${manager.stuckPriceRate ?? 0}%` },
            { label: 'Подтверждены', value: `${manager.confirmedPriceRate ?? 0}%` },
            { label: 'Средняя реакция', value: formatHours(manager.averageReactionHours) },
          ];

          return (
            <div className={styles.analyticsManagerFunnelCard} key={manager.id}>
              <div className={styles.analyticsManagerFunnelTop}>
                <strong>{manager.name}</strong>
                <button type="button" onClick={() => routerPush(managerAnalyticsHref(manager.id))}>Аналитика</button>
              </div>
              <div className={styles.analyticsManagerFunnelStats}>
                {metrics.map((metric) => (
                  <div key={metric.label}>
                    <span>{metric.label}</span>
                    <strong>{metric.value}</strong>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </article>
  );
}

type AdminWholesaleAnalyticsProps = {
  onTabChange?: (tab: AdminWholesaleAnalyticsTab) => void;
  managerManagementContent?: ReactNode;
};

function AnalyticsExportPanel({
  analytics,
  period,
  managerId,
  format,
  email,
  status,
  busy,
  onManagerChange,
  onFormatChange,
  onEmailChange,
  onDownload,
  onSend,
  downloadDone,
  sendDone,
}: {
  analytics: Analytics;
  period: Period;
  managerId: string;
  format: ExportFormat;
  email: string;
  status: string;
  busy: boolean;
  onManagerChange: (value: string) => void;
  onFormatChange: (value: ExportFormat) => void;
  onEmailChange: (value: string) => void;
  onDownload: () => void;
  onSend: () => void;
  downloadDone: boolean;
  sendDone: boolean;
}) {
  return (
    <div className={styles.analyticsExportPanel}>
      <div className={styles.analyticsExportHeader}>
        <strong>Отчёт</strong>
        <span>Период: {periods.find((item) => item.value === period)?.label ?? '30 дней'}</span>
      </div>
      <div className={styles.analyticsExportGrid}>
        <select aria-label="Менеджер для отчёта" value={managerId} onChange={(event) => onManagerChange(event.target.value)}>
          <option value="all">Все менеджеры</option>
          {analytics.managers.map((manager) => (
            <option key={manager.id} value={manager.id}>{manager.name}</option>
          ))}
        </select>
        <select aria-label="Формат отчёта" value={format} onChange={(event) => onFormatChange(event.target.value === 'xls' ? 'xls' : 'pdf')}>
          <option value="pdf">PDF</option>
          <option value="xls">Excel</option>
        </select>
        <button className={downloadDone ? styles.analyticsExportSuccess : ''} type="button" onClick={onDownload}>
          {downloadDone ? 'Скачано' : 'Скачать'}
        </button>
      </div>
      <div className={styles.analyticsExportMail}>
        <input
          type="email"
          placeholder="Email для отчёта"
          value={email}
          onChange={(event) => onEmailChange(event.target.value)}
        />
        <button className={sendDone ? styles.analyticsExportSuccess : ''} type="button" disabled={busy} onClick={onSend}>
          {busy ? 'Отправка...' : sendDone ? 'Отправлено' : 'Отправить'}
        </button>
      </div>
      {status ? <p className={styles.analyticsExportStatus}>{status}</p> : null}
    </div>
  );
}

export function AdminWholesaleAnalytics({ onTabChange, managerManagementContent }: AdminWholesaleAnalyticsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [period, setPeriod] = useState<Period>('30d');
  const [tab, setTab] = useState<Tab>(() => resolveTab(searchParams.get('tab')));
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [eventTypeFilter, setEventTypeFilter] = useState('');
  const [actorFilter, setActorFilter] = useState('');
  const [managerFilter, setManagerFilter] = useState('');
  const [exportManagerId, setExportManagerId] = useState('all');
  const [exportFormat, setExportFormat] = useState<ExportFormat>('pdf');
  const [exportEmail, setExportEmail] = useState('');
  const [exportStatus, setExportStatus] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const [exportDownloadDone, setExportDownloadDone] = useState(false);
  const [exportSendDone, setExportSendDone] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');

    fetch(`/api/admin/wholesale/analytics?period=${period}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error('Не удалось загрузить общую аналитику');
        return (await res.json()) as Analytics;
      })
      .then((data) => {
        if (!active) return;
        setAnalytics(data);
      })
      .catch((reason) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : 'Не удалось загрузить общую аналитику');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [period]);

  useEffect(() => {
    const nextTab = resolveTab(searchParams.get('tab'));
    setTab((current) => (current === nextTab ? current : nextTab));
    onTabChange?.(nextTab);
  }, [onTabChange, searchParams]);

  const filteredEvents = useMemo(() => {
    const events = analytics?.recentEvents ?? [];
    return events.filter((event) => {
      if (eventTypeFilter && event.eventType !== eventTypeFilter) return false;
      if (actorFilter && event.actorType !== actorFilter) return false;
      if (managerFilter && String(event.managerId ?? '') !== managerFilter) return false;
      return true;
    });
  }, [actorFilter, analytics?.recentEvents, eventTypeFilter, managerFilter]);

  const activeTab = tabs.find((item) => item.value === tab) ?? tabs[0];

  const renderTabContent = () => {
    if (!analytics) return null;

    if (tab === 'overview') return <OverviewTab analytics={analytics} />;
    if (tab === 'managers') return managerManagementContent ?? null;
    if (tab === 'managerRatings') return <ManagerRatingsTab analytics={analytics} routerPush={router.push} />;
    if (tab === 'prices') return <PricesTab analytics={analytics} routerPush={router.push} />;
    if (tab === 'clients') return <ClientsTab analytics={analytics} routerPush={router.push} />;
    if (tab === 'public') return <PublicLinksTab analytics={analytics} routerPush={router.push} />;
    if (tab === 'pdf') return <PdfTab analytics={analytics} routerPush={router.push} />;
    if (tab === 'excel') return <ExcelTab analytics={analytics} routerPush={router.push} />;

    return (
      <EventsTab
        analytics={analytics}
        events={filteredEvents}
        eventTypeFilter={eventTypeFilter}
        actorFilter={actorFilter}
        managerFilter={managerFilter}
        setEventTypeFilter={setEventTypeFilter}
        setActorFilter={setActorFilter}
        setManagerFilter={setManagerFilter}
      />
    );
  };

  const selectTab = (nextTab: Tab) => {
    setTab(nextTab);
    onTabChange?.(nextTab);
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', nextTab);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const exportParams = () => {
    const params = new URLSearchParams({ period, format: exportFormat });
    if (exportManagerId !== 'all') params.set('managerId', exportManagerId);
    return params;
  };

  const downloadAnalytics = () => {
    setExportStatus('');
    setExportDownloadDone(true);
    window.setTimeout(() => setExportDownloadDone(false), 1800);
    window.location.href = `/api/admin/wholesale/analytics/export?${exportParams().toString()}`;
  };

  const sendAnalyticsEmail = async () => {
    const email = exportEmail.trim();
    if (!email) {
      setExportStatus('Укажите email');
      return;
    }

    setExportBusy(true);
    setExportStatus('');
    setExportSendDone(false);
    try {
      const response = await fetch('/api/admin/wholesale/analytics/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period,
          format: exportFormat,
          managerId: exportManagerId,
          email,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Не удалось отправить отчёт');
      setExportStatus('Отчёт отправлен');
      setExportSendDone(true);
      window.setTimeout(() => setExportSendDone(false), 1800);
    } catch (reason) {
      setExportStatus(reason instanceof Error ? reason.message : 'Не удалось отправить отчёт');
    } finally {
      setExportBusy(false);
    }
  };

  return (
    <div className={`${styles.analyticsSection} ${styles.analyticsAdminSection ?? ''}`}>
      <div className={styles.analyticsPanel}>
        <div className={styles.analyticsReportTop}>
          <div className={styles.analyticsPanelHeader}>
            <div>
              <h3>Общая аналитика</h3>
              <span>Все менеджеры, индивидуальные прайсы, просмотры и PDF</span>
            </div>
            {loading ? <span>Обновление данных</span> : null}
          </div>

          {analytics ? (
            <AnalyticsExportPanel
              analytics={analytics}
              period={period}
              managerId={exportManagerId}
              format={exportFormat}
              email={exportEmail}
              status={exportStatus}
              busy={exportBusy}
              onManagerChange={setExportManagerId}
              onFormatChange={setExportFormat}
              onEmailChange={setExportEmail}
              onDownload={downloadAnalytics}
              onSend={sendAnalyticsEmail}
              downloadDone={exportDownloadDone}
              sendDone={exportSendDone}
            />
          ) : null}
        </div>

        <div className={styles.analyticsToolbar}>
          <span>Период</span>
          <div className={styles.analyticsPeriod}>
            {periods.map((item) => (
              <button
                className={period === item.value ? styles.analyticsPeriodActive : styles.secondary}
                key={item.value}
                type="button"
                onClick={() => setPeriod(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {error ? <p className={styles.status}>{error}</p> : null}
        {!analytics && loading ? <EmptyState text="Загружаю общую аналитику" /> : null}

        {analytics ? (
          <div className={styles.analyticsDashboardLayout}>
            <aside className={styles.analyticsSidebar} aria-label="Разделы общей аналитики">
              <div className={styles.analyticsSidebarHeader}>
                <span>Дашборд</span>
                <strong>Разделы</strong>
              </div>
              <nav className={styles.analyticsSideNav}>
                {tabs.map((item) => (
                  <button
                    className={tab === item.value ? styles.analyticsSideNavActive : styles.analyticsSideNavItem}
                    key={item.value}
                    type="button"
                    onClick={() => selectTab(item.value)}
                  >
                    <span>{item.label}</span>
                    <small>{item.description}</small>
                  </button>
                ))}
              </nav>
            </aside>

            <section className={styles.analyticsContent}>
              <div className={styles.analyticsContentHeader}>
                <div>
                  <span>Раздел</span>
                  <h4>{activeTab.label}</h4>
                  <p>{activeTab.description}</p>
                </div>
                {tab === 'managers' || tab === 'managerRatings' ? <strong>{analytics.managers.length} менеджеров</strong> : null}
              </div>
              <div className={styles.analyticsContentBody}>{renderTabContent()}</div>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function OverviewTab({ analytics }: { analytics: Analytics }) {
  const summary = analytics.summary;
  const activity = analytics.managerActivity;

  return (
    <>
      <div className={styles.analyticsKpiGrid}>
        <KpiCard title="Всего прайсов" value={summary.totalPrices} text="Все индивидуальные прайсы" tone={styles.analyticsToneBlue} />
        <KpiCard title="Активные" value={summary.activePrices} text="Доступны по публичной ссылке" tone={styles.analyticsToneGreen} />
        <KpiCard title="Просроченные" value={summary.expiredPrices} text="Срок действия прошёл" tone={styles.analyticsToneRed} />
        <KpiCard title="Проблемные" value={summary.problemPrices} text="Есть ошибки качества" tone={styles.analyticsToneRed} />
        <KpiCard title="Создано за период" value={summary.pricesCreatedInSelectedPeriod} text="По выбранному фильтру" tone={styles.analyticsToneBlue} />
        <KpiCard title="Менеджеры" value={summary.totalManagers} text={`Активных: ${summary.activeManagers}`} tone={styles.analyticsToneGreen} />
        <KpiCard title="Просмотры" value={summary.publicViewsInSelectedPeriod} text={`Всего: ${summary.totalPublicViews}`} tone={styles.analyticsToneViolet} />
        <KpiCard title="PDF" value={summary.pdfDownloadsInSelectedPeriod} text={`Всего: ${summary.totalPdfDownloads}`} tone={styles.analyticsToneBlue} />
        <KpiCard title="Уникальные" value={summary.uniquePublicVisitors} text="Посетители public-ссылок" tone={styles.analyticsToneGreen} />
        <KpiCard title="Клиенты" value={summary.clientsWithActivity} text="Смотрели или скачивали PDF" tone={styles.analyticsToneGreen} />
        <KpiCard title="Качество" value={summary.averageQualityScore} text={qualityLabel(summary.averageQualityScore)} tone={styles.analyticsToneViolet} />
        <KpiCard title="За 30 дней" value={summary.pricesCreatedLast30Days} text="Созданные прайсы" tone={styles.analyticsToneBlue} />
      </div>

      <div className={styles.analyticsKpiGrid}>
        <KpiCard title="Требуют внимания" value={analytics.attention.stuckPrices.length} text="Застряли по статусу или сроку" tone={styles.analyticsToneRed} />
        <KpiCard title="Нет реакции" value={analytics.attention.managerReactionNeeded.length} text="Клиент активен, менеджер не ответил действием" tone={styles.analyticsToneRed} />
        <KpiCard title="Приоритетные клиенты" value={analytics.attention.priorityClients.length} text="С кем нужно связаться сегодня" tone={styles.analyticsToneGreen} />
        <KpiCard title="Главный провал" value={analytics.attention.statusFunnel.biggestDrop?.dropFromPrevious ?? 0} text={analytics.attention.statusFunnel.biggestDrop?.label ?? 'Нет данных'} tone={styles.analyticsToneViolet} />
      </div>

      <div className={styles.analyticsSplit}>
        <StatusFunnelPanel funnel={analytics.attention.statusFunnel} />
        <PeriodComparisonPanel rows={analytics.attention.comparison} />
      </div>

      <div className={styles.analyticsSplit}>
        <article className={styles.analyticsPanel}>
          <div className={styles.analyticsPanelHeader}>
            <h3>Активность менеджеров</h3>
            <span>События админки</span>
          </div>
          <dl className={styles.analyticsList}>
            <div><dt>Действий за 7 дней</dt><dd>{activity.actionsLast7Days}</dd></div>
            <div><dt>Действий за 30 дней</dt><dd>{activity.actionsLast30Days}</dd></div>
            <div><dt>Действий за период</dt><dd>{activity.actionsInSelectedPeriod}</dd></div>
            <div><dt>Входов за период</dt><dd>{activity.loginsInSelectedPeriod}</dd></div>
            <div><dt>Активных дней</dt><dd>{activity.activeDaysInSelectedPeriod}</dd></div>
            <div><dt>Без активности</dt><dd>{activity.inactiveManagersInSelectedPeriod}</dd></div>
            <div><dt>Последний вход</dt><dd>{activity.lastLogin ? `${activity.lastLogin.managerName} • ${formatDate(activity.lastLogin.createdAt)}` : 'Нет данных'}</dd></div>
            <div><dt>Последнее действие</dt><dd>{activity.lastAction ? `${eventLabels[activity.lastAction.eventType] ?? activity.lastAction.eventType} • ${activity.lastAction.managerName} • ${formatDate(activity.lastAction.createdAt)}` : 'Нет данных'}</dd></div>
          </dl>
        </article>

        <article className={styles.analyticsPanel}>
          <div className={styles.analyticsPanelHeader}>
            <h3>Качество прайсов</h3>
            <span>Текущее состояние</span>
          </div>
          <div className={styles.analyticsQualityGrid}>
            <div><span>Среднее позиций</span><strong>{summary.averageItemsPerPrice}</strong></div>
            <div><span>Медиана</span><strong>{summary.medianItemsPerPrice}</strong></div>
            <div><span>Без клиента</span><strong>{summary.pricesWithoutClient}</strong></div>
            <div><span>Без срока</span><strong>{summary.pricesWithoutExpiration}</strong></div>
            <div><span>Пустые</span><strong>{summary.emptyPrices}</strong></div>
            <div><span>Без просмотров</span><strong>{summary.pricesWithoutViews}</strong></div>
            <div><span>Без PDF</span><strong>{summary.pricesWithoutPdfDownloads}</strong></div>
            <div><span>Не обновлялись</span><strong>{summary.stalePrices30Days}</strong></div>
          </div>
        </article>

        <article className={styles.analyticsPanel}>
          <div className={styles.analyticsPanelHeader}>
            <h3>Лидеры и риски</h3>
            <span>По всем менеджерам</span>
          </div>
          <dl className={styles.analyticsList}>
            <div><dt>Лучшее качество</dt><dd>{analytics.priceQuality.bestManager ? `${analytics.priceQuality.bestManager.name} • ${analytics.priceQuality.bestManager.qualityScore}` : 'Нет данных'}</dd></div>
            <div><dt>Требуют внимания</dt><dd>{analytics.priceQuality.managersNeedAttention.length}</dd></div>
            <div><dt>Менеджер по просмотрам</dt><dd>{analytics.publicLinks.topManager ? `${analytics.publicLinks.topManager.managerName} • ${analytics.publicLinks.topManager.views}` : 'Нет данных'}</dd></div>
            <div><dt>Менеджер по PDF</dt><dd>{analytics.pdf.topManager ? `${analytics.pdf.topManager.managerName} • ${analytics.pdf.topManager.downloads}` : 'Нет данных'}</dd></div>
            <div><dt>Самый просматриваемый прайс</dt><dd>{analytics.priceInsights.topViewedPrice ? `${analytics.priceInsights.topViewedPrice.title} • ${analytics.priceInsights.topViewedPrice.views}` : 'Нет данных'}</dd></div>
            <div><dt>Самый большой прайс</dt><dd>{analytics.priceInsights.largestPrice ? `${analytics.priceInsights.largestPrice.title} • ${analytics.priceInsights.largestPrice.itemCount} поз.` : 'Нет данных'}</dd></div>
          </dl>
        </article>
      </div>
    </>
  );
}

function ManagerRatingsTab({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
  return (
    <>
      <article className={styles.analyticsPanel}>
        <div className={styles.analyticsPanelHeader}>
          <h3>Рейтинг менеджеров</h3>
          <span>{analytics.managers.length}</span>
        </div>
        {analytics.managers.length === 0 ? <EmptyState text="Нет данных за выбранный период" /> : null}
        <div className={styles.analyticsManagerRatingList}>
          {analytics.managers.map((manager) => {
            const metrics = [
              { label: 'Прайсов', value: manager.totalPrices },
              { label: 'Активных', value: manager.activePrices },
              { label: 'Просроченных', value: manager.expiredPrices },
              { label: 'Проблемных', value: manager.problemPrices },
              { label: 'Создано', value: manager.pricesCreatedInSelectedPeriod },
              { label: 'Действий', value: manager.actionsInSelectedPeriod },
              { label: 'Просмотров', value: manager.publicViews },
              { label: 'PDF', value: manager.pdfDownloads },
              { label: 'Клиентов', value: manager.clientsWithActivity },
            ];

            return (
              <div className={styles.analyticsManagerRatingCard} key={manager.id}>
                <div className={styles.analyticsManagerRatingTop}>
                  <div className={styles.analyticsManagerRatingName}>
                    <strong>{manager.name}</strong>
                    <div className={styles.analyticsBadgesRow}>
                      <Badge tone={manager.actionsInSelectedPeriod > 0 ? 'orange' : 'warning'}>{manager.actionsInSelectedPeriod > 0 ? 'Активен' : 'Нет активности'}</Badge>
                      {manager.problemPrices > 0 ? <Badge tone="danger">Есть проблемы</Badge> : <Badge tone="orange">Хорошее качество</Badge>}
                    </div>
                  </div>
                  <div className={styles.analyticsManagerRatingContact}>
                    <span>Email</span>
                    <strong>{manager.email || '—'}</strong>
                  </div>
                  <div className={styles.analyticsManagerRatingContact}>
                    <span>Телефон</span>
                    <strong>{manager.phone || '—'}</strong>
                  </div>
                  <div className={styles.analyticsManagerRatingActions}>
                    <button className={styles.secondary} type="button" onClick={() => routerPush(managerHref(manager.id))}>Прайсы</button>
                    <button type="button" onClick={() => routerPush(managerAnalyticsHref(manager.id))}>Аналитика</button>
                  </div>
                </div>
                <div className={styles.analyticsManagerRatingStats}>
                  {metrics.map((metric) => (
                    <div key={metric.label}>
                      <span>{metric.label}</span>
                      <strong>{metric.value}</strong>
                    </div>
                  ))}
                  <div>
                    <span>Качество</span>
                    <strong>{manager.qualityScore}</strong>
                    <small>{qualityLabel(manager.qualityScore)}</small>
                  </div>
                  <div>
                    <span>Последний вход</span>
                    <strong>{formatDate(manager.lastLoginAt)}</strong>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </article>
      <ManagerFunnelQualityTable rows={analytics.managers} routerPush={routerPush} />
    </>
  );
}

function PricesTab({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
  return (
    <>
      <div className={styles.analyticsKpiGrid}>
        <KpiCard title="Всего" value={analytics.summary.totalPrices} text="Все прайсы" />
        <KpiCard title="Отключённые" value={analytics.summary.inactivePrices} text="Сейчас скрыты" tone={styles.analyticsToneViolet} />
        <KpiCard title="Скоро истекают" value={analytics.summary.expiringSoon7Days} text="В ближайшие 7 дней" tone={styles.analyticsToneRed} />
        <KpiCard title="Не обновлялись" value={analytics.summary.stalePrices30Days} text="30+ дней" tone={styles.analyticsToneRed} />
      </div>
      <ProblemPricesTable title="Проблемные прайсы" rows={analytics.problemPrices} routerPush={routerPush} empty="Проблемных прайсов нет" />
      <AttentionPricesTable title="Прайсы, которые застряли" rows={analytics.attention.stuckPrices} routerPush={routerPush} empty="Застрявших прайсов нет" />
      <SimplePricesTable title="Последние созданные прайсы" rows={analytics.priceInsights.latestPrices} routerPush={routerPush} empty="Пока нет прайсов" />
      <SimplePricesTable title="Скоро истекают" rows={analytics.priceInsights.expiringSoonPrices} routerPush={routerPush} empty="Прайсов с истекающим сроком нет" showDays />
      <SimplePricesTable title="Прайсы без просмотров" rows={analytics.priceInsights.pricesWithoutViews} routerPush={routerPush} empty="Прайсов без просмотров нет" />
      <ProblemsByManagerTable analytics={analytics} routerPush={routerPush} />
    </>
  );
}

function ClientsTab({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
  return (
    <>
      <div className={styles.analyticsKpiGrid}>
        <KpiCard title="Клиентов" value={analytics.clients.totalClients} text="Указаны в прайсах" />
        <KpiCard title="С активными прайсами" value={analytics.clients.clientsWithActivePrices} text="Есть активная ссылка" tone={styles.analyticsToneGreen} />
        <KpiCard title="Открывали" value={analytics.clients.clientsWithViews} text="Есть просмотры" tone={styles.analyticsToneGreen} />
        <KpiCard title="Без просмотров" value={analytics.clients.clientsWithoutViews} text="Публичные ссылки не открывали" tone={styles.analyticsToneRed} />
        <KpiCard title="PDF" value={analytics.clients.clientsWithPdfDownloads} text="Скачивали PDF" tone={styles.analyticsToneViolet} />
        <KpiCard title="Горячие" value={analytics.clients.hotClientsCount} text="Высокая активность" tone={styles.analyticsToneRed} />
        <KpiCard title="С просроченным" value={analytics.clients.clientsWithExpiredPrices} text="Есть просроченный прайс" tone={styles.analyticsToneRed} />
        <KpiCard title="Без актуального" value={analytics.clients.clientsWithoutActualActivePrice} text="Нет активного прайса" tone={styles.analyticsToneViolet} />
      </div>
      <ClientsTable title="Горячие клиенты" rows={analytics.clients.hotClients} routerPush={routerPush} empty="Горячих клиентов пока нет" />
      <PriorityClientsTable rows={analytics.attention.priorityClients} routerPush={routerPush} />
      <ReactionNeededTable rows={analytics.attention.managerReactionNeeded} routerPush={routerPush} />
      <ClientHistoryTable rows={analytics.attention.clientHistory} routerPush={routerPush} />
      <ClientsTable title="Клиенты без просмотров" rows={analytics.clients.clientsWithoutViewsList} routerPush={routerPush} empty="Клиентов без просмотров нет" />
      <ClientsTable title="Топ клиентов по активности" rows={analytics.clients.topClientsByActivity} routerPush={routerPush} empty="Нет данных за выбранный период" />
    </>
  );
}

function PublicLinksTab({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
  return (
    <>
      <div className={styles.analyticsKpiGrid}>
        <KpiCard title="Всего открытий" value={analytics.publicLinks.totalViews} text="Все просмотры" />
        <KpiCard title="Уникальные" value={analytics.publicLinks.uniqueVisitors} text="По sessionId" tone={styles.analyticsToneGreen} />
        <KpiCard title="Повторные" value={analytics.publicLinks.repeatViews} text="Повторные открытия" tone={styles.analyticsToneViolet} />
        <KpiCard title="За период" value={analytics.publicLinks.viewsInSelectedPeriod} text={`Последний: ${formatDate(analytics.publicLinks.lastViewAt)}`} />
        <KpiCard title="За 7 дней" value={analytics.publicLinks.viewsLast7Days} text="Открытия ссылок" tone={styles.analyticsToneGreen} />
        <KpiCard title="За 30 дней" value={analytics.publicLinks.viewsLast30Days} text="Открытия ссылок" tone={styles.analyticsToneBlue} />
        <KpiCard title="Без просмотров" value={analytics.publicLinks.pricesWithoutViews} text="Прайсы не открывали" tone={styles.analyticsToneRed} />
        <KpiCard title="Среднее" value={analytics.publicLinks.averageViewsPerPrice} text="Просмотров на прайс" tone={styles.analyticsToneViolet} />
      </div>
      <TopPublicTable analytics={analytics} routerPush={routerPush} />
      <ProductInterestTable rows={analytics.attention.productInterest} />
      <EventsTable title="Последние просмотры" events={analytics.publicLinks.latestViews} empty="Просмотров публичных ссылок пока нет" />
      <SimplePricesTable title="Прайсы без просмотров" rows={analytics.publicLinks.pricesWithoutViewsList} routerPush={routerPush} empty="Прайсов без просмотров нет" />
    </>
  );
}

function PdfTab({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
  return (
    <>
      <div className={styles.analyticsKpiGrid}>
        <KpiCard title="Всего PDF" value={analytics.pdf.totalDownloads} text="Все скачивания" />
        <KpiCard title="За 7 дней" value={analytics.pdf.downloadsLast7Days} text="Недавние скачивания" tone={styles.analyticsToneGreen} />
        <KpiCard title="За 30 дней" value={analytics.pdf.downloadsLast30Days} text="Скачивания PDF" tone={styles.analyticsToneBlue} />
        <KpiCard title="За период" value={analytics.pdf.downloadsInSelectedPeriod} text={`Последний: ${formatDate(analytics.pdf.lastDownloadAt)}`} tone={styles.analyticsToneViolet} />
        <KpiCard title="Уникальные" value={analytics.pdf.uniqueDownloaders} text="Уникальные скачавшие" tone={styles.analyticsToneGreen} />
        <KpiCard title="Прайсов с PDF" value={analytics.pdf.pricesWithDownloads} text="По ним скачивали" />
        <KpiCard title="Без PDF" value={analytics.pdf.pricesWithoutDownloads} text="Прайсы не скачивали" tone={styles.analyticsToneRed} />
        <KpiCard title="Лидер" value={analytics.pdf.topManager?.downloads ?? 0} text={analytics.pdf.topManager?.managerName ?? 'Нет данных'} tone={styles.analyticsToneBlue} />
      </div>
      <TopPdfTable analytics={analytics} routerPush={routerPush} />
      <EventsTable title="Последние скачивания PDF" events={analytics.pdf.latestDownloads} empty="Скачивания PDF пока не зафиксированы" />
      <ManagersPdfTable analytics={analytics} routerPush={routerPush} />
    </>
  );
}

function ExcelTab({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
  return (
    <>
      <div className={styles.analyticsKpiGrid}>
        <KpiCard title="Всего Excel" value={analytics.excel.totalDownloads} text="Все скачивания" />
        <KpiCard title="За 7 дней" value={analytics.excel.downloadsLast7Days} text="Недавние скачивания" tone={styles.analyticsToneGreen} />
        <KpiCard title="За 30 дней" value={analytics.excel.downloadsLast30Days} text="Скачивания Excel" tone={styles.analyticsToneBlue} />
        <KpiCard title="За период" value={analytics.excel.downloadsInSelectedPeriod} text={`Последний: ${formatDate(analytics.excel.lastDownloadAt)}`} tone={styles.analyticsToneViolet} />
        <KpiCard title="Уникальные" value={analytics.excel.uniqueDownloaders} text="Уникальные скачавшие" tone={styles.analyticsToneGreen} />
        <KpiCard title="Прайсов с Excel" value={analytics.excel.pricesWithDownloads} text="По ним скачивали" />
        <KpiCard title="Без Excel" value={analytics.excel.pricesWithoutDownloads} text="Прайсы не скачивали" tone={styles.analyticsToneRed} />
        <KpiCard title="Лидер" value={analytics.excel.topManager?.downloads ?? 0} text={analytics.excel.topManager?.managerName ?? 'Нет данных'} tone={styles.analyticsToneBlue} />
      </div>
      <TopExcelTable analytics={analytics} routerPush={routerPush} />
      <EventsTable title="Последние скачивания Excel" events={analytics.excel.latestDownloads} empty="Скачивания Excel пока не зафиксированы" />
      <ManagersExcelTable analytics={analytics} routerPush={routerPush} />
    </>
  );
}

function EventsTab({
  analytics,
  events,
  eventTypeFilter,
  actorFilter,
  managerFilter,
  setEventTypeFilter,
  setActorFilter,
  setManagerFilter,
}: {
  analytics: Analytics;
  events: AnalyticsEvent[];
  eventTypeFilter: string;
  actorFilter: string;
  managerFilter: string;
  setEventTypeFilter: (value: string) => void;
  setActorFilter: (value: string) => void;
  setManagerFilter: (value: string) => void;
}) {
  const eventTypes = Array.from(new Set((analytics.recentEvents ?? []).map((event) => event.eventType))).sort();

  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}>
        <h3>Журнал событий</h3>
        <span>{events.length}</span>
      </div>
      <div className={styles.analyticsFilters}>
        <select value={managerFilter} onChange={(event) => setManagerFilter(event.target.value)}>
          <option value="">Все менеджеры</option>
          {analytics.managers.map((manager) => (
            <option key={manager.id} value={manager.id}>{manager.name}</option>
          ))}
        </select>
        <select value={eventTypeFilter} onChange={(event) => setEventTypeFilter(event.target.value)}>
          <option value="">Все события</option>
          {eventTypes.map((eventType) => (
            <option key={eventType} value={eventType}>{eventLabels[eventType] ?? eventType}</option>
          ))}
        </select>
        <select value={actorFilter} onChange={(event) => setActorFilter(event.target.value)}>
          <option value="">Все источники</option>
          <option value="admin">Админ</option>
          <option value="manager">Менеджер</option>
          <option value="client">Клиент</option>
          <option value="system">Система</option>
        </select>
      </div>
      <EventsTable title="" events={events} empty="Событий за выбранный период нет" inline />
    </article>
  );
}

function ProblemPricesTable({ title, rows, routerPush, empty }: { title: string; rows: ProblemPrice[]; routerPush: (href: string) => void; empty: string }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>{title}</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text={empty} /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Прайс</th><th>Клиент</th><th>Менеджер</th><th>Проблемы</th><th>Создан</th><th>Обновлён</th><th>Срок</th><th>Просмотры</th><th>PDF</th><th>Действие</th></tr></thead>
            <tbody>
              {rows.map((price) => (
                <tr key={price.id}>
                  <td><strong>{price.title}</strong></td>
                  <td>{price.clientName || '—'}</td>
                  <td>{price.managerName || '—'}</td>
                  <td><div className={styles.analyticsBadgesRow}>{price.problems.map((problem) => <span className={problemClass(problem)} key={problem}>{problemLabels[problem]}</span>)}</div></td>
                  <td>{formatDate(price.createdAt)}</td>
                  <td>{formatDate(price.updatedAt)}</td>
                  <td>{formatDateOnly(price.validUntil)}</td>
                  <td>{price.views ?? 0}</td>
                  <td>{price.pdfDownloads ?? 0}</td>
                  <td><button type="button" onClick={() => routerPush(priceEditHref(price))}>Редактировать</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}

function SimplePricesTable({ title, rows, routerPush, empty, showDays }: { title: string; rows: ProblemPrice[]; routerPush: (href: string) => void; empty: string; showDays?: boolean }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>{title}</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text={empty} /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Прайс</th><th>Клиент</th><th>Менеджер</th><th>Создан</th><th>Активен</th><th>Срок</th>{showDays ? <th>Осталось</th> : null}<th>Действие</th></tr></thead>
            <tbody>{rows.map((price) => <tr key={`${title}-${price.id}`}><td>{price.title}</td><td>{price.clientName || '—'}</td><td>{price.managerName || '—'}</td><td>{formatDate(price.createdAt)}</td><td>{price.isActive ? 'Да' : 'Нет'}</td><td>{formatDateOnly(price.validUntil)}</td>{showDays ? <td>{price.daysLeft ?? '—'}</td> : null}<td><button type="button" onClick={() => routerPush(priceEditHref(price))}>Редактировать</button></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

function ProblemsByManagerTable({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
  const rows = analytics.priceQuality.problemsByManager;
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Проблемы по менеджерам</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text="Проблемных прайсов нет" /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Менеджер</th><th>Пустые</th><th>Без клиента</th><th>Без срока</th><th>Просроченные</th><th>Без просмотров</th><th>Не обновлялись</th><th>Всего</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.managerId}><td>{row.managerName}</td><td>{row.emptyPrices}</td><td>{row.pricesWithoutClient}</td><td>{row.pricesWithoutExpiration}</td><td>{row.expiredPrices}</td><td>{row.pricesWithoutViews}</td><td>{row.stalePrices30Days}</td><td>{row.totalProblems}</td><td><button type="button" onClick={() => routerPush(managerAnalyticsHref(row.managerId))}>Аналитика</button></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

function ClientsTable({ title, rows, routerPush, empty }: { title: string; rows: ClientRow[]; routerPush: (href: string) => void; empty: string }) {
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>{title}</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text={empty} /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Клиент</th><th>Менеджер</th><th>Прайс</th><th>24 часа</th><th>7 дней</th><th>Всего</th><th>PDF</th><th>Последняя активность</th><th>Статус</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={`${title}-${row.clientId}-${row.priceId}`}><td>{row.clientName}</td><td>{row.managerName || '—'}</td><td>{row.priceTitle || '—'}</td><td>{row.viewsLast24Hours}</td><td>{row.viewsLast7Days}</td><td>{row.views}</td><td>{row.pdfDownloads}</td><td>{formatDate(row.lastActivityAt)}</td><td><Badge tone={row.status === 'Горячий' ? 'danger' : row.status === 'Не открывал' ? 'warning' : 'orange'}>{row.status}</Badge></td><td>{row.priceId ? <button type="button" onClick={() => routerPush(priceEditHref({ priceId: row.priceId ?? undefined, managerId: row.managerId ?? undefined }))}>Редактировать</button> : '—'}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

function TopPublicTable({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
  const rows = analytics.publicLinks.topViewedPrices;
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Топ публичных ссылок</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text="Просмотров публичных ссылок пока нет" /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Прайс</th><th>Клиент</th><th>Менеджер</th><th>Просмотры</th><th>Уникальные</th><th>Повторные</th><th>Последний просмотр</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.priceId}><td>{row.title}</td><td>{row.clientName || '—'}</td><td>{row.managerName || '—'}</td><td>{row.views}</td><td>{row.uniqueVisitors}</td><td>{row.repeatViews}</td><td>{formatDate(row.lastViewAt)}</td><td><button type="button" onClick={() => routerPush(priceEditHref(row))}>Редактировать</button></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

function TopPdfTable({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
  const rows = analytics.pdf.topDownloadedPrices;
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Топ прайсов по PDF</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text="Скачивания PDF пока не зафиксированы" /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Прайс</th><th>Клиент</th><th>Менеджер</th><th>PDF</th><th>Уникальные</th><th>Просмотры</th><th>Последний download</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.priceId}><td>{row.title}</td><td>{row.clientName || '—'}</td><td>{row.managerName || '—'}</td><td>{row.downloads}</td><td>{row.uniqueDownloaders}</td><td>{row.views}</td><td>{formatDate(row.lastDownloadAt)}</td><td><button type="button" onClick={() => routerPush(priceEditHref(row))}>Редактировать</button></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

function ManagersPdfTable({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
  const rows = analytics.pdf.managersByDownloads;
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Менеджеры по PDF скачиваниям</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text="Скачивания PDF пока не зафиксированы" /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Менеджер</th><th>Прайсов с PDF</th><th>Всего скачиваний</th><th>Уникальные</th><th>Последний download</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.managerId ?? row.managerName}><td>{row.managerName}</td><td>{row.pricesWithDownloads}</td><td>{row.downloads}</td><td>{row.uniqueDownloaders}</td><td>{formatDate(row.lastDownloadAt)}</td><td>{row.managerId ? <button type="button" onClick={() => routerPush(managerAnalyticsHref(row.managerId!))}>Аналитика</button> : '—'}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

function TopExcelTable({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
  const rows = analytics.excel.topDownloadedPrices;
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Топ прайсов по Excel</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text="Скачивания Excel пока не зафиксированы" /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Прайс</th><th>Клиент</th><th>Менеджер</th><th>Excel</th><th>Уникальные</th><th>Просмотры</th><th>Последний download</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.priceId}><td>{row.title}</td><td>{row.clientName || '—'}</td><td>{row.managerName || '—'}</td><td>{row.downloads}</td><td>{row.uniqueDownloaders}</td><td>{row.views}</td><td>{formatDate(row.lastDownloadAt)}</td><td><button type="button" onClick={() => routerPush(priceEditHref(row))}>Редактировать</button></td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

function ManagersExcelTable({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
  const rows = analytics.excel.managersByDownloads;
  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}><h3>Менеджеры по Excel скачиваниям</h3><span>{rows.length}</span></div>
      {rows.length === 0 ? <EmptyState text="Скачивания Excel пока не зафиксированы" /> : (
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead><tr><th>Менеджер</th><th>Прайсов с Excel</th><th>Всего скачиваний</th><th>Уникальные</th><th>Последний download</th><th>Действие</th></tr></thead>
            <tbody>{rows.map((row) => <tr key={row.managerId ?? row.managerName}><td>{row.managerName}</td><td>{row.pricesWithDownloads}</td><td>{row.downloads}</td><td>{row.uniqueDownloaders}</td><td>{formatDate(row.lastDownloadAt)}</td><td>{row.managerId ? <button type="button" onClick={() => routerPush(managerAnalyticsHref(row.managerId!))}>Аналитика</button> : '—'}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </article>
  );
}

function EventsTable({ title, events, empty, inline }: { title: string; events: AnalyticsEvent[]; empty: string; inline?: boolean }) {
  const content = events.length === 0 ? <EmptyState text={empty} /> : (
    <div className={styles.tableWrap}>
      <table className={styles.adminTable}>
        <thead><tr><th>Дата</th><th>Источник</th><th>Событие</th><th>Менеджер</th><th>Прайс</th><th>Клиент</th><th>Session</th><th>Referer</th><th>Детали</th></tr></thead>
        <tbody>{events.map((event) => <tr key={event.id}><td>{formatDate(event.createdAt)}</td><td>{event.actorType}</td><td>{eventLabels[event.eventType] ?? event.eventType}</td><td>{event.managerName || '—'}</td><td>{event.priceTitle || '—'}</td><td>{event.clientName || '—'}</td><td>{shortValue(event.sessionId)}</td><td>{shortValue(event.referer)}</td><td>{event.details || '—'}</td></tr>)}</tbody>
      </table>
    </div>
  );

  if (inline) return content;
  return <article className={styles.analyticsPanel}><div className={styles.analyticsPanelHeader}><h3>{title}</h3><span>{events.length}</span></div>{content}</article>;
}
