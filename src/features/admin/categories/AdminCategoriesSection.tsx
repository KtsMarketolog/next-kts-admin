'use client';

import { useCallback, useEffect, useState } from 'react';

import styles from '@/app/admin/admin.module.scss';
import { AdminImagePicker } from '@/features/admin/shared/AdminImagePicker';

type CatalogCategory = {
  id: number;
  title: string;
  slug: string;
  iconUrl: string;
  productCount: number;
  isActive: boolean;
};

type AdminCategoriesSectionProps = {
  showStatus: (message: string) => void;
  uploadImage: (file: File) => Promise<string>;
};

async function readError(response: Response, fallback: string) {
  const data = await response.json().catch(() => ({}));
  return typeof data.error === 'string' ? data.error : fallback;
}

export function AdminCategoriesSection({ showStatus, uploadImage }: AdminCategoriesSectionProps) {
  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  const [categoryBusyId, setCategoryBusyId] = useState<number | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  const loadCategories = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/catalog/categories', { cache: 'no-store' });
      if (!response.ok) {
        showStatus(await readError(response, 'Не удалось загрузить категории'));
        return;
      }
      const data = await response.json();
      setCategories(Array.isArray(data.categories) ? data.categories : []);
    } catch {
      showStatus('Не удалось загрузить категории');
    }
  }, [showStatus]);

  useEffect(() => {
    void loadCategories();
  }, [loadCategories]);

  const markSaved = (id: string) => {
    setSavedId(id);
    window.setTimeout(() => {
      setSavedId((current) => (current === id ? null : current));
    }, 1800);
  };

  const saveCategoryIcon = async (categoryId: number, iconUrl: string) => {
    setCategoryBusyId(categoryId);
    try {
      const response = await fetch(`/api/admin/catalog/categories/${categoryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ iconUrl }),
      });

      if (!response.ok) {
        showStatus(await readError(response, 'Не удалось сохранить иконку категории'));
        return;
      }

      const data = await response.json();
      if (data.category) {
        setCategories((current) => current.map((category) => (category.id === categoryId ? data.category : category)));
        markSaved(`category-${categoryId}`);
        showStatus(iconUrl ? 'Иконка категории сохранена' : 'Иконка категории убрана');
      }
    } catch {
      showStatus('Не удалось сохранить иконку категории');
    } finally {
      setCategoryBusyId((current) => (current === categoryId ? null : current));
    }
  };

  const uploadCategoryIcon = async (categoryId: number, file: File) => {
    setCategoryBusyId(categoryId);
    try {
      const iconUrl = await uploadImage(file);
      await saveCategoryIcon(categoryId, iconUrl);
    } catch (error) {
      showStatus(error instanceof Error ? error.message : 'Не удалось загрузить иконку категории');
      setCategoryBusyId((current) => (current === categoryId ? null : current));
    }
  };

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <p>Категории</p>
          <h2>Категории каталога</h2>
        </div>
        <span className={styles.headingMeta}>{categories.length} категорий</span>
      </div>

      <div className={styles.catalogCategoriesCard}>
        <div className={styles.stockLogHeader}>
          <div>
            <h3>Категории</h3>
            <p>Иконки отображаются в каталоге в списке категорий.</p>
          </div>
          <span className={styles.stockLogCount}>{categories.length}</span>
        </div>

        {categories.length === 0 ? (
          <p className={styles.mutedText}>Категории пока не найдены</p>
        ) : (
          <div className={styles.catalogCategoryIconList}>
            {categories.map((category) => (
              <article className={styles.catalogCategoryIconRow} key={category.id}>
                <AdminImagePicker
                  imageUrl={category.iconUrl}
                  emptyText="Иконка не загружена"
                  uploadLabel={categoryBusyId === category.id ? 'Загрузка...' : 'Добавить/заменить иконку'}
                  accept="image/png,image/jpeg,image/webp,image/avif,image/svg+xml"
                  onUpload={(file) => uploadCategoryIcon(category.id, file)}
                />
                <div className={styles.catalogCategoryIconInfo}>
                  <strong>{category.title}</strong>
                  <span>Товаров: {category.productCount}</span>
                  <code>{category.slug}</code>
                </div>
                <div className={styles.catalogCategoryIconActions}>
                  {category.iconUrl && (
                    <button
                      type="button"
                      className={savedId === `category-${category.id}` ? styles.savedButton : styles.secondary}
                      disabled={categoryBusyId === category.id}
                      onClick={() => saveCategoryIcon(category.id, '')}
                    >
                      {savedId === `category-${category.id}` ? 'Сохранено' : 'Убрать иконку'}
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
