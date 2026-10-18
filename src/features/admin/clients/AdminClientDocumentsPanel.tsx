import type { ChangeEvent, FormEvent } from 'react';

import styles from '@/app/admin/admin.module.scss';
import type { ClientDocument } from '@/shared/lib/db';
import { formatFileSize } from '@/shared/lib/formatFileSize';

import { formatDate } from './AdminClientDetail.helpers';
import { EmptyClientTab } from './AdminClientDetailParts';

type AdminClientDocumentsPanelProps = {
  readOnly?: boolean;
  busy: boolean;
  clientId: number;
  documents: ClientDocument[];
  fileInputKey: number;
  isVisible: boolean;
  status: string;
  title: string;
  onDelete: (document: ClientDocument) => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onTitleChange: (value: string) => void;
  onToggleVisibility: (document: ClientDocument, isVisible: boolean) => void;
  onUpload: (event: FormEvent<HTMLFormElement>) => void;
  onVisibleChange: (value: boolean) => void;
  onCancel: () => void;
};

export function AdminClientDocumentsPanel({
  readOnly = false,
  busy,
  clientId,
  documents,
  fileInputKey,
  isVisible,
  status,
  title,
  onDelete,
  onFileChange,
  onTitleChange,
  onToggleVisibility,
  onUpload,
  onVisibleChange,
  onCancel,
}: AdminClientDocumentsPanelProps) {
  return (
    <div className={styles.clientDocumentsPanel}>
      {!readOnly ? <form className={styles.clientDocumentUploadForm} onSubmit={onUpload}>
        <label>
          <span>Название</span>
          <input
            type="text"
            disabled={busy}
            value={title}
            onChange={(event) => onTitleChange(event.target.value)}
            placeholder="Название документа"
          />
        </label>
        <label>
          <span>Файл</span>
          <input
            key={fileInputKey}
            type="file"
            disabled={busy}
            accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.jpg,.jpeg,.png,.webp"
            onChange={onFileChange}
          />
        </label>
        <label className={styles.clientDocumentCheckbox}>
          <input type="checkbox" disabled={busy} checked={isVisible} onChange={(event) => onVisibleChange(event.target.checked)} />
          <span>Показать</span>
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Обработка...' : 'Прикрепить документ'}
        </button>
        {busy ? <button type="button" className={styles.secondary} onClick={onCancel}>Отменить ожидание</button> : null}
      </form> : <p className={styles.mutedText}>Документы архивного клиента доступны только для просмотра и скачивания.</p>}

      {status ? <p className={styles.clientDocumentStatus}>{status}</p> : null}

      {documents.length === 0 ? (
        <EmptyClientTab title="Документы пока не добавлены" text="Файлов по клиенту нет." />
      ) : (
        <div className={styles.clientDocumentList}>
          {documents.map((document) => (
            <article className={styles.clientDocumentCard} key={document.id}>
              <div className={styles.clientDocumentInfo}>
                <span>{document.isVisible ? 'Показывается клиенту' : 'Скрыт от клиента'}</span>
                <h3>{document.title || document.originalName}</h3>
                <p>
                  {document.originalName} · {formatFileSize(document.fileSize)} · {formatDate(document.createdAt)}
                </p>
              </div>
              {!readOnly ? <label className={styles.clientDocumentCheckbox}>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={document.isVisible}
                  onChange={(event) => onToggleVisibility(document, event.target.checked)}
                />
                <span>Показать</span>
              </label> : null}
              <a
                className={styles.clientDocumentLink}
                href={`/api/admin/clients/${clientId}/documents/${document.id}/download`}
                target="_blank"
                rel="noreferrer"
              >
                Скачать
              </a>
              {!readOnly ? <button className={styles.danger} type="button" disabled={busy} onClick={() => onDelete(document)}>
                Удалить
              </button> : null}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
