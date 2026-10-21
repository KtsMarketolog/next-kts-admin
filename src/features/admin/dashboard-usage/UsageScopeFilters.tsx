'use client';

import { useState } from 'react';
import { dashboardUsageDateBounds } from '@/shared/lib/dashboardUsageFilters';
import { emptyUsagePeriod, usagePeriodLabel, type UsagePeriod, type UsagePerson } from './usage-journal-shared';
import { UsageActorPicker } from './UsageActorPicker';
import { UsageExport } from './UsageExport';
import styles from './dashboard-usage.module.scss';

export function UsageScopeFilters({ period, actor, actorName, onPeriod, onActor, exportUrl }: {
  period: UsagePeriod; actor: string; actorName: string; onPeriod: (period: UsagePeriod) => void;
  onActor: (person: UsagePerson | null) => void; exportUrl: string;
}) {
  const [draft, setDraft] = useState(period), [error, setError] = useState('');
  const dirty = draft.from !== period.from || draft.to !== period.to;
  return <section className={styles.scopeFilters} aria-label="Общие фильтры журнала">
    <form className={styles.filters} onSubmit={event => {
      event.preventDefault();
      try { dashboardUsageDateBounds({ from: draft.from || undefined, to: draft.to || undefined }); setError(''); onPeriod(draft); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Проверьте даты'); }
    }}>
      <label>Дата с (МСК)<input type="date" min="1970-01-01" max="9998-12-31" value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })} /></label>
      <label>Дата по (МСК)<input type="date" min="1970-01-01" max="9998-12-31" value={draft.to} onChange={event => setDraft({ ...draft, to: event.target.value })} /></label>
      <button type="submit">Применить период</button>
      {(draft.from || draft.to) && <button type="button" onClick={() => { setDraft(emptyUsagePeriod); setError(''); onPeriod(emptyUsagePeriod); }}>Сбросить период</button>}
    </form>
    <UsageActorPicker actor={actor} actorName={actorName} onSelect={onActor} />
    <p className={styles.notice}>{usagePeriodLabel(period)}. Конечный день включён полностью. Доступна только сохранившаяся история за последний календарный месяц; более старые события не восстанавливаются.</p>
    {dirty && <p className={styles.notice} role="status">Даты изменены. Нажмите «Применить период» перед выгрузкой.</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    <UsageExport key={exportUrl} url={exportUrl} disabled={dirty} />
  </section>;
}
