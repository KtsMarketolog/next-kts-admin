'use client';

import { useEffect, useRef, useState } from 'react';
import { useAdminRequestScope } from '@/features/admin/shared/useAdminRequestScope';
import type { KnowledgeBaseList, KnowledgeBaseMovePreview, KnowledgeBaseNode } from '@/shared/lib/knowledgeBase';
import { KnowledgeBaseDialog } from './KnowledgeBaseDialog';
import { KB_API, readKbResponse } from './knowledge-base-ui';
import styles from './knowledge-base.module.scss';

export function KnowledgeBaseMoveDialog({ node, initialTargetParentId, onClose, onMoved, onReload }: {
  node: KnowledgeBaseNode; initialTargetParentId?: number | null; onClose: () => void;
  onMoved: (message: string) => void; onReload: (message: string) => void;
}) {
  const { request, isActive } = useAdminRequestScope();
  const [folderId, setFolderId] = useState(node.parentId);
  const [pages, setPages] = useState<(number | null)[]>([null]);
  const [listing, setListing] = useState<KnowledgeBaseList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [target, setTarget] = useState<{ parentId: number | null } | null>(initialTargetParentId === undefined ? null : { parentId: initialTargetParentId });
  const [preview, setPreview] = useState<KnowledgeBaseMovePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [mustReload, setMustReload] = useState(false);
  const pending = useRef(false);
  const reloadMessage = 'Проверьте расположение материала после обновления списка перед новой попыткой.';
  const after = pages.at(-1);
  useEffect(() => {
    if (target) return;
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (folderId !== null) params.set('parentId', String(folderId));
    if (after) params.set('after', String(after));
    setLoading(true); setError(''); setListing(null);
    void request(`${KB_API}?${params}`, { signal: controller.signal }).then(readKbResponse<KnowledgeBaseList>)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result.canManage) throw new Error('Нет права на перемещение материалов. Обновите страницу.');
        setListing(result);
      })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить папки'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [request, folderId, after, target, refresh]);
  useEffect(() => {
    if (!target) return;
    const controller = new AbortController();
    setBusy(true); setError(''); setPreview(null);
    void request(`${KB_API}/${node.id}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ action: 'preview', expectedRevision: node.revision, targetParentId: target.parentId }) }, { mutation: false })
      .then(async (response) => {
        if (response.status === 409 && !controller.signal.aborted) setMustReload(true);
        return readKbResponse<KnowledgeBaseMovePreview>(response);
      })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result.previewToken || result.source?.id !== node.id || (result.destination?.id ?? null) !== target.parentId) {
          throw new Error('Не удалось проверить место назначения. Перемещение не выполнено.');
        }
        setPreview(result);
      })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось проверить перемещение'); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [request, node.id, node.revision, target]);

  const navigate = (id: number | null) => { if (id !== folderId || pages.length > 1) { setListing(null); setLoading(true); } setFolderId(id); setPages([null]); setError(''); };
  const selfPath = listing?.breadcrumbs.some((folder) => folder.id === node.id) ?? false;
  const currentFolder = listing?.breadcrumbs.at(-1);
  const parentFolder = listing?.breadcrumbs.at(-2);
  const canChoose = !!listing && !loading && !selfPath && folderId !== node.parentId && (folderId !== null || node.kind === 'folder');
  const commit = async () => {
    if (!preview || !target || busy || mustReload || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    let confirmedRejection = false;
    try {
      const response = await request(`${KB_API}/${node.id}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'commit', expectedRevision: node.revision, targetParentId: target.parentId, previewToken: preview.previewToken }) });
      if (!response.ok) {
        confirmedRejection = response.status >= 400 && response.status < 500;
        const details = await response.json().catch(() => null);
        throw new Error(response.status === 409
          ? 'Данные или права доступа изменились. Закройте окно и обновите список, затем выберите перемещение заново для нового подтверждения.'
          : `${typeof details?.error === 'string' ? details.error : 'Сервер не подтвердил перемещение.'} Обновите список и проверьте расположение материала перед повторной попыткой.`);
      }
      const result = await readKbResponse<KnowledgeBaseNode>(response);
      if (result.id !== node.id || result.parentId !== target.parentId) throw new Error('Сервер не подтвердил новое расположение. Обновите список перед повторной попыткой.');
      if (isActive()) onMoved(`«${node.title}» перемещён${node.kind === 'folder' ? 'а' : ''} ${target.parentId === null ? 'в корень Базы знаний' : `в папку «${preview.destination?.title}»`}. Файлы и история сохранены.`);
    } catch (cause) {
      if (!isActive()) return;
      setPreview(null); setMustReload(true);
      setError(`${cause instanceof Error ? cause.message : 'Подтверждение перемещения не получено.'}${confirmedRejection ? '' : ' Изменение могло уже сохраниться; повторно отправлять его без проверки нельзя.'}`);
    } finally { pending.current = false; if (isActive()) setBusy(false); }
  };
  return <KnowledgeBaseDialog title="Переместить материал" busy={busy} onClose={() => mustReload ? onReload(reloadMessage) : onClose()}>
    <div className={styles.modalBody}>
      <p className={styles.moveSource}><strong>{node.title}</strong></p>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {mustReload ? <div className={styles.actions}><button type="button" className={styles.primary}
        onClick={() => onReload(reloadMessage)}>Закрыть и обновить список</button></div>
        : target ? <>
          {busy && <p role="status" className={styles.muted}>{preview ? 'Перемещаем…' : 'Проверяем расположение и права доступа…'}</p>}
          {preview && <>
            <dl className={styles.moveSummary}><dt>Куда</dt><dd>{preview.destinationBreadcrumbs.length
              ? `База знаний / ${preview.destinationBreadcrumbs.map((folder) => folder.title).join(' / ')}` : 'Корень Базы знаний'}</dd>
              <dt>Затронуто материалов</dt><dd>{preview.affectedCount}</dd></dl>
            <div className={styles.moveWarning} role="note"><strong>Проверьте изменение доступа</strong><p>{preview.accessWarning}</p></div>
            <p className={styles.muted}>Содержимое файлов, история и собственные настройки доступа сохраняются. Перемещение выполняется только после подтверждения.</p>
          </>}
          <div className={styles.actions}><button type="button" disabled={busy} onClick={() => { setTarget(null); setPreview(null); setError(''); }}>Выбрать другую папку</button>
            <button type="button" disabled={busy} onClick={onClose}>Отмена</button>
            {preview && <button type="button" className={styles.primary} disabled={busy} onClick={() => void commit()}>Подтвердить перемещение</button>}</div>
        </> : <>
          <p className={styles.muted}>Выберите папку назначения. {node.kind === 'file' ? 'Файл нельзя переместить в корень.' : 'Папку нельзя переместить внутрь самой себя.'}</p>
          <nav className={styles.moveBreadcrumbs} aria-label="Папка назначения"><button type="button" onClick={() => navigate(null)}>В корень</button>
            {folderId !== null && <button type="button" disabled={loading} onClick={() => navigate(parentFolder?.id ?? null)}>На уровень выше</button>}
            <span>{currentFolder?.title ?? (folderId === null ? 'База знаний' : 'Загрузка папки…')}</span></nav>
          {loading && <p role="status" className={styles.muted}>Загружаем папки…</p>}
          {error && <button type="button" onClick={() => setRefresh((value) => value + 1)}>Повторить загрузку папок</button>}
          <div className={styles.moveFolders}>
            {!selfPath && listing?.nodes.filter((folder) => folder.kind === 'folder' && folder.id !== node.id && !folder.archivedAt).map((folder) =>
              <button key={folder.id} type="button" aria-label={`Выбрать расположение внутри «${folder.title}»`} onClick={() => navigate(folder.id)}><span aria-hidden="true">▸</span>{folder.title}</button>)}
            {!loading && listing && (selfPath || !listing.nodes.some((folder) => folder.kind === 'folder' && folder.id !== node.id && !folder.archivedAt)) && <p className={styles.muted}>Нет вложенных папок для выбора.</p>}
          </div>
          {(pages.length > 1 || listing?.nextCursor) && <div className={styles.movePagination}>
            <button type="button" disabled={loading || pages.length === 1} onClick={() => setPages((values) => values.slice(0, -1))}>Предыдущие папки</button>
            <button type="button" disabled={loading || !listing?.nextCursor} onClick={() => setPages((values) => [...values, listing?.nextCursor ?? null])}>Следующие папки</button></div>}
          {folderId === node.parentId && <p className={styles.muted}>Материал уже находится здесь. Выберите другое расположение.</p>}
          <div className={styles.actions}><button type="button" onClick={onClose}>Отмена</button><button type="button" className={styles.primary}
            disabled={!canChoose} onClick={() => setTarget({ parentId: folderId })}>Переместить сюда</button></div>
        </>}
    </div>
  </KnowledgeBaseDialog>;
}
