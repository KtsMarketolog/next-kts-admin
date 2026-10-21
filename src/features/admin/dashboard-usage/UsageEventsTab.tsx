import { Fragment, useEffect, useRef } from 'react';
import { DASHBOARD_USAGE_ACTIONS, DASHBOARD_USAGE_LABELS } from '@/shared/lib/dashboardUsage';
import type { DashboardUsageRow } from '@/shared/lib/db/dashboardUsageRepo';
import { emptyEventFilters, eventLabel, firstPage, formatDay, formatTime, roleLabels, usagePeriodLabel, usageUrl, type UsagePeriod, type EventFilters, type UsagePagePosition, type UsageSelection } from './usage-journal-shared';
import { useUsagePage } from './useUsagePage';
import { UsagePagination } from './UsagePagination';
import styles from './dashboard-usage.module.scss';

export type EventsViewState = { filter: EventFilters; pages: UsagePagePosition };
export function UsageEventsTab({ state, period, onChange, onSelect }: {
  state: EventsViewState; onChange: (state: EventsViewState) => void; onSelect: (selection: UsageSelection) => void;
  period: UsagePeriod;
}) {
  const { filter, pages } = state;
  const { data, error, busy, reload } = useUsagePage<{ events: DashboardUsageRow[]; nextCursor: string | null }>(
    usageUrl({ ...period, actor: filter.actor, dashboard: filter.dashboard, action: filter.action, preview: filter.preview ? '1' : '' }, pages, 'before'),
    'Не удалось загрузить журнал');
  const tableRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (tableRef.current) tableRef.current.scrollTop = 0; }, [pages, filter]);
  const changeFilter = (patch: Partial<EventFilters>) => onChange({ filter: { ...filter, ...patch }, pages: firstPage() });
  return <section aria-labelledby="usage-events-heading">
    <div className={styles.sectionHeader}><div><h2 id="usage-events-heading">События</h2>
      <p className={styles.notice}>Сначала новые записи. Нажмите «Подробнее», чтобы увидеть файл, режим и детализацию счёта.</p></div>
      <span className={styles.period}>{usagePeriodLabel(period)}</span></div>
    <div className={styles.filters}>
      <label>Действие<select value={filter.action} onChange={(event) => changeFilter({ action: event.target.value })}>
        <option value="">Все действия</option>{DASHBOARD_USAGE_ACTIONS.map((action) => <option key={action} value={action}>{DASHBOARD_USAGE_LABELS[action]}</option>)}
      </select></label>
      <label className={styles.checkbox}><input type="checkbox" checked={filter.preview} onChange={(event) => changeFilter({ preview: event.target.checked })} />Включить предпросмотры и архив</label>
      <button type="button" onClick={() => { onChange({ filter: { ...emptyEventFilters }, pages: firstPage() }); if (!Object.values(filter).some(Boolean) && pages.length === 1) reload(); }}>Сбросить фильтры</button>
      <button type="button" disabled={busy} onClick={() => pages.length > 1 ? onChange({ ...state, pages: firstPage() }) : reload()}>Обновить</button>
    </div>
    {(filter.actor || filter.dashboard) && <div className={styles.chips} aria-label="Выбранные фильтры">
      {filter.actor && <button type="button" onClick={() => changeFilter({ actor: '', actorName: '' })} aria-label="Убрать фильтр сотрудника">{filter.actorName || filter.actor} <span aria-hidden="true">×</span></button>}
      {filter.dashboard && <button type="button" onClick={() => changeFilter({ dashboard: '', dashboardName: '' })} aria-label="Убрать фильтр дашборда">{filter.dashboardName || filter.dashboard} <span aria-hidden="true">×</span></button>}
    </div>}
    <p className={styles.notice}>Сотрудника можно выбрать сверху или через его карточку; дашборд — нажатием на название. Интервалы просмотра показываются только при выборе «Время видимого отчёта».</p>
    {error && <div className={styles.error} role="alert">{error} <button type="button" onClick={reload}>Повторить</button></div>}
    {busy && <p className={styles.empty} role="status">Загружаем журнал…</p>}
    {data && <div ref={tableRef} className={styles.table} tabIndex={0} role="region" aria-label="Таблица событий"><table className={styles.eventsTable}>
      <thead><tr><th>Время, МСК</th><th>Сотрудник</th><th>Дашборд</th><th>Действие</th><th><span className={styles.srOnly}>Подробности</span></th></tr></thead>
      <tbody>{data.events.map((row, index) => <Fragment key={row.id}>
        {(index === 0 || formatDay(data.events[index - 1].createdAt) !== formatDay(row.createdAt)) && <tr className={styles.dayGroup}><th colSpan={5} scope="rowgroup">{formatDay(row.createdAt)}</th></tr>}
        <tr>
          <td className={styles.time}>{formatTime(row.createdAt)}</td>
          <td><button type="button" className={styles.textButton} onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); onSelect({ kind: 'employee', person: row }); }}>{row.actorName}</button><small>{roleLabels[row.actorRole] ?? row.actorRole}</small></td>
          <td><button type="button" className={styles.textButton} onClick={() => changeFilter({ dashboard: row.dashboardKey, dashboardName: row.dashboardTitle })}>{row.dashboardTitle}</button></td>
          <td><span className={row.upload || row.hasProfitabilityDetails ? styles.fileBadge : styles.badge}>{eventLabel(row)}</span>
            {row.upload && <small className={styles.fileName} title={row.upload.name}>{row.upload.name}</small>}
            {row.preview && <small>Предпросмотр / архив</small>}</td>
          <td><button type="button" className={styles.detailButton} onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); onSelect({ kind: 'event', event: row }); }}>Подробнее<span className={styles.srOnly}>: {row.actorName}, {formatTime(row.createdAt)}</span></button></td>
        </tr>
      </Fragment>)}</tbody></table></div>}
    {data && !data.events.length && <p className={styles.empty}>Событий по выбранным фильтрам нет.</p>}
    <UsagePagination pages={pages} nextCursor={data?.nextCursor} busy={busy} count={data?.events.length}
      onChange={(next) => onChange({ ...state, pages: next })} />
  </section>;
}
