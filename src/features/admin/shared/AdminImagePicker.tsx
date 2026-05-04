'use client';

import styles from '@/app/admin/admin.module.scss';

type AdminImagePickerProps = {
  imageUrl?: string | null;
  emptyText?: string;
  uploadLabel?: string;
  accept?: string;
  onUpload: (file: File) => Promise<void> | void;
};

export function AdminImagePicker({
  imageUrl,
  emptyText = 'Картинка не загружена',
  uploadLabel = 'Добавить/заменить картинку',
  accept = 'image/png,image/jpeg,image/webp,image/avif',
  onUpload,
}: AdminImagePickerProps) {
  return (
    <div className={styles.newsPreview}>
      {imageUrl ? <img src={imageUrl} alt="" /> : <span>{emptyText}</span>}
      <label className={styles.fileInput}>
        {uploadLabel}
        <input
          type="file"
          accept={accept}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            await onUpload(file);
          }}
        />
      </label>
    </div>
  );
}
