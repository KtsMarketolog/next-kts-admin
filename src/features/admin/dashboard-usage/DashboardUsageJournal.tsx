'use client';

import Link from 'next/link';
import { useRef, useState, type KeyboardEvent } from 'react';
import { UsageActivityTab, type ActivityViewState } from './UsageActivityTab';
import { UsageEventsTab, type EventsViewState } from './UsageEventsTab';
import { UsageDetailsDrawer } from './UsageDetailsDrawer';
import { emptyEventFilters, firstPage, type UsageSelection } from './usage-journal-shared';
import styles from './dashboard-usage.module.scss';

type Tab = 'activity' | 'events';
export function DashboardUsageJournal() {
  const [tab, setTab] = useState<Tab>('activity');
  const [activity, setActivity] = useState<ActivityViewState>({ search: '', draft: '', pages: firstPage() });
  const [events, setEvents] = useState<EventsViewState>({ filter: { ...emptyEventFilters }, pages: firstPage() });
  const [selection, setSelection] = useState<UsageSelection | null>(null);
  const activityTab = useRef<HTMLButtonElement>(null), eventsTab = useRef<HTMLButtonElement>(null);
  const switchTab = (next: Tab, focus = false) => {
    setTab(next);
    if (focus) (next === 'activity' ? activityTab : eventsTab).current?.focus({ preventScroll: true });
  };
  const tabKeys = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    switchTab(event.key === 'Home' ? 'activity' : event.key === 'End' ? 'events' : tab === 'activity' ? 'events' : 'activity', true);
  };
  return <main className={styles.page}>
    <div className={`${styles.root} ${styles.controls}`}>
      <header className={styles.header}>
        <div><p className={styles.eyebrow}>Панель управления</p><h1>Журнал и сотрудники</h1>
          <p className={styles.notice}>Обзор сотрудников и история использования дашбордов за последний месяц.</p></div>
        <nav className={styles.navigation} aria-label="Навигация журнала">
          <Link className={styles.backLink} href="/admin">← В админку</Link>
          <Link className={styles.backLink} href="/admin/top">К отчётам</Link>
        </nav>
      </header>
      <details className={styles.help}>
        <summary>Как читать журнал</summary>
        <div>
          <p>Доступен администратору, Админ ТОП и ТОП. Записываются открытия и поддерживаемые действия, без значений фильтров и паролей. Фоновые обновления не считаются действиями сотрудника. Время — регистрация события сервером: при проблемах сети запись может поступить позже.</p>
          <p>Для успешных загрузок сохраняются имя и размер файла, без его содержимого. Только для подключённой «Рентабельности счетов» дополнительно сохраняются номер, номенклатура, количество, сумма и исходная валюта успешно загруженного счёта. Сами файлы не сохраняются в журнале.</p>
          <p>Время просмотра — сколько отчёт был виден в открытой вкладке, а не оценка работы сотрудника. На парном экране общий итог не удваивается; по каждому отчёту показан его собственный видимый интервал. «—» означает, что время не зафиксировано, а не что сотрудник не работал. Прошлую длительность восстановить нельзя.</p>
          <p>События внутри HTML передаются его адаптером и не подтверждают производительность сотрудника. Экспорт означает подготовку файла, а не подтверждение сохранения на устройстве. История начинается с подключения журнала.</p>
          <p>Срок хранения — один календарный месяц назад от текущего времени МСК. Просроченные записи скрыты и удаляются отдельным серверным заданием; история снимков и права на отчёты от этого не меняются. Данные загружаются по 50 записей. Сотрудники расположены в постоянном порядке учётных записей, события — от новых к старым.</p>
        </div>
      </details>
      <div className={styles.tabBar} role="tablist" aria-label="Разделы журнала">
        <button ref={activityTab} id="usage-activity-tab" type="button" role="tab" aria-selected={tab === 'activity'} aria-controls="usage-activity-panel"
          tabIndex={tab === 'activity' ? 0 : -1} onKeyDown={tabKeys} onClick={() => switchTab('activity')}>Активность сотрудников</button>
        <button ref={eventsTab} id="usage-events-tab" type="button" role="tab" aria-selected={tab === 'events'} aria-controls="usage-events-panel"
          tabIndex={tab === 'events' ? 0 : -1} onKeyDown={tabKeys} onClick={() => switchTab('events')}>События</button>
      </div>
      <div id="usage-activity-panel" role="tabpanel" aria-labelledby="usage-activity-tab" hidden={tab !== 'activity'}>
        {tab === 'activity' && <UsageActivityTab state={activity} onChange={setActivity} onSelect={(employee) => setSelection({ kind: 'employee', person: employee, summary: employee })} />}
      </div>
      <div id="usage-events-panel" role="tabpanel" aria-labelledby="usage-events-tab" hidden={tab !== 'events'}>
        {tab === 'events' && <UsageEventsTab state={events} onChange={setEvents} onSelect={setSelection} />}
      </div>
      {selection && <UsageDetailsDrawer key={selection.kind === 'employee' ? selection.person.actorKey : selection.event.id} selection={selection}
        onClose={() => setSelection(null)} onViewEvents={(person, dashboard) => {
          setEvents({ filter: { ...emptyEventFilters, actor: person.actorKey, actorName: person.actorName,
            dashboard: dashboard?.key ?? '', dashboardName: dashboard?.title ?? '' }, pages: firstPage() });
          setSelection(null); switchTab('events');
          // The originating row may be unmounted after switching tabs; focus the destination tab instead.
          requestAnimationFrame(() => eventsTab.current?.focus({ preventScroll: true }));
        }} />}
    </div>
  </main>;
}
