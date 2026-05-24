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
  showOnSite: boolean;
};

type AdminCategoriesSectionProps = {
  showStatus: (message: string) => void;
  uploadImage: (file: File) => Promise<string>;
};

const CATEGORY_ICON_MAX_FILE_SIZE = 500 * 1024;
const ICON_SIZE_PENDING = 'определяется...';
const ICON_SIZE_UNKNOWN = 'не удалось определить';

type CategoryIconSize = {
  url: string;
  label: string;
};

function formatFileSize(bytes: number) {
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${Math.ceil(kilobytes)} КБ`;
  return `${(kilobytes / 1024).toFixed(1).replace('.', ',')} МБ`;
}

function formatContentLength(contentLength: string | null) {
  const bytes = Number(contentLength);
  return Number.isFinite(bytes) && bytes > 0 ? formatFileSize(bytes) : null;
}

async function readError(response: Response, fallback: string) {
  const data = await response.json().catch(() => ({}));
  return typeof data.error === 'string' ? data.error : fallback;
}

export function AdminCategoriesSection({ showStatus, uploadImage }: AdminCategoriesSectionProps) {
  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  const [iconSizes, setIconSizes] = useState<Record<number, CategoryIconSize>>({});
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

  useEffect(() => {
    const categoriesWithIcons = categories.filter((category) => category.iconUrl);

    if (categoriesWithIcons.length === 0) {
      setIconSizes({});
      return;
    }

    let isMounted = true;

    setIconSizes((current) => {
      const next: Record<number, CategoryIconSize> = {};
      categoriesWithIcons.forEach((category) => {
        next[category.id] =
          current[category.id]?.url === category.iconUrl
            ? current[category.id]
            : { url: category.iconUrl, label: ICON_SIZE_PENDING };
      });
      return next;
    });

    categoriesWithIcons.forEach((category) => {
      void (async () => {
        try {
          const response = await fetch(category.iconUrl, { method: 'HEAD', cache: 'no-store' });
          const label = response.ok ? formatContentLength(response.headers.get('content-length')) : null;

          if (!isMounted) return;
          setIconSizes((current) => {
            const currentIconSize = current[category.id];
            if (currentIconSize && currentIconSize.url !== category.iconUrl) return current;
            return {
              ...current,
              [category.id]: { url: category.iconUrl, label: label ?? ICON_SIZE_UNKNOWN },
            };
          });
        } catch {
          if (!isMounted) return;
          setIconSizes((current) => {
            const currentIconSize = current[category.id];
            if (currentIconSize && currentIconSize.url !== category.iconUrl) return current;
            return {
              ...current,
              [category.id]: { url: category.iconUrl, label: ICON_SIZE_UNKNOWN },
            };
          });
        }
      })();
    });

    return () => {
      isMounted = false;
    };
  }, [categories]);

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
        if (!iconUrl) {
          setIconSizes((current) => {
            const next = { ...current };
            delete next[categoryId];
            return next;
          });
        }
        markSaved(`category-${categoryId}`);
        showStatus(iconUrl ? 'Иконка категории сохранена' : 'Иконка категории убрана');
        return true;
      }
      return false;
    } catch {
      showStatus('Не удалось сохранить иконку категории');
      return false;
    } finally {
      setCategoryBusyId((current) => (current === categoryId ? null : current));
    }
  };

  const saveCategoryVisibility = async (categoryId: number, showOnSite: boolean) => {
    setCategoryBusyId(categoryId);
    try {
      const response = await fetch(`/api/admin/catalog/categories/${categoryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showOnSite }),
      });

      if (!response.ok) {
        showStatus(await readError(response, 'Не удалось сохранить отображение категории'));
        return;
      }

      const data = await response.json();
      if (data.category) {
        setCategories((current) => current.map((category) => (category.id === categoryId ? data.category : category)));
        markSaved(`visibility-${categoryId}`);
        showStatus(showOnSite ? 'Категория показывается на сайте' : 'Категория скрыта на сайте');
      }
    } catch {
      showStatus('Не удалось сохранить отображение категории');
    } finally {
      setCategoryBusyId((current) => (current === categoryId ? null : current));
    }
  };

  const uploadCategoryIcon = async (categoryId: number, file: File) => {
    if (file.size > CATEGORY_ICON_MAX_FILE_SIZE) {
      showStatus(`Размер изображения превышает 500 КБ. Сейчас: ${formatFileSize(file.size)}`);
      return;
    }

    setCategoryBusyId(categoryId);
    try {
      const nextIconSize = formatFileSize(file.size);
      const iconUrl = await uploadImage(file);
      const saved = await saveCategoryIcon(categoryId, iconUrl);
      if (saved) {
        setIconSizes((current) => ({
          ...current,
          [categoryId]: { url: iconUrl, label: nextIconSize },
        }));
      }
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
                <div className={styles.catalogCategoryIconUpload}>
                  <AdminImagePicker
                    imageUrl={category.iconUrl}
                    emptyText="Иконка не загружена"
                    uploadLabel={categoryBusyId === category.id ? 'Загрузка...' : 'Добавить/заменить иконку'}
                    accept="image/png,image/jpeg,image/webp,image/avif,image/svg+xml"
                    onUpload={(file) => uploadCategoryIcon(category.id, file)}
                  />
                  {category.iconUrl && (
                    <span className={styles.catalogCategoryIconSize}>
                      Размер: {iconSizes[category.id]?.label ?? ICON_SIZE_PENDING}
                    </span>
                  )}
                </div>
                <div className={styles.catalogCategoryIconInfo}>
                  <strong>{category.title}</strong>
                  <span>Товаров: {category.productCount}</span>
                  <code>{category.slug}</code>
                </div>
                <div className={styles.catalogCategoryIconActions}>
                  <label className={`${styles.checkbox} ${styles.catalogCategoryVisibility}`}>
                    <input
                      type="checkbox"
                      checked={category.showOnSite}
                      disabled={categoryBusyId === category.id}
                      onChange={(event) => saveCategoryVisibility(category.id, event.target.checked)}
                    />
                    <span>{savedId === `visibility-${category.id}` ? 'Сохранено' : 'Показывать на сайте'}</span>
                  </label>
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
