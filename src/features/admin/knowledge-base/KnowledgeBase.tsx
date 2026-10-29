'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useAdminRequestScope } from '@/features/admin/shared/useAdminRequestScope';
import type { KnowledgeBaseList, KnowledgeBaseNode } from '@/shared/lib/knowledgeBase';
import { KnowledgeBaseEditor } from './KnowledgeBaseEditor';
import { KnowledgeBaseDialog } from './KnowledgeBaseDialog';
import { KnowledgeBaseStats } from './KnowledgeBaseStats';
import { KnowledgeBaseMoveDialog } from './KnowledgeBaseMoveDialog';
import { KnowledgeBaseDeleteDialog } from './KnowledgeBaseDeleteDialog';
import { useKnowledgeBaseDrag } from './useKnowledgeBaseDrag';
import { KB_API, kbDate, kbSize, readKbResponse } from './knowledge-base-ui';
import styles from './knowledge-base.module.scss';

type Editor = { node?: KnowledgeBaseNode; upload?: boolean };
export function KnowledgeBase({ initialCanManage, initialParentId = null, initialArchived = false }: { initialCanManage: boolean; initialParentId?: number | null; initialArchived?: boolean }) {
  const [parentId, setParentId] = useState(initialParentId);
  const [tab, setTab] = useState<'materials' | 'statistics'>('materials');
  const [archived, setArchived] = useState(initialCanManage && initialArchived);
  const [search, setSearch] = useState(''), [query, setQuery] = useState('');
  const [pages, setPages] = useState<(number | null)[]>([null]);
  const [data, setData] = useState<KnowledgeBaseList | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [status, setStatus] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [preview, setPreview] = useState<{ node: KnowledgeBaseNode; eventId: string } | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<KnowledgeBaseNode | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeBaseNode | null>(null);
  const [moveTarget, setMoveTarget] = useState<{ node: KnowledgeBaseNode; parentId?: number | null } | null>(null);
  const [busy, setBusy] = useState(false), [archiveError, setArchiveError] = useState('');
  const eventRef = useRef<{ parentId: number | null; eventId: string; sent: boolean } | null>(null);
  const archivePending = useRef(false);
  const { request, isActive } = useAdminRequestScope();
  const canManage = data?.canManage ?? initialCanManage;
  const canMove = canManage && !archived && !loading && !error && !busy && !editor && !preview && !archiveTarget && !deleteTarget && !moveTarget && tab === 'materials';
  const drag = useKnowledgeBaseDrag(!!canMove, (node, targetParentId) => setMoveTarget({ node, parentId: targetParentId }));
  const dropClass = (id: number | null) => drag.valid(id) ? drag.overId === (id ?? 'root') ? styles.dropOver : styles.dropAvailable : '';
  const after = pages.at(-1);
  const currentFolder = data?.breadcrumbs.at(-1);
  const parentFolder = currentFolder?.id === parentId ? data?.breadcrumbs.at(-2) : undefined;
  const firstArchivedAncestor = data?.breadcrumbs.findIndex((node) => !!node.archivedAt) ?? -1;
  const parentIsArchived = firstArchivedAncestor >= 0;
  const activeParentId = firstArchivedAncestor > 0 ? data?.breadcrumbs[firstArchivedAncestor - 1]?.id ?? null : null;
  const backLabel = parentFolder ? `Назад в папку «${parentFolder.title}»` : 'Назад к списку папок';
  const searchLabel = archived ? 'Поиск в архиве текущей папки' : parentId ? 'Поиск в папке и вложенных папках' : 'Поиск по всей Базе знаний';
  useEffect(() => {
    const pop = () => {
      const params = new URLSearchParams(location.search);
      const raw = params.get('folder');
      setParentId(raw && /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null);
      setPages([null]); setQuery(''); setSearch(''); setArchived(initialCanManage && params.get('archived') === '1');
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [initialCanManage]);
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
  const navigate = (id: number | null, archiveView = archived, preserveSearch = false) => {
    setParentId(id); setPages([null]); setArchived(archiveView); setStatus('');
    if (!preserveSearch) { setSearch(''); setQuery(''); }
    const params = new URLSearchParams();
    if (id !== null) params.set('folder', String(id));
    if (archiveView) params.set('archived', '1');
    const queryString = params.toString();
    window.history.pushState(null, '', `/admin/knowledge-base${queryString ? `?${queryString}` : ''}`);
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
      <div className={styles.folderNavigation}>
        {parentId !== null && <button type="button" className={styles.folderBack} disabled={loading}
          aria-label={backLabel} title={backLabel} onClick={() => navigate(parentFolder?.id ?? null)}><span aria-hidden="true">←</span> Назад</button>}
        <nav className={styles.breadcrumbs} aria-label="Путь папки"><button type="button" className={`${styles.text} ${dropClass(null)}`} {...drag.targetProps(null)} onClick={() => navigate(null)}>База знаний</button>
          {data?.breadcrumbs.map((node) => <span key={node.id}> / <button type="button" className={`${styles.text} ${dropClass(node.id)}`} {...drag.targetProps(node.id)} onClick={() => navigate(node.id)}>{node.title}</button></span>)}</nav>
      </div>
      <div className={styles.folderHeader}><div><h2>{archived ? currentFolder ? `Архив / ${currentFolder.title}` : 'Архив' : currentFolder?.title ?? (parentId ? 'Материалы папки' : 'Материалы Базы знаний')}</h2>
        <p className={styles.muted}>{canManage ? 'Папки и файлы доступны сотрудникам только по назначенным правам.' : 'Здесь только материалы, к которым вам предоставлен доступ.'}</p></div>
        {canManage && currentFolder && !archived && <button type="button" onClick={() => setEditor({ node: currentFolder })}>Доступ к папке</button>}</div>
      <div className={styles.toolbar}>
        <form className={styles.search} onSubmit={(event) => { event.preventDefault(); setQuery(search.trim()); setPages([null]); }}>
          <label>{searchLabel}<input type="search" value={search} maxLength={100} onChange={(event) => {
            setSearch(event.target.value);
            if (!event.target.value.trim()) { setQuery(''); setPages([null]); }
          }} /></label><button type="submit">Найти</button>
          {(search || query) && <button type="button" onClick={() => { setSearch(''); setQuery(''); setPages([null]); }}>Сбросить поиск</button>}
        </form>
        <button type="button" disabled={loading} onClick={() => setRefresh((n) => n + 1)}>Обновить</button>
        {canManage && <><button type="button" onClick={() => navigate(archived && parentIsArchived ? activeParentId : parentId, !archived, !parentIsArchived)}>{archived ? 'К материалам' : 'Архив'}</button>
          {!archived && <><button type="button" disabled={loading || !!error} onClick={() => setEditor({})}>Создать папку</button>
            <button type="button" className={styles.primary} disabled={loading || !!error} onClick={() => setEditor({ upload: true })}>Загрузить файл</button></>}
        </>}
      </div>
      {status && <p role="status" className={styles.status}>{status}</p>}
      {loading && <p role="status" className={styles.muted}>Загружаем материалы…</p>}
      {error && <div className={styles.error} role="alert">{error} <button type="button" onClick={() => setRefresh((n) => n + 1)}>Повторить</button></div>}
      {canManage && !archived && <p className={styles.muted}>Для переноса нажмите «Переместить…» или перетащите материал за маркер ⠿ на папку либо раздел пути. Перенос выполняется только после проверки доступа и вашего подтверждения.</p>}
      {canManage && archived && parentIsArchived && <p className={styles.muted}>Это содержимое архивной папки. Для восстановления материалов сначала восстановите родительскую папку. Ненужные материалы можно удалить отдельно, не восстанавливая папку.</p>}
      {data && <><div className={styles.grid}>{data.nodes.map((node) => <article key={node.id}
        {...(node.kind === 'folder' ? drag.targetProps(node.id) : {})}
        className={`${styles.card} ${node.kind === 'folder' ? `${styles.folder} ${dropClass(node.id)}` : ''} ${drag.draggedId === node.id ? styles.dragging : ''}`}>
        <div className={styles.cardTop}>
        {node.kind === 'folder' ? <span className={styles.folderBadge}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          </svg>Папка</span> : <span className={styles.icon} aria-hidden="true">{(node.originalName?.split('.').at(-1) ?? 'ФАЙЛ').toUpperCase().slice(0, 5)}</span>}
        {canManage && !archived && <button type="button" className={styles.dragHandle} draggable={!!canMove} disabled={!canMove}
          aria-label={`Перетащить «${node.title}»`} title="Перетащите в папку или нажмите, чтобы выбрать расположение"
          onDragStart={(event) => drag.start(node, event)} onDragEnd={drag.clear} onClick={() => setMoveTarget({ node })}><span aria-hidden="true">⠿</span></button>}
        </div>
        <h3>{archived || node.kind === 'folder' ? node.title : <button className={`${styles.text} ${styles.cardTitle}`} type="button"
          onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); setPreview({ node, eventId: crypto.randomUUID() }); }}>{node.title}</button>}</h3>
        {query && !archived && node.path && <nav className={styles.searchPath} aria-label={`Расположение «${node.title}»`}>
          <button type="button" className={styles.text} onClick={() => navigate(null)}>База знаний</button>
          {node.path.map((ancestor) => <span key={ancestor.id}><span aria-hidden="true"> / </span>
            <button type="button" className={styles.text} onClick={() => navigate(ancestor.id)}>{ancestor.title}</button></span>)}
        </nav>}
        <div><p className={styles.muted}>{node.kind === 'file' ? `${kbSize(node.size)} · ` : ''}{kbDate(node.updatedAt)} МСК</p>
          {canManage && <span className={styles.badge}>{node.access?.mode === 'inherit' ? 'Доступ как у папки' : 'По списку сотрудников'}</span>}</div>
        <div className={styles.cardActions}>{node.kind === 'folder' && (!archived || canManage) && <button type="button" className={`${styles.primary} ${styles.openFolder}`}
          aria-label={`Открыть папку «${node.title}»`} onClick={() => navigate(node.id)}>Открыть папку <span aria-hidden="true">→</span></button>}
          {!archived && node.kind === 'file' && <button type="button" onClick={() => download(node)}>Скачать</button>}
          {canManage && <>{!archived && <button type="button" onClick={() => setEditor({ node })}>Настроить</button>}
            {!archived && <button type="button" disabled={!canMove} aria-label={`Переместить «${node.title}»`} onClick={() => setMoveTarget({ node })}>Переместить…</button>}
            {(!archived || (!parentIsArchived && !!node.archivedAt)) && <button type="button" onClick={() => { setArchiveError(''); setArchiveTarget(node); }}>{archived ? 'Восстановить' : 'В архив'}</button>}
            {archived && <button type="button" className={styles.danger} aria-label={`Удалить навсегда «${node.title}»`}
              onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); setDeleteTarget(node); }}>Удалить навсегда</button>}</>}
        </div></article>)}</div>
        {data.nodes.length === 0 && <div className={styles.empty}><h3>{query ? 'Ничего не найдено' : archived ? 'Архив пуст' : 'Пока нет доступных материалов'}</h3>
          <p className={styles.muted}>{canManage && !query && !archived ? parentId ? 'Загрузите файл или создайте вложенную папку.' : 'Загрузите файл или создайте папку. Назначьте сотрудникам доступ к материалам.' : 'Измените поиск или уточните доступ у администратора.'}</p></div>}
        {(pages.length > 1 || data.nextCursor) && <div className={styles.pagination}><span>Страница {pages.length}</span><div className={styles.toolbar}>
          <button type="button" disabled={pages.length === 1} onClick={() => setPages((items) => items.slice(0, -1))}>Назад</button>
          <button type="button" disabled={!data.nextCursor} onClick={() => setPages((items) => [...items, data.nextCursor])}>Далее</button></div></div>}
      </>}
      <details className={styles.help}><summary>Как работают доступ и история</summary>
        <p>Управлять материалами и смотреть статистику могут Админ, Админ ТОП и ТОП. Дочерние папки и файлы наследуют доступ родителя; отдельный список сотрудников дополнительно ограничивает его. Права на другие разделы сайта не меняются.</p>
        {canManage && <p>Чтобы изменить расположение, нажмите «Переместить…» или перетащите материал за маркер ⠿ на папку либо раздел пути. Сначала появится предупреждение об изменении доступа, затем нужно подтвердить перенос. Содержимое файлов и история сохраняются.</p>}
        <p>При переносе папки в архив её содержимое недоступно сотрудникам. Файлы, права и история сохраняются; восстановите папку, чтобы вернуть доступ. Автоматического удаления нет.</p>
        {canManage && <p>Удаление навсегда доступно только из архива для Админа, Админа ТОП и ТОП. Перед удалением показывается состав материалов и требуется ввести название. Удалённые файлы и папки нельзя восстановить через сайт; события журнала сохраняются.</p>}
        <p>Регистрируются открытия раздела, папок, файлов и начало скачивания. Они не подтверждают прочтение или фактическое сохранение файла на устройстве.</p>
      </details>
    </>}
    {editor && <KnowledgeBaseEditor node={editor.node} parentId={editor.node ? editor.node.parentId : parentId} upload={editor.upload}
      onClose={() => setEditor(null)} onSaved={saved} />}
    {moveTarget && <KnowledgeBaseMoveDialog node={moveTarget.node} initialTargetParentId={moveTarget.parentId} onClose={() => setMoveTarget(null)}
      onMoved={(message) => { setMoveTarget(null); setStatus(message); setPages([null]); setRefresh((value) => value + 1); }}
      onReload={(message) => { setMoveTarget(null); setStatus(message); setPages([null]); setRefresh((value) => value + 1); }} />}
    {deleteTarget && <KnowledgeBaseDeleteDialog node={deleteTarget} onClose={() => setDeleteTarget(null)}
      onDeleted={(message) => { setDeleteTarget(null); setStatus(message); setPages([null]); setRefresh((value) => value + 1); }}
      onReload={(message) => { setDeleteTarget(null); setStatus(message); setPages([null]); setRefresh((value) => value + 1); }} />}
    {archiveTarget && <KnowledgeBaseDialog title={archiveTarget.archivedAt ? 'Восстановить материал?' : 'Перенести в архив?'} busy={busy} onClose={() => setArchiveTarget(null)}>
      <div className={styles.modalBody}><p>{archiveTarget.title}</p><p className={styles.muted}>{archiveTarget.archivedAt
        ? 'Вернутся прежние права доступа. Содержимое папки будет доступно согласно своим настройкам.'
        : 'Материал и содержимое папки станут недоступны сотрудникам. Файлы, права и история сохранятся. Это действие можно отменить восстановлением.'}</p>
        {archiveError && <p role="alert" className={styles.error}>{archiveError}</p>}
        <div className={styles.actions}><button disabled={busy} type="button" onClick={() => setArchiveTarget(null)}>Отмена</button>
          <button disabled={busy} type="button" className={styles.primary} onClick={() => void archive()}>{busy ? 'Сохраняем…' : archiveTarget.archivedAt ? 'Восстановить' : 'В архив'}</button></div></div>
    </KnowledgeBaseDialog>}
    {preview && <KnowledgeBaseDialog title={preview.node.title} preview fullWidth={preview.node.mimeType === 'text/html'} onClose={() => setPreview(null)}>
      <div className={styles.modalBody}><button type="button" onClick={() => download(preview.node)}>Скачать файл</button>
        {preview.node.mimeType !== 'text/html' && <p className={styles.muted}>Если формат не поддерживает просмотр в браузере, скачайте файл и откройте его на устройстве.</p>}</div>
      {['text/html', 'text/plain', 'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(preview.node.mimeType ?? '') &&
        <iframe title={preview.node.title} className={styles.frame} sandbox={preview.node.mimeType === 'text/html' ? 'allow-scripts' : undefined} referrerPolicy="no-referrer"
          src={`${KB_API}/files/${preview.node.id}?mode=preview&eventId=${preview.eventId}`} />}
    </KnowledgeBaseDialog>}
  </div></main>;
}
