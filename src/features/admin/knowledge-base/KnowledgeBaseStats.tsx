'use client';

import { useEffect, useState } from 'react';
import { useAdminRequestScope } from '@/features/admin/shared/useAdminRequestScope';
import type { KnowledgeBaseStatsPage } from '@/shared/lib/knowledgeBase';
import { KB_API, kbDate, kbRole, readKbResponse } from './knowledge-base-ui';
import styles from './knowledge-base.module.scss';

type Filter = { actorKey?: string; nodeId?: number; title: string };
export function KnowledgeBaseStats() {
  const [view, setView] = useState<'employees' | 'materials'>('employees');
  const [filter, setFilter] = useState<Filter | null>(null);
  const [search, setSearch] = useState(''), [query, setQuery] = useState('');
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const [data, setData] = useState<KnowledgeBaseStatsPage | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const { request } = useAdminRequestScope();
  const after = pages.at(-1);
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ view });
    if (after) params.set('after', after);
    if (query) params.set('search', query);
    if (filter?.actorKey) params.set('actorKey', filter.actorKey);
    if (filter?.nodeId) params.set('nodeId', String(filter.nodeId));
    setLoading(true); setError(''); setData(null);
    void request(`${KB_API}/usage?${params}`, { signal: controller.signal }).then(readKbResponse<KnowledgeBaseStatsPage>)
      .then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить статистику'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [request, view, after, query, filter, refresh]);
  const reset = () => { setFilter(null); setSearch(''); setQuery(''); setPages([null]); };
  return <section aria-label="Статистика Базы знаний">
    <div className={styles.folderHeader}><div><h2>Использование Базы знаний</h2>
      <p className={styles.muted}>За всё время с подключения раздела. Время показано по Москве.</p></div></div>
    <p className={styles.muted}>Открытия раздела, папок и файлов считаются отдельно. Скачивание означает начало выдачи файла, а не подтверждение его сохранения. Счётчики не доказывают прочтение документа или ознакомление с регламентом.</p>
    <div className={styles.toolbar}>
      <label className={styles.field}>Группировать<select value={view} onChange={(event) => { setView(event.target.value as typeof view); reset(); }}>
        <option value="employees">По сотрудникам</option><option value="materials">По материалам и папкам</option>
      </select></label>
      <form className={styles.search} onSubmit={(event) => { event.preventDefault(); setQuery(search.trim()); setPages([null]); }}>
        <label>Поиск<input type="search" value={search} maxLength={100} onChange={(event) => setSearch(event.target.value)} /></label><button type="submit">Найти</button>
      </form><button type="button" disabled={loading} onClick={() => setRefresh((n) => n + 1)}>Обновить</button>
    </div>
    {filter && <div className={styles.toolbar}><span>Выбрано: {filter.title}</span><button type="button" onClick={reset}>Сбросить фильтр</button></div>}
    {loading && <p role="status" className={styles.muted}>Загружаем статистику…</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {data && <>
      <div className={styles.table}><table><thead><tr><th scope="col">{view === 'employees' ? 'Сотрудник' : 'Материал / папка'}</th>
        <th scope="col">Входы в раздел</th><th scope="col">Открытия папок</th><th scope="col">Открытия файлов</th><th scope="col">Скачивания</th><th scope="col">Последнее событие, МСК</th>
      </tr></thead><tbody>{data.rows.map((row) => <tr key={row.key}><td>
        <button type="button" className={styles.text} onClick={() => {
          if (view === 'employees') { setFilter({ actorKey: row.key, title: row.title }); setView('materials'); }
          else if (/^[1-9]\d*$/.test(row.key)) { setFilter({ nodeId: Number(row.key), title: row.title }); setView('employees'); }
          else return;
          setSearch(''); setQuery(''); setPages([null]);
        }}>{row.title}</button>{row.role && <p className={styles.muted}>{kbRole(row.role)}</p>}
      </td><td>{row.sectionOpens}</td><td>{row.folderOpens}</td><td>{row.fileViews}</td><td>{row.downloadsStarted}</td><td>{kbDate(row.lastVisitAt)}</td></tr>)}</tbody></table></div>
      {data.rows.length === 0 && <p className={styles.empty}>События по этому запросу пока не зарегистрированы.</p>}
      <div className={styles.pagination}><span>Страница {pages.length}</span><div className={styles.toolbar}>
        <button type="button" disabled={pages.length === 1} onClick={() => setPages((items) => items.slice(0, -1))}>Назад</button>
        <button type="button" disabled={!data.nextCursor} onClick={() => setPages((items) => [...items, data.nextCursor])}>Далее</button></div></div>
    </>}
  </section>;
}
