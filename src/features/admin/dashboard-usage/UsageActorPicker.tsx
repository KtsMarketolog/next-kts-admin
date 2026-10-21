'use client';

import { useRef, useState } from 'react';
import { firstPage, roleLabels, usageUrl, type UsagePerson } from './usage-journal-shared';
import { useUsagePage } from './useUsagePage';
import { UsagePagination } from './UsagePagination';
import styles from './dashboard-usage.module.scss';

function ActorOptions({ onSelect }: { onSelect: (person: UsagePerson) => void }) {
  const [search, setSearch] = useState(''), [draft, setDraft] = useState('');
  const [pages, setPages] = useState(firstPage);
  const { data, error, busy, reload } = useUsagePage<{ actors: UsagePerson[]; nextCursor: string | null }>(
    usageUrl({ view: 'actors', search }, pages), 'Не удалось загрузить список сотрудников');
  return <div className={styles.actorOptions}>
    <form className={styles.filters} onSubmit={event => { event.preventDefault(); setSearch(draft.trim()); setPages(firstPage()); }}>
      <label>Поиск сотрудника<input type="search" maxLength={100} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Имя сотрудника" /></label>
      <button type="submit">Искать</button>
    </form>
    <p className={styles.notice}>Действующие сотрудники и сотрудники с сохранённой историей. Код помогает различать одинаковые имена.</p>
    {busy && <p role="status">Загружаем сотрудников…</p>}
    {error && <div className={styles.error} role="alert">{error} <button type="button" onClick={reload}>Повторить</button></div>}
    {data && <ul className={styles.actorList} aria-label="Результаты поиска сотрудника">{data.actors.map(person => <li key={person.actorKey}>
      <button type="button" onClick={() => onSelect(person)}>{person.actorName}<small>{roleLabels[person.actorRole] ?? person.actorRole} · {person.actorKey}</small></button>
    </li>)}</ul>}
    {data && !data.actors.length && <p>Сотрудники не найдены.</p>}
    <UsagePagination pages={pages} nextCursor={data?.nextCursor} count={data?.actors.length} busy={busy} onChange={setPages} />
  </div>;
}

/** Fetch the bounded roster only while the picker is open; never send login/email/password fields. */
export function UsageActorPicker({ actor, actorName, onSelect }: {
  actor: string; actorName: string; onSelect: (person: UsagePerson | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const details = useRef<HTMLDetailsElement>(null), trigger = useRef<HTMLElement>(null);
  return <div className={styles.actorPicker}>
    <details ref={details} onToggle={event => setOpen(event.currentTarget.open)} onKeyDown={event => {
      if (event.key === 'Escape' && details.current?.open) { event.preventDefault(); details.current.open = false; trigger.current?.focus(); }
    }}>
      <summary ref={trigger}>Сотрудник: {actor ? (actorName || actor) : 'Все сотрудники'} <span aria-hidden="true">▾</span></summary>
      {open && <ActorOptions onSelect={person => { onSelect(person); if (details.current) details.current.open = false; trigger.current?.focus(); }} />}
    </details>
    {actor && <button type="button" onClick={() => onSelect(null)}>Все сотрудники</button>}
  </div>;
}
