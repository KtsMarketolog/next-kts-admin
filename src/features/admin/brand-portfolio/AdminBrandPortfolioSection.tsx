'use client';

import { Dispatch, SetStateAction } from 'react';

import styles from '@/app/admin/admin.module.scss';
import { Brand, BrandCategory } from '@/features/admin/types';
import { AdminImagePicker } from '@/features/admin/shared/AdminImagePicker';
import { AdminOrderList } from '@/features/admin/shared/AdminOrderList';

type AdminBrandPortfolioSectionProps = {
  brandCategories: BrandCategory[];
  brands: Brand[];
  brandCategoryDraft: Omit<BrandCategory, 'id'>;
  brandDraft: Omit<Brand, 'id'>;
  draggedBrandCategoryId: number | null;
  busy: boolean;
  savedBrandCategoryId: number | null;
  savedBrandId: number | null;
  brandCategoryCreated: boolean;
  setBrandCategoryDraft: Dispatch<SetStateAction<Omit<BrandCategory, 'id'>>>;
  setBrandDraft: Dispatch<SetStateAction<Omit<Brand, 'id'>>>;
  setDraggedBrandCategoryId: (id: number | null) => void;
  updateBrandCategory: (id: number, patch: Partial<BrandCategory>) => void;
  moveBrandCategory: (draggedId: number, targetId: number) => Promise<void>;
  createBrandCategoryItem: () => Promise<void>;
  saveBrandCategory: (category: BrandCategory) => Promise<void>;
  deleteBrandCategoryItem: (id: number) => Promise<void>;
  updateBrand: (id: number, patch: Partial<Brand>) => void;
  createBrand: () => Promise<void>;
  saveBrand: (brand: Brand) => Promise<void>;
  deleteBrand: (id: number) => Promise<void>;
  uploadImage: (file: File) => Promise<string>;
  showStatus: (message: string) => void;
};

const logoAccept = 'image/png,image/jpeg,image/webp,image/avif,image/svg+xml';

