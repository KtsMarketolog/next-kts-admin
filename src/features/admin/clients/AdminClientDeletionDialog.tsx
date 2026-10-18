'use client';

import { useEffect, useRef, useState } from 'react';
import styles from '@/app/admin/admin.module.scss';
import { formatFileSize } from '@/shared/lib/formatFileSize';
import type { ClientDeletionPreview } from './AdminClientsModel';

type Props = {
  preview: ClientDeletionPreview;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: (confirmationTitle: string) => void;
};

export function AdminClientDeletionDialog({ preview, busy, error, onCancel, onConfirm }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [confirmationTitle, setConfirmationTitle] = useState('');
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    inputRef.current?.focus();
    return () => { dialog?.close(); };
  }, []);
  const { counts } = preview;
  return (
    <dialog ref={dialogRef} aria-labelledby="client-deletion-title" aria-describedby="client-deletion-warning"
      style={{ width: 'min(640px, calc(100vw - 32px))', maxHeight: '90vh', overflow: 'auto', border: '1px solid #d8d3e8', borderRadius: 16, padding: 24 }}
      onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
      <h2 id="client-deletion-title">Удалить клиента навсегда?</h2>
      <p id="client-deletion-warning">Клиент «{preview.title}» уже в архиве. Это действие необратимо: восстановить компанию, доступ и удалённую историю из архива будет нельзя.</p>
      <ul>
        <li>Учётные записи и пароли: {counts.users}; сессии: {counts.sessions}; коды входа: {counts.twoFactorChallenges}.</li>
        <li>Сообщения: {counts.chatMessages}; записи о прочтении: {counts.chatReadStates}.</li>
        <li>Документы: {counts.documents}; файлы: {counts.files} ({formatFileSize(counts.fileBytes)}).</li>
        <li>Заявки клиента: {counts.priceRequests}.</li>
      </ul>
      <p><strong>Прайсы ({counts.priceLists}), их товары и публичные ссылки не удаляются.</strong> Привязки прайсов к клиенту будут сняты. Ссылки останутся действующими, если их не отключили заранее.</p>
      <p>Файлы документов будут поставлены в очередь контролируемой очистки. Физическое удаление выполняется отдельно после проверки администратором; до этого файлы остаются на диске. Другие файлы не затрагиваются.</p>
      <p className={styles.mutedText}>Состав показан на момент проверки. Если после неё поступили новые заявки, сообщения или другие изменения, удаление будет отменено. Закройте это окно и выполните проверку заново.</p>
      <form onSubmit={(event) => { event.preventDefault(); if (!busy && confirmationTitle === preview.title) onConfirm(confirmationTitle); }}>
        <label style={{ display: 'grid', gap: 8, margin: '16px 0' }}>
          <span>Для подтверждения введите точное название компании: <strong>{preview.title}</strong></span>
          <input ref={inputRef} aria-label="Название компании для безвозвратного удаления" value={confirmationTitle} disabled={busy}
            onChange={(event) => setConfirmationTitle(event.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        {error ? <p role="alert" className={styles.status}>{error}</p> : null}
        <div className={styles.clientCompanyActions}>
          <button type="button" className={styles.secondary} disabled={busy} onClick={onCancel}>Отмена</button>
          <button type="submit" className={styles.danger} disabled={busy || confirmationTitle !== preview.title}>{busy ? 'Удаляем...' : 'Удалить навсегда'}</button>
        </div>
      </form>
    </dialog>
  );
}
