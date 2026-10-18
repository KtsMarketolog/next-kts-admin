'use client';

import { useRef, useState } from 'react';
import styles from '@/app/admin/admin.module.scss';

type AdminImagePickerProps = {
  imageUrl?: string | null;
  emptyText?: string;
  uploadLabel?: string;
  accept?: string;
  disabled?: boolean;
  onUpload: (file: File) => Promise<void> | void;
};

export function AdminImagePicker({
  imageUrl,
  emptyText = 'Картинка не загружена',
  uploadLabel = 'Добавить/заменить картинку',
  accept = 'image/png,image/jpeg,image/webp,image/avif',
  disabled = false,
  onUpload,
}: AdminImagePickerProps) {
  const uploading = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className={styles.newsPreview}>
      {imageUrl ? <img src={imageUrl} alt="" /> : <span>{emptyText}</span>}
      <label className={styles.fileInput}>
        {busy ? 'Загрузка…' : uploadLabel}
        <input
          type="file"
          accept={accept}
          disabled={disabled || busy}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file || uploading.current || disabled) return;
            uploading.current = true;
            setBusy(true);
            setError('');
            try { await onUpload(file); }
            catch (caught) { setError(caught instanceof Error ? caught.message : 'Не удалось загрузить изображение'); }
            finally { uploading.current = false; setBusy(false); }
          }}
        />
      </label>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
