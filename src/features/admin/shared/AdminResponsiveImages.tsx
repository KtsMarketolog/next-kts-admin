'use client';

import { useRef, useState } from 'react';
import styles from '@/app/admin/admin.module.scss';

type ResponsiveImageTarget = 'desktop' | 'tablet' | 'mobile';
export type ResponsiveImageSizes = Partial<Record<ResponsiveImageTarget, string>>;

type AdminResponsiveImagesProps = {
  groupTitle: string;
  imageUrl?: string | null;
  tabletImageUrl?: string | null;
  mobileImageUrl?: string | null;
  imageSizes?: ResponsiveImageSizes;
  uploadLabelPrefix?: string;
  onClear?: (target: ResponsiveImageTarget) => void;
  onUpload?: (target: ResponsiveImageTarget, file: File) => Promise<void> | void;
};

const previews: Array<{ label: string; target: ResponsiveImageTarget; key: 'imageUrl' | 'tabletImageUrl' | 'mobileImageUrl' }> = [
  { label: 'Desktop', target: 'desktop', key: 'imageUrl' },
  { label: 'Tablet', target: 'tablet', key: 'tabletImageUrl' },
  { label: 'Mobile', target: 'mobile', key: 'mobileImageUrl' },
];

export function AdminResponsiveImages({
  groupTitle,
  imageUrl,
  tabletImageUrl,
  mobileImageUrl,
  imageSizes,
  uploadLabelPrefix = 'Добавить/заменить',
  onClear,
  onUpload,
}: AdminResponsiveImagesProps) {
  const urls = { imageUrl, tabletImageUrl, mobileImageUrl };
  const uploading = useRef(false);
  const [busy, setBusy] = useState<ResponsiveImageTarget | null>(null);
  const [error, setError] = useState('');

  return (
    <div className={styles.previewStack}>
      <strong>{groupTitle}</strong>
      {previews.map((preview) => {
        const url = urls[preview.key];

        return (
          <div className={styles.previewItem} key={preview.target}>
            <span className={styles.previewLabel}>
              <span>{preview.label}</span>
              {url && imageSizes?.[preview.target] ? (
                <span className={styles.imageSizePill}>Размер: {imageSizes[preview.target]}</span>
              ) : null}
            </span>
            <div className={styles.preview}>
              {url ? (
                <>
                  <img src={url} alt="" />
                  {onClear && (
                    <button
                      type="button"
                      className={styles.removeImage}
                      disabled={busy !== null}
                      onClick={() => onClear(preview.target)}
                      aria-label={`Удалить ${preview.label}`}
                    >
                      ×
                    </button>
                  )}
                </>
              ) : (
                <span>Не загружено</span>
              )}
            </div>
            {onUpload && (
              <label className={styles.fileInput}>
                {busy === preview.target ? 'Загрузка…' : `${uploadLabelPrefix} для ${preview.target}`}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/avif"
                  disabled={busy !== null}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (!file || uploading.current) return;
                    uploading.current = true;
                    setBusy(preview.target);
                    setError('');
                    try { await onUpload(preview.target, file); }
                    catch (caught) { setError(caught instanceof Error ? caught.message : 'Не удалось загрузить изображение'); }
                    finally { uploading.current = false; setBusy(null); }
                  }}
                />
              </label>
            )}
          </div>
        );
      })}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
