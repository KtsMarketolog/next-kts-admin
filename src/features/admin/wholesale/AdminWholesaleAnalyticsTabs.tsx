import { useEffect, useState } from 'react';

import styles from '@/app/admin/admin.module.scss';

import type { Analytics, AnalyticsEvent, PublicActivityTab } from './AdminWholesaleAnalyticsTypes';
import {
  ClientsTable,
  EventsTable,
  ManagersExcelTable,
  ManagersPdfTable,
  ProblemsByManagerTable,
  ProblemPricesTable,
  SimplePricesTable,
  TopExcelTable,
  TopPdfTable,
  TopPublicTable,
} from './AdminWholesaleAnalyticsTables';
import {
  AttentionPricesTable,
  Badge,
  ClientHistoryTable,
  EVENT_PAGE_SIZE,
  EmptyState,
  KpiCard,
  ManagerFunnelQualityTable,
  PeriodComparisonPanel,
  PriorityClientsTable,
  ReactionNeededTable,
  StatusFunnelPanel,
  aggregateRepeatedEvents,
  eventLabels,
  formatDate,
  formatTimes,
  managerAnalyticsHref,
  managerHref,
  publicActivityTabs,
  qualityLabel,
} from './AdminWholesaleAnalyticsHelpers';

export function OverviewTab({ analytics }: { analytics: Analytics }) {
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

export function ManagerRatingsTab({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
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

export function PricesTab({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
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

export function ClientsTab({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
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

export function PublicActivitySection({
  activeTab,
  analytics,
  onTabChange,
  routerPush,
}: {
  activeTab: PublicActivityTab;
  analytics: Analytics;
  onTabChange: (tab: PublicActivityTab) => void;
  routerPush: (href: string) => void;
}) {
  const content =
    activeTab === 'pdf' ? (
      <PdfTab analytics={analytics} routerPush={routerPush} />
    ) : activeTab === 'excel' ? (
      <ExcelTab analytics={analytics} routerPush={routerPush} />
    ) : (
      <PublicLinksTab analytics={analytics} routerPush={routerPush} />
    );

  return (
    <div className={styles.analyticsNestedTabs}>
      <div className={styles.analyticsTabs} role="tablist" aria-label="Публичная активность">
        {publicActivityTabs.map((item) => (
          <button
            className={activeTab === item.value ? styles.analyticsTabActive : styles.analyticsTab}
            key={item.value}
            type="button"
            role="tab"
            aria-selected={activeTab === item.value}
            onClick={() => onTabChange(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className={styles.analyticsNestedBody}>{content}</div>
    </div>
  );
}

export function PublicLinksTab({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
  const latestViews = aggregateRepeatedEvents(analytics.publicLinks.latestViews, {
    group: 'public_price_view',
    label: (count) => `Клиент открыл прайс ${formatTimes(count)}`,
  });

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
      <EventsTable title="Последние просмотры" events={latestViews} empty="Просмотров публичных ссылок пока нет" />
      <SimplePricesTable title="Прайсы без просмотров" rows={analytics.publicLinks.pricesWithoutViewsList} routerPush={routerPush} empty="Прайсов без просмотров нет" />
    </>
  );
}

export function PdfTab({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
  const latestDownloads = aggregateRepeatedEvents(analytics.pdf.latestDownloads, {
    group: 'public_price_pdf_downloaded',
    label: (count) => `Клиент скачал PDF ${formatTimes(count)}`,
  });

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
      <EventsTable title="Последние скачивания PDF" events={latestDownloads} empty="Скачивания PDF пока не зафиксированы" />
      <ManagersPdfTable analytics={analytics} routerPush={routerPush} />
    </>
  );
}

export function ExcelTab({ analytics, routerPush }: { analytics: Analytics; routerPush: (href: string) => void }) {
  const latestDownloads = aggregateRepeatedEvents(analytics.excel.latestDownloads, {
    group: 'public_price_excel_downloaded',
    label: (count) => `Клиент скачал Excel ${formatTimes(count)}`,
  });

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
      <EventsTable title="Последние скачивания Excel" events={latestDownloads} empty="Скачивания Excel пока не зафиксированы" />
      <ManagersExcelTable analytics={analytics} routerPush={routerPush} />
    </>
  );
}

export function EventsTab({
  analytics,
  events,
  eventTypeFilter,
  actorFilter,
  managerFilter,
  setEventTypeFilter,
  setActorFilter,
  setManagerFilter,
  clearBusy,
  clearStatus,
  onClear,
}: {
  analytics: Analytics;
  events: AnalyticsEvent[];
  eventTypeFilter: string;
  actorFilter: string;
  managerFilter: string;
  setEventTypeFilter: (value: string) => void;
  setActorFilter: (value: string) => void;
  setManagerFilter: (value: string) => void;
  clearBusy: boolean;
  clearStatus: string;
  onClear: () => void;
}) {
  const eventTypes = Array.from(new Set((analytics.recentEvents ?? []).map((event) => event.eventType))).sort();
  const [visibleCount, setVisibleCount] = useState(EVENT_PAGE_SIZE);
  const visibleEvents = events.slice(0, visibleCount);
  const shownCount = Math.min(visibleCount, events.length);
  const canLoadMore = shownCount < events.length;

  useEffect(() => {
    setVisibleCount(EVENT_PAGE_SIZE);
  }, [actorFilter, eventTypeFilter, managerFilter, events.length]);

  return (
    <article className={styles.analyticsPanel}>
      <div className={styles.analyticsPanelHeader}>
        <h3>Журнал событий</h3>
        <div className={styles.analyticsPanelActions}>
          {clearStatus ? <span>{clearStatus}</span> : <span>{events.length}</span>}
          <button className={styles.danger} type="button" disabled={clearBusy || analytics.recentEvents.length === 0} onClick={onClear}>
            {clearBusy ? 'Очистка...' : 'Очистить журнал'}
          </button>
        </div>
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
      <EventsTable title="" events={visibleEvents} empty="Событий за выбранный период нет" inline />
      {events.length > 0 ? (
        <div className={styles.analyticsEventsFooter}>
          <span>Показано {shownCount} из {events.length}</span>
          {canLoadMore ? (
            <button type="button" onClick={() => setVisibleCount((current) => current + EVENT_PAGE_SIZE)}>
              Показать еще 20
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
