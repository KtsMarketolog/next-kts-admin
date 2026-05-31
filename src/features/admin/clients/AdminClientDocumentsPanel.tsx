import type { ChangeEvent, FormEvent } from 'react';

import styles from '@/app/admin/admin.module.scss';
import type { ClientDocument } from '@/shared/lib/db';
import { formatFileSize } from '@/shared/lib/formatFileSize';

import { formatDate } from './AdminClientDetail.helpers';
import { EmptyClientTab } from './AdminClientDetailParts';

type AdminClientDocumentsPanelProps = {
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
};

export function AdminClientDocumentsPanel({
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
}: AdminClientDocumentsPanelProps) {
  return (
    <div className={styles.clientDocumentsPanel}>
      <form className={styles.clientDocumentUploadForm} onSubmit={onUpload}>
        <label>
          <span>Название</span>
          <input
            type="text"
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
            accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.jpg,.jpeg,.png,.webp"
            onChange={onFileChange}
          />
        </label>
        <label className={styles.clientDocumentCheckbox}>
          <input type="checkbox" checked={isVisible} onChange={(event) => onVisibleChange(event.target.checked)} />
          <span>Показать</span>
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Прикрепляем...' : 'Прикрепить документ'}
        </button>
      </form>

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
              <label className={styles.clientDocumentCheckbox}>
                <input
                  type="checkbox"
                  checked={document.isVisible}
                  onChange={(event) => onToggleVisibility(document, event.target.checked)}
                />
                <span>Показать</span>
              </label>
              <a
                className={styles.clientDocumentLink}
                href={`/api/admin/clients/${clientId}/documents/${document.id}/download`}
                target="_blank"
                rel="noreferrer"
              >
                Скачать
              </a>
              <button className={styles.danger} type="button" onClick={() => onDelete(document)}>
                Удалить
              </button>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
