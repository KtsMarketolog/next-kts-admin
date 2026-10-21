'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useAdminRequestScope } from '@/features/admin/shared/useAdminRequestScope';
import type { KnowledgeBaseList, KnowledgeBaseNode } from '@/shared/lib/knowledgeBase';
import { KnowledgeBaseEditor } from './KnowledgeBaseEditor';
import { KnowledgeBaseDialog } from './KnowledgeBaseDialog';
import { KnowledgeBaseStats } from './KnowledgeBaseStats';
import { KB_API, kbDate, kbSize, readKbResponse } from './knowledge-base-ui';
import styles from './knowledge-base.module.scss';

type Editor = { node?: KnowledgeBaseNode; upload?: boolean };
export function KnowledgeBase({ initialCanManage, initialParentId = null }: { initialCanManage: boolean; initialParentId?: number | null }) {
  const [parentId, setParentId] = useState(initialParentId);
  const [tab, setTab] = useState<'materials' | 'statistics'>('materials');
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState(''), [query, setQuery] = useState('');
  const [pages, setPages] = useState<(number | null)[]>([null]);
  const [data, setData] = useState<KnowledgeBaseList | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [status, setStatus] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [preview, setPreview] = useState<{ node: KnowledgeBaseNode; eventId: string } | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<KnowledgeBaseNode | null>(null);
  const [busy, setBusy] = useState(false), [archiveError, setArchiveError] = useState('');
  const eventRef = useRef<{ parentId: number | null; eventId: string; sent: boolean } | null>(null);
  const archivePending = useRef(false);
  const { request, isActive } = useAdminRequestScope();
  const canManage = data?.canManage ?? initialCanManage;
  const after = pages.at(-1);
  const currentFolder = data?.breadcrumbs.at(-1);
  useEffect(() => {
    const pop = () => {
      const raw = new URLSearchParams(location.search).get('folder');
      setParentId(raw && /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null);
      setPages([null]); setQuery(''); setSearch(''); setArchived(false);
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    if (tab !== 'materials') return;
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (parentId) params.set('parentId', String(parentId));
    if (after) params.set('after', String(after));
    if (query) params.set('search', query);
    if (archived) params.set('archived', '1');
    setLoading(true); setError(''); setData(null);
    void request(`${KB_API}?${params}`, { signal: controller.signal }).then(readKbResponse<KnowledgeBaseList>)
      .then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить материалы'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [request, tab, parentId, after, query, archived, refresh]);
  useEffect(() => {
    if (!data || archived || tab !== 'materials') return;
    if (!eventRef.current || eventRef.current.parentId !== parentId) eventRef.current = { parentId, eventId: crypto.randomUUID(), sent: false };
    const entry = eventRef.current;
    if (entry.sent) return;
    entry.sent = true;
    // Same event ID on retry; a failed telemetry write never makes a file inaccessible.
    let alive = true;
    void request(`${KB_API}/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: entry.eventId, nodeId: parentId, action: parentId ? 'folder_open' : 'section_open' }) })
      .then((response) => { if (!response.ok) throw new Error('Не удалось записать посещение'); })
      .catch(() => { entry.sent = false; if (alive) setStatus('Материалы доступны, но посещение пока не записано в статистику. Можно повторить через «Обновить».'); });
    return () => { alive = false; };
  }, [data, archived, tab, parentId, request]);
  const navigate = (id: number | null) => {
    setParentId(id); setPages([null]); setSearch(''); setQuery(''); setArchived(false); setStatus('');
    window.history.pushState(null, '', id ? `/admin/knowledge-base?folder=${id}` : '/admin/knowledge-base');
  };
  const saved = (message: string) => { setEditor(null); setStatus(message); setPages([null]); setRefresh((n) => n + 1); };
  const download = (node: KnowledgeBaseNode) => {
    const link = document.createElement('a');
    link.href = `${KB_API}/files/${node.id}?mode=download&eventId=${crypto.randomUUID()}`;
    link.rel = 'noopener'; link.target = '_blank'; document.body.appendChild(link); link.click(); link.remove();
  };
  const archive = async () => {
    if (!archiveTarget || archivePending.current) return;
    archivePending.current = true; setBusy(true); setArchiveError('');
    try {
      await request(`${KB_API}/${archiveTarget.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: archiveTarget.revision, archived: !archiveTarget.archivedAt }) }).then(readKbResponse);
      if (!isActive()) return;
      setArchiveTarget(null); setStatus(archiveTarget.archivedAt ? 'Материал восстановлен.' : 'Материал перенесён в архив. Файлы и история сохранены.'); setRefresh((n) => n + 1);
    } catch (cause) { if (isActive()) setArchiveError(cause instanceof Error ? cause.message : 'Не удалось изменить архив'); }
    finally { archivePending.current = false; if (isActive()) setBusy(false); }
  };
  return <main className={styles.page}><div className={`${styles.root} ${styles.controls}`}>
    <header className={styles.header}><div><p className={styles.eyebrow}>Личный кабинет сотрудника</p><h1>База знаний</h1>
      <p className={styles.muted}>Инструкции, положения и регламенты — в одном месте.</p></div><nav aria-label="Навигация Базы знаний">
      <Link className={styles.link} href="/admin">Вернуться в панель управления</Link><Link className={styles.link} href="/admin/top">К отчётам</Link></nav></header>
    {canManage && <div className={styles.tabs} aria-label="Разделы Базы знаний">
      <button type="button" aria-pressed={tab === 'materials'} onClick={() => setTab('materials')}>Материалы</button>
      <button type="button" aria-pressed={tab === 'statistics'} onClick={() => setTab('statistics')}>Статистика использования</button>
    </div>}
    {tab === 'statistics' && canManage ? <KnowledgeBaseStats /> : <>
      <nav className={styles.breadcrumbs} aria-label="Путь папки"><button type="button" className={styles.text} onClick={() => navigate(null)}>База знаний</button>
        {data?.breadcrumbs.map((node) => <span key={node.id}> / <button type="button" className={styles.text} onClick={() => navigate(node.id)}>{node.title}</button></span>)}</nav>
      <div className={styles.folderHeader}><div><h2>{archived ? 'Архив' : currentFolder?.title ?? (parentId ? 'Материалы папки' : 'Папки Базы знаний')}</h2>
        <p className={styles.muted}>{canManage ? 'Папки и файлы доступны сотрудникам только по назначенным правам.' : 'Здесь только материалы, к которым вам предоставлен доступ.'}</p></div>
        {canManage && currentFolder && !archived && <button type="button" onClick={() => setEditor({ node: currentFolder })}>Доступ к папке</button>}</div>
      <div className={styles.toolbar}>
        <form className={styles.search} onSubmit={(event) => { event.preventDefault(); setQuery(search.trim()); setPages([null]); }}>
          <label>Поиск в текущей папке<input type="search" value={search} maxLength={100} onChange={(event) => setSearch(event.target.value)} /></label><button type="submit">Найти</button>
        </form>
        <button type="button" disabled={loading} onClick={() => setRefresh((n) => n + 1)}>Обновить</button>
        {canManage && <><button type="button" onClick={() => { setArchived(!archived); setPages([null]); }}>{archived ? 'К материалам' : 'Архив'}</button>
          {!archived && <><button type="button" disabled={loading || !!error} onClick={() => setEditor({})}>Создать папку</button>
            {parentId && <button type="button" className={styles.primary} disabled={loading || !!error} onClick={() => setEditor({ upload: true })}>Загрузить файл</button>}</>}
        </>}
      </div>
      {status && <p role="status" className={styles.status}>{status}</p>}
      {loading && <p role="status" className={styles.muted}>Загружаем материалы…</p>}
      {error && <div className={styles.error} role="alert">{error} <button type="button" onClick={() => setRefresh((n) => n + 1)}>Повторить</button></div>}
      {data && <><div className={styles.grid}>{data.nodes.map((node) => <article key={node.id} className={`${styles.card} ${node.kind === 'folder' ? styles.folder : ''}`}>
        <span className={styles.icon} aria-hidden="true">{node.kind === 'folder' ? 'ПАПКА' : (node.originalName?.split('.').at(-1) ?? 'ФАЙЛ').toUpperCase().slice(0, 5)}</span>
        <h3>{archived ? node.title : <button className={`${styles.text} ${styles.cardTitle}`} type="button" onClick={() => node.kind === 'folder'
          ? navigate(node.id) : setPreview({ node, eventId: crypto.randomUUID() })}>{node.title}</button>}</h3>
        <div><p className={styles.muted}>{node.kind === 'file' ? `${kbSize(node.size)} · ` : ''}{kbDate(node.updatedAt)} МСК</p>
          {canManage && <span className={styles.badge}>{node.access?.mode === 'inherit' ? 'Доступ как у папки' : `Выбрано сотрудников: ${node.access?.actorKeys.length ?? 0}`}</span>}</div>
        <div className={styles.cardActions}>{!archived && node.kind === 'file' && <button type="button" onClick={() => download(node)}>Скачать</button>}
          {canManage && <>{!archived && <button type="button" onClick={() => setEditor({ node })}>Настроить</button>}
            <button type="button" onClick={() => { setArchiveError(''); setArchiveTarget(node); }}>{archived ? 'Восстановить' : 'В архив'}</button></>}
        </div></article>)}</div>
        {data.nodes.length === 0 && <div className={styles.empty}><h3>{query ? 'Ничего не найдено' : archived ? 'Архив пуст' : 'Пока нет доступных материалов'}</h3>
          <p className={styles.muted}>{canManage && !query && !archived ? parentId ? 'Загрузите файл или создайте вложенную папку.' : 'Создайте папку, назначьте сотрудников и добавьте файлы.' : 'Измените поиск или уточните доступ у администратора.'}</p></div>}
        {(pages.length > 1 || data.nextCursor) && <div className={styles.pagination}><span>Страница {pages.length}</span><div className={styles.toolbar}>
          <button type="button" disabled={pages.length === 1} onClick={() => setPages((items) => items.slice(0, -1))}>Назад</button>
          <button type="button" disabled={!data.nextCursor} onClick={() => setPages((items) => [...items, data.nextCursor])}>Далее</button></div></div>}
      </>}
      <details className={styles.help}><summary>Как работают доступ и история</summary>
        <p>Управлять материалами и смотреть статистику могут Админ и Админ ТОП. Дочерние папки и файлы наследуют доступ родителя; отдельный список сотрудников дополнительно ограничивает его. Права на другие разделы сайта не меняются.</p>
        <p>При переносе папки в архив её содержимое недоступно сотрудникам. Файлы, права и история сохраняются; восстановите папку, чтобы вернуть доступ. Автоматического удаления нет.</p>
        <p>Регистрируются открытия раздела, папок, файлов и начало скачивания. Они не подтверждают прочтение или фактическое сохранение файла на устройстве.</p>
      </details>
    </>}
    {editor && <KnowledgeBaseEditor node={editor.node} parentId={editor.node ? editor.node.parentId : parentId} upload={editor.upload}
      onClose={() => setEditor(null)} onSaved={saved} />}
    {archiveTarget && <KnowledgeBaseDialog title={archiveTarget.archivedAt ? 'Восстановить материал?' : 'Перенести в архив?'} busy={busy} onClose={() => setArchiveTarget(null)}>
      <div className={styles.modalBody}><p>{archiveTarget.title}</p><p className={styles.muted}>{archiveTarget.archivedAt
        ? 'Вернутся прежние права доступа. Содержимое папки будет доступно согласно своим настройкам.'
        : 'Материал и содержимое папки станут недоступны сотрудникам. Файлы, права и история сохранятся. Это действие можно отменить восстановлением.'}</p>
        {archiveError && <p role="alert" className={styles.error}>{archiveError}</p>}
        <div className={styles.actions}><button disabled={busy} type="button" onClick={() => setArchiveTarget(null)}>Отмена</button>
          <button disabled={busy} type="button" className={styles.primary} onClick={() => void archive()}>{busy ? 'Сохраняем…' : archiveTarget.archivedAt ? 'Восстановить' : 'В архив'}</button></div></div>
    </KnowledgeBaseDialog>}
    {preview && <KnowledgeBaseDialog title={preview.node.title} preview onClose={() => setPreview(null)}>
      <div className={styles.modalBody}><button type="button" onClick={() => download(preview.node)}>Скачать файл</button>
        <p className={styles.muted}>Если формат не поддерживает просмотр в браузере, скачайте файл и откройте его на устройстве.</p></div>
      {['text/html', 'text/plain', 'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(preview.node.mimeType ?? '') &&
        <iframe title={preview.node.title} className={styles.frame} sandbox={preview.node.mimeType === 'text/html' ? 'allow-scripts' : undefined} referrerPolicy="no-referrer"
          src={`${KB_API}/files/${preview.node.id}?mode=preview&eventId=${preview.eventId}`} />}
    </KnowledgeBaseDialog>}
  </div></main>;
}
