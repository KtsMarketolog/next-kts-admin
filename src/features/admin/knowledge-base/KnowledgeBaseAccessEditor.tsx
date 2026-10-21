'use client';

import { useEffect, useState } from 'react';
import { useAdminRequestScope } from '@/features/admin/shared/useAdminRequestScope';
import { isKnowledgeBaseManagementRole, type KnowledgeBaseAccess, type KnowledgeBaseActor } from '@/shared/lib/knowledgeBase';
import { KB_API, kbRole, readKbResponse } from './knowledge-base-ui';
import styles from './knowledge-base.module.scss';

export function KnowledgeBaseAccessEditor({ value, onChange, isRoot, disabled }: {
  value: KnowledgeBaseAccess; onChange: (value: KnowledgeBaseAccess) => void; isRoot: boolean; disabled: boolean;
}) {
  const { request } = useAdminRequestScope();
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [after, setAfter] = useState<string | null>(null);
  const [actors, setActors] = useState<KnowledgeBaseActor[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (value.mode !== 'custom') return;
    const controller = new AbortController();
    const query = new URLSearchParams();
    if (appliedSearch) query.set('search', appliedSearch);
    if (after) query.set('after', after);
    setLoading(true); setError('');
    void request(`${KB_API}/employees?${query}`, { signal: controller.signal })
      .then(readKbResponse<{ actors: KnowledgeBaseActor[]; nextCursor: string | null }>)
      .then((data) => {
        if (controller.signal.aborted) return;
        setActors((previous) => after ? [...previous, ...data.actors] : data.actors); setNext(data.nextCursor);
      }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить сотрудников'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [request, value.mode, appliedSearch, after, refresh]);
  return <fieldset className={styles.access} disabled={disabled}>
    <legend>Доступ сотрудников</legend>
    <label className={styles.field}>Правило доступа
      <select value={value.mode} onChange={(event) => onChange({ mode: event.target.value as KnowledgeBaseAccess['mode'], actorKeys: event.target.value === 'inherit' ? [] : value.actorKeys })}>
        {!isRoot && <option value="inherit">Как у родительской папки</option>}
        <option value="custom">Выбранные сотрудники</option>
      </select>
    </label>
    <p className={styles.muted}>Админ, Админ ТОП и ТОП всегда имеют доступ. {isRoot
      ? 'Без выбранных сотрудников папку видят только они.'
      : 'Доступ к родительской папке обязателен. Отдельный список ниже может сузить, но не расширить его.'}</p>
    {value.mode === 'custom' && <>
      <div className={styles.toolbar}>
        <label className={styles.field}>Найти сотрудника по ФИО<input type="search" value={search} maxLength={100}
          onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); setAfter(null); setAppliedSearch(search.trim()); setRefresh((n) => n + 1); }
          }} /></label>
        <button type="button" disabled={loading} onClick={() => { setAfter(null); setAppliedSearch(search.trim()); setRefresh((n) => n + 1); }}>Найти</button>
      </div>
      <p className={styles.muted}>Выбрано: {value.actorKeys.length}. Выбор сохраняется при поиске.</p>
      {value.actorKeys.length > 0 && <button type="button" className={styles.text} onClick={() => onChange({ ...value, actorKeys: [] })}>Снять выбор сотрудников</button>}
      {value.actorKeys.length > 0 && <details className={styles.help}><summary>Все выбранные учётные записи</summary>
        <p>Включая записи, которых нет в текущих результатах поиска. Отключённый сотрудник не получает доступ.</p>
        {value.actorKeys.map((key) => <div key={key} className={styles.toolbar}>
          <span>{actors.find((actor) => actor.actorKey === key)?.actorName ?? `Учётная запись ${key}`}</span>
          <button type="button" aria-label={`Убрать доступ ${key}`} onClick={() => onChange({ ...value, actorKeys: value.actorKeys.filter((value) => value !== key) })}>Убрать</button>
        </div>)}
      </details>}
      {error && <div role="alert" className={styles.error}>{error} <button type="button" onClick={() => setRefresh((n) => n + 1)}>Повторить</button></div>}
      <div className={styles.actors} aria-busy={loading}>
        {actors.map((actor) => {
          const manages = isKnowledgeBaseManagementRole(actor.actorRole);
          return <label key={actor.actorKey} className={styles.actor}><input type="checkbox" disabled={manages || disabled}
            checked={manages || value.actorKeys.includes(actor.actorKey)} onChange={(event) => onChange({ ...value,
              actorKeys: event.target.checked ? [...value.actorKeys, actor.actorKey] : value.actorKeys.filter((key) => key !== actor.actorKey) })} />
            <span>{actor.actorName}<small>{kbRole(actor.actorRole)}{manages ? ' · управляет разделом' : ''}</small></span></label>;
        })}
        {!loading && !error && actors.length === 0 && <p className={styles.muted}>Сотрудники не найдены.</p>}
      </div>
      {loading && <p role="status" className={styles.muted}>Загружаем сотрудников…</p>}
      {next && !loading && <button type="button" onClick={() => setAfter(next)}>Ещё сотрудники</button>}
    </>}
  </fieldset>;
}