export function AdminBrandPortfolioSection({
  brandCategories,
  brands,
  brandCategoryDraft,
  brandDraft,
  draggedBrandCategoryId,
  busy,
  savedBrandCategoryId,
  savedBrandId,
  brandCategoryCreated,
  setBrandCategoryDraft,
  setBrandDraft,
  setDraggedBrandCategoryId,
  updateBrandCategory,
  moveBrandCategory,
  createBrandCategoryItem,
  saveBrandCategory,
  deleteBrandCategoryItem,
  updateBrand,
  createBrand,
  saveBrand,
  deleteBrand,
  uploadImage,
  showStatus,
}: AdminBrandPortfolioSectionProps) {
  const uploadLogo = async (file: File, onUploaded: (url: string) => void) => {
    try {
      const url = await uploadImage(file);
      onUploaded(url);
    } catch (error) {
      showStatus(error instanceof Error ? error.message : 'Ошибка загрузки');
    }
  };

  return (
    <section className={styles.section}>
      <h2>Портфель брендов</h2>

      <div className={styles.brandAdminBlock}>
        <h3>Категории брендов</h3>
        <AdminOrderList
          items={brandCategories}
          draggedId={draggedBrandCategoryId}
          busy={busy}
          ariaLabel="Очередность категорий брендов"
          dragTitle="Перетащите категорию"
          panelClassName={styles.orderPanel}
          itemClassName={styles.brandCategoryOrderItem}
          itemDraggingClassName={styles.orderItemDragging}
          dragClassName={styles.orderDrag}
          thumbClassName={styles.brandCategoryOrderThumb}
          numberClassName={styles.orderNumber}
          onDragStart={setDraggedBrandCategoryId}
          onDrop={(targetId) => {
            if (!draggedBrandCategoryId || draggedBrandCategoryId === targetId) {
              setDraggedBrandCategoryId(null);
              return;
            }
            void moveBrandCategory(draggedBrandCategoryId, targetId);
            setDraggedBrandCategoryId(null);
          }}
          onDragEnd={() => setDraggedBrandCategoryId(null)}
          renderThumb={(category) => category.title}
        />

        <div className={styles.brandRow}>
          <input
            value={brandCategoryDraft.title}
            onChange={(event) => setBrandCategoryDraft({ ...brandCategoryDraft, title: event.target.value })}
            placeholder="Название категории"
          />
          <input
            value={brandCategoryDraft.key}
            onChange={(event) => setBrandCategoryDraft({ ...brandCategoryDraft, key: event.target.value })}
            placeholder="Ключ, необязательно"
          />
          <input type="number" value={brandCategories.length + 1} readOnly placeholder="Позиция" />
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={brandCategoryDraft.isActive}
              onChange={(event) => setBrandCategoryDraft({ ...brandCategoryDraft, isActive: event.target.checked })}
            />
            Показывать
          </label>
          <button
            className={brandCategoryCreated ? styles.savedButton : undefined}
            disabled={busy}
            onClick={createBrandCategoryItem}
          >
            {brandCategoryCreated ? 'Категория добавлена' : 'Добавить категорию'}
          </button>
        </div>

        <div className={styles.brandList}>
          {brandCategories.map((category) => (
            <div className={styles.brandRow} key={category.id}>
              <input
                value={category.title}
                onChange={(event) => updateBrandCategory(category.id, { title: event.target.value })}
                placeholder="Название категории"
              />
              <input
                value={category.key}
                onChange={(event) => updateBrandCategory(category.id, { key: event.target.value })}
                placeholder="Ключ"
              />
              <input type="number" value={category.sortOrder} readOnly placeholder="Позиция" />
              <label className={styles.checkbox}>
                <input
                  type="checkbox"
                  checked={category.isActive}
                  onChange={(event) => updateBrandCategory(category.id, { isActive: event.target.checked })}
                />
                Показывать
              </label>
              <button
                className={savedBrandCategoryId === category.id ? styles.savedButton : undefined}
                disabled={busy}
                onClick={() => saveBrandCategory(category)}
              >
                {savedBrandCategoryId === category.id ? 'Сохранено' : 'Сохранить'}
              </button>
              <button className={styles.danger} disabled={busy} onClick={() => deleteBrandCategoryItem(category.id)}>
                Удалить
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className={styles.brandAdminBlock}>
        <h3>Бренды</h3>
        <div className={styles.brandCard}>
          <AdminImagePicker
            imageUrl={brandDraft.imageUrl}
            uploadLabel="Добавить/заменить логотип"
            accept={logoAccept}
            onUpload={(file) => uploadLogo(file, (url) => setBrandDraft((current) => ({ ...current, imageUrl: url, iconKey: '' })))}
          />
          <div className={styles.newsFields}>
            <select
              value={brandDraft.categoryId}
              onChange={(event) => setBrandDraft({ ...brandDraft, categoryId: Number(event.target.value) })}
            >
              {brandCategories.map((category) => (
                <option key={category.id} value={category.id}>{category.title}</option>
              ))}
            </select>
            <input
              value={brandDraft.name}
              onChange={(event) => setBrandDraft({ ...brandDraft, name: event.target.value })}
              placeholder="Название бренда"
            />
            <input
              value={brandDraft.iconKey}
              onChange={(event) => setBrandDraft({ ...brandDraft, iconKey: event.target.value })}
              placeholder="Ключ встроенной иконки, необязательно"
            />
            <input
              type="number"
              value={brands.filter((brand) => brand.categoryId === brandDraft.categoryId).length + 1}
              readOnly
              placeholder="Позиция"
            />
            <label className={styles.checkbox}>
              <input
                type="checkbox"
                checked={brandDraft.isActive}
                onChange={(event) => setBrandDraft({ ...brandDraft, isActive: event.target.checked })}
              />
              Показывать
            </label>
            <button disabled={busy} onClick={createBrand}>Добавить бренд</button>
          </div>
        </div>

        <div className={styles.newsList}>
          {brands.map((brand) => (
            <article className={styles.brandCard} key={brand.id}>
              <AdminImagePicker
                imageUrl={brand.imageUrl}
                emptyText={brand.iconKey || 'Картинка не загружена'}
                uploadLabel="Добавить/заменить логотип"
                accept={logoAccept}
                onUpload={(file) => uploadLogo(file, (url) => updateBrand(brand.id, { imageUrl: url, iconKey: '' }))}
              />
              <div className={styles.newsFields}>
                <select
                  value={brand.categoryId}
                  onChange={(event) => updateBrand(brand.id, { categoryId: Number(event.target.value) })}
                >
                  {brandCategories.map((category) => (
                    <option key={category.id} value={category.id}>{category.title}</option>
                  ))}
                </select>
                <input
                  value={brand.name}
                  onChange={(event) => updateBrand(brand.id, { name: event.target.value })}
                  placeholder="Название бренда"
                />
                <input
                  value={brand.iconKey}
                  onChange={(event) => updateBrand(brand.id, { iconKey: event.target.value })}
                  placeholder="Ключ встроенной иконки"
                />
                <input type="number" value={brand.sortOrder} readOnly placeholder="Позиция" />
                <label className={styles.checkbox}>
                  <input
                    type="checkbox"
                    checked={brand.isActive}
                    onChange={(event) => updateBrand(brand.id, { isActive: event.target.checked })}
                  />
                  Показывать
                </label>
                <div className={styles.actions}>
                  <button
                    className={savedBrandId === brand.id ? styles.savedButton : undefined}
                    disabled={busy}
                    onClick={() => saveBrand(brand)}
                  >
                    {savedBrandId === brand.id ? 'Сохранено' : 'Сохранить'}
                  </button>
                  <button className={styles.danger} disabled={busy} onClick={() => deleteBrand(brand.id)}>
                    Удалить
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
