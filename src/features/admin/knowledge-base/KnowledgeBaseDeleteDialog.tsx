'use client';

import { useEffect, useRef, useState } from 'react';
import { useAdminRequestScope } from '@/features/admin/shared/useAdminRequestScope';
import type { KnowledgeBaseNode } from '@/shared/lib/knowledgeBase';
import type { KnowledgeBaseDeletePreview, KnowledgeBaseDeleteResult } from '@/shared/lib/knowledgeBaseDeletion';
import { KnowledgeBaseDialog } from './KnowledgeBaseDialog';
import { KB_API, kbSize, readKbResponse } from './knowledge-base-ui';
import styles from './knowledge-base.module.scss';

export function KnowledgeBaseDeleteDialog({ node, onClose, onDeleted, onReload }: {
  node: KnowledgeBaseNode; onClose: () => void; onDeleted: (message: string) => void; onReload: (message: string) => void;
}) {
  const { request, isActive } = useAdminRequestScope();
  const [preview, setPreview] = useState<KnowledgeBaseDeletePreview | null>(null);
  const [confirmationTitle, setConfirmationTitle] = useState('');
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [mustReload, setMustReload] = useState(false);
  const pending = useRef(false), operationId = useRef<string | null>(null);
  const reloadMessage = 'Список обновлён. Проверьте состояние материала перед новой попыткой удаления.';
  useEffect(() => {
    const controller = new AbortController();
    void request(`${KB_API}/${node.id}/delete`, { method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'preview', expectedRevision: node.revision }) }, { mutation: false })
      .then(readKbResponse<KnowledgeBaseDeletePreview>)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result.previewToken || result.source?.id !== node.id || result.source.revision !== node.revision
          || !Number.isSafeInteger(result.affectedCount) || result.affectedCount < 1
          || !Number.isSafeInteger(result.fileCount) || result.fileCount < 0
          || !Number.isSafeInteger(result.folderCount) || result.folderCount < 0
          || result.fileCount + result.folderCount !== result.affectedCount
          || !Number.isSafeInteger(result.totalBytes) || result.totalBytes < 0) {
          throw new Error('Не удалось проверить состав удаляемых материалов. Удаление не выполнено.');
        }
        setPreview(result);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : 'Не удалось проверить удаление.'); setMustReload(true);
      })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [request, node.id, node.revision]);
  const commit = async () => {
    if (!preview || busy || mustReload || pending.current || confirmationTitle !== preview.source.title) return;
    pending.current = true; setBusy(true); setError('');
    operationId.current ??= crypto.randomUUID();
    let confirmedRejection = false;
    try {
      const response = await request(`${KB_API}/${node.id}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'commit', expectedRevision: node.revision, previewToken: preview.previewToken, confirmationTitle, operationId: operationId.current }) });
      if (!response.ok) {
        confirmedRejection = response.status >= 400 && response.status < 500;
        const details = await response.json().catch(() => null);
        throw new Error(response.status === 409
          ? 'Состав материалов или права доступа изменились. Обновите список и проверьте удаление заново.'
          : typeof details?.error === 'string' ? details.error : 'Сервер не подтвердил удаление.');
      }
      const result = await readKbResponse<KnowledgeBaseDeleteResult>(response);
      if (!result.deleted || result.nodeId !== node.id) throw new Error('Не получено подтверждение удаления выбранного материала.');
      if (isActive()) onDeleted(`«${preview.source.title}» ${node.kind === 'folder' ? 'удалена вместе с содержимым' : 'удалён'}. Через сайт восстановить нельзя.${result.cleanupPending ? ' Очистка файлов в хранилище ещё не завершена.' : ''}`);
    } catch (cause) {
      if (!isActive()) return;
      setPreview(null); setMustReload(true);
      setError(`${cause instanceof Error ? cause.message : 'Подтверждение удаления не получено.'}${confirmedRejection ? '' : ' Удаление могло уже выполниться. Повторно отправлять его без проверки нельзя.'}`);
    } finally { pending.current = false; if (isActive()) setBusy(false); }
  };
  return <KnowledgeBaseDialog title="Удалить из архива навсегда" busy={busy} onClose={() => mustReload ? onReload(reloadMessage) : onClose()}>
    <div className={styles.modalBody}>
      <p className={styles.moveSource}><strong>{node.title}</strong></p>
      {busy && <p role="status" className={styles.muted}>{preview ? 'Удаляем материалы…' : 'Проверяем состав материалов и права доступа…'}</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {preview && <>
        <dl className={styles.moveSummary}>
          <dt>Всего материалов</dt><dd>{preview.affectedCount}</dd>
          <dt>Папок, включая вложенные</dt><dd>{preview.folderCount}</dd>
          <dt>Файлов, включая вложенные</dt><dd>{preview.fileCount}</dd>
          <dt>Общий размер файлов</dt><dd>{preview.totalBytes < 1024 ? `${preview.totalBytes} байт` : kbSize(preview.totalBytes)}</dd>
        </dl>
        <div role="note" className={styles.deleteWarning}><strong>Удаление без восстановления через сайт</strong>
          <p>{node.kind === 'folder' ? 'Будут удалены эта папка и всё её содержимое, включая вложенные папки и файлы.' : 'Будет удалён этот файл.'} Это не перенос в архив. События журнала сохранятся.</p></div>
        <label>Для подтверждения введите название «{preview.source.title}»
          <input type="text" autoComplete="off" spellCheck={false} value={confirmationTitle} disabled={busy}
            onChange={(event) => setConfirmationTitle(event.target.value)} /></label>
      </>}
      <div className={styles.actions}>{mustReload
        ? <button type="button" className={styles.primary} onClick={() => onReload(reloadMessage)}>Закрыть и обновить список</button>
        : <><button type="button" disabled={busy} onClick={onClose}>Отмена</button>
          {preview && <button type="button" className={styles.danger} disabled={busy || confirmationTitle !== preview.source.title}
            onClick={() => void commit()}>Удалить навсегда</button>}</>}
      </div>
    </div>
  </KnowledgeBaseDialog>;
}
