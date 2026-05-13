'use client';

import styles from '@/app/admin/admin.module.scss';
import { AdminImagePicker } from '@/features/admin/shared/AdminImagePicker';
import type { PriceGroupImage } from '@/features/admin/types';

type AdminPriceGroupsSectionProps = {
  priceGroups: PriceGroupImage[];
  savedPriceGroupTitle: string | null;
  busy: boolean;
  updatePriceGroup: (title: string, patch: Partial<PriceGroupImage>) => void;
  savePriceGroup: (group: PriceGroupImage) => Promise<void>;
  uploadImage: (file: File) => Promise<string>;
  showStatus: (message: string) => void;
};

const priceGroupImageAccept = 'image/png,image/jpeg,image/webp,image/avif,image/svg+xml';

export function AdminPriceGroupsSection({
  priceGroups,
  savedPriceGroupTitle,
  busy,
  updatePriceGroup,
  savePriceGroup,
  uploadImage,
  showStatus,
}: AdminPriceGroupsSectionProps) {
  const uploadPriceGroupImage = async (file: File, group: PriceGroupImage) => {
    try {
      const url = await uploadImage(file);
      updatePriceGroup(group.title, { imageUrl: url });
    } catch (error) {
      showStatus(error instanceof Error ? error.message : 'Ошибка загрузки');
    }
  };

  return (
    <section className={styles.section}>
      <h2>Ценовая группа</h2>

      <div className={styles.newsList}>
        {priceGroups.length === 0 ? (
          <p>Ценовые группы не найдены.</p>
        ) : (
          priceGroups.map((group) => (
            <article className={styles.newsCard} key={group.title}>
              <AdminImagePicker
                imageUrl={group.imageUrl}
                emptyText="Картинка не загружена"
                uploadLabel="Добавить/заменить SVG до 900x600"
                accept={priceGroupImageAccept}
                onUpload={(file) => uploadPriceGroupImage(file, group)}
              />
              <div className={styles.newsFields}>
                <input value={group.title} readOnly />
                <input value={`Товаров: ${group.productCount}`} readOnly />
                <div className={styles.actions}>
                  <button
                    className={savedPriceGroupTitle === group.title ? styles.savedButton : undefined}
                    disabled={busy}
                    onClick={() => savePriceGroup(group)}
                  >
                    {savedPriceGroupTitle === group.title ? 'Сохранено' : 'Сохранить'}
                  </button>
                  <button
                    className={styles.secondary}
                    disabled={busy || !group.imageUrl}
                    onClick={() => {
                      const nextGroup = { ...group, imageUrl: '' };
                      updatePriceGroup(group.title, { imageUrl: '' });
                      void savePriceGroup(nextGroup);
                    }}
                  >
                    Убрать картинку
                  </button>
                </div>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
