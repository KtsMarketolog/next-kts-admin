import { useEffect, useRef } from 'react';
import type { DashboardUsageEmployee, DashboardUsageSummary } from '@/shared/lib/db/dashboardUsageRepo';
import { firstPage, formatDuration, formatTimestamp, roleLabels, usagePeriodLabel, usageUrl, type UsagePeriod, type UsagePagePosition } from './usage-journal-shared';
import { useUsagePage } from './useUsagePage';
import { UsagePagination } from './UsagePagination';
import styles from './dashboard-usage.module.scss';

export type ActivityViewState = { search: string; draft: string; pages: UsagePagePosition };
export function UsageActivityTab({ state, period, actor, onChange, onSelect }: {
  state: ActivityViewState; onChange: (state: ActivityViewState) => void;
  period: UsagePeriod; actor: string;
  onSelect: (employee: DashboardUsageEmployee) => void;
}) {
  const { data, busy, error, reload } = useUsagePage<DashboardUsageSummary>(
    usageUrl({ view: 'employees', search: state.search, ...period, actor }, state.pages), 'Не удалось загрузить сводку');
  const tableRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (tableRef.current) tableRef.current.scrollTop = 0; }, [state.pages, state.search]);
  const refresh = () => { if (state.pages.length > 1) onChange({ ...state, pages: firstPage() }); else reload(); };
  return <section aria-labelledby="usage-employees-heading">
    <div className={styles.sectionHeader}><div><h2 id="usage-employees-heading">Последняя активность сотрудников</h2>
      <p className={styles.notice}>{actor ? 'Выбранный сотрудник, включая сохранённую историю отключённых учётных записей.' : 'Все действующие сотрудники.'} Нажмите на имя, чтобы посмотреть отчёты и действия.</p></div>
      <span className={styles.period}>{usagePeriodLabel(period)}</span></div>
    <form className={styles.filters} onSubmit={(event) => {
      event.preventDefault(); const search = state.draft.trim();
      if (search === state.search && state.pages.length === 1) reload();
      else onChange({ ...state, search, pages: firstPage() });
    }}>
      <label>Сотрудник<input type="search" maxLength={100} value={state.draft}
        onChange={(event) => onChange({ ...state, draft: event.target.value })} placeholder="Поиск по имени" /></label>
      <button type="submit" disabled={busy}>Найти</button>
      {state.search && <button type="button" onClick={() => onChange({ draft: '', search: '', pages: firstPage() })}>Сбросить поиск</button>}
      <button type="button" disabled={busy} onClick={refresh}>Обновить сводку</button>
    </form>
    {data && <p className={styles.period}>Данные сформированы: {formatTimestamp(data.generatedAt)} МСК</p>}
    {error && <div className={styles.error} role="alert">{error} <button type="button" onClick={reload}>Повторить</button></div>}
    {busy && <p className={styles.empty} role="status">Загружаем сводку…</p>}
    {data && <div className={styles.table} ref={tableRef} tabIndex={0} role="region" aria-label="Таблица активности сотрудников"><table className={styles.activityTable}>
      <thead><tr><th>Сотрудник</th><th>Последнее открытие, МСК</th><th>Действие сотрудника, МСК</th><th>Отчёты</th><th>Действия</th><th>Файлы</th><th>Время просмотра</th></tr></thead>
      <tbody>{data.employees.map((employee) => <tr key={employee.actorKey}>
        <td><button className={styles.textButton} type="button" onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); onSelect(employee); }}>{employee.actorName}</button>
          <small>{roleLabels[employee.actorRole] ?? employee.actorRole}</small></td>
        <td>{formatTimestamp(employee.lastOpenedAt)}{!employee.lastUsedAt && <small>Нет зафиксированного использования</small>}</td>
        <td>{formatTimestamp(employee.lastInteractionAt)}</td>
        <td className={styles.number}>{employee.reportCount}</td><td className={styles.number}>{employee.interactionCount}</td>
        <td className={styles.number}>{employee.uploadCount ?? 0}</td>
        <td className={styles.duration}>{employee.viewingSeconds > 0 ? formatDuration(employee.viewingSeconds) : <span title="Время просмотра за этот период не зафиксировано">—</span>}</td>
      </tr>)}</tbody></table></div>}
    {data && !data.employees.length && <p className={styles.empty}>Сотрудники не найдены. Измените поиск.</p>}
    <UsagePagination pages={state.pages} nextCursor={data?.nextCursor} busy={busy} count={data?.employees.length}
      onChange={(pages) => onChange({ ...state, pages })} />
    <p className={styles.notice}>Время просмотра — время видимого отчёта, не оценка работы сотрудника. «—» означает, что время не зафиксировано. Предпросмотры и архив в сводку не входят.</p>
  </section>;
}
