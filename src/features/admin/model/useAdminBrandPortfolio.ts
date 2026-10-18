'use client';

import { useState } from 'react';

import { emptyBrand, emptyBrandCategory } from '@/features/admin/model/defaults';
import type { AdminCrudHookOptions } from '@/features/admin/model/hookTypes';
import { reorderByDrop } from '@/features/admin/model/reorder';
import { useAdminContentAction } from '@/features/admin/model/useAdminContentAction';
import type { Brand, BrandCategory } from '@/features/admin/types';

export function useAdminBrandPortfolio(options: AdminCrudHookOptions) {
  const { showStatus } = options;
  const perform = useAdminContentAction(options);
  const [brandCategories, setBrandCategories] = useState<BrandCategory[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [brandCategoryDraft, setBrandCategoryDraft] = useState(emptyBrandCategory);
  const [brandDraft, setBrandDraft] = useState(emptyBrand);
  const [savedBrandCategoryId, setSavedBrandCategoryId] = useState<number | null>(null);
  const [savedBrandId, setSavedBrandId] = useState<number | null>(null);
  const [brandCategoryCreated, setBrandCategoryCreated] = useState(false);
  const [draggedBrandCategoryId, setDraggedBrandCategoryId] = useState<number | null>(null);

  const updateBrandCategory = (id: number, patch: Partial<BrandCategory>) => {
    setBrandCategories((current) =>
      current.map((category) => (category.id === id ? { ...category, ...patch } : category)),
    );
  };

  const updateBrand = (id: number, patch: Partial<Brand>) => {
    setBrands((current) => current.map((brand) => (brand.id === id ? { ...brand, ...patch } : brand)));
  };

  const persistBrandCategoryOrder = async (orderedCategories: BrandCategory[]) => {
    await perform({ requests: orderedCategories.map((category) => ({ url: `/api/admin/brand-categories/${category.id}`, init: {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(category),
        } })), success: 'Очередность категорий брендов сохранена', failure: 'Не удалось сохранить очередность категорий брендов' });
  };

  const moveBrandCategory = async (draggedId: number, targetId: number) => {
    if (options.actionLock?.current) return;
    const normalized = reorderByDrop(brandCategories, draggedId, targetId);
    if (!normalized) return;
    setBrandCategories(normalized);
    await persistBrandCategoryOrder(normalized);
  };

  const createBrandCategoryItem = async () => {
    if (!brandCategoryDraft.title.trim()) {
      showStatus('Добавьте название категории брендов');
      return;
    }

    await perform({ requests: [{ url: '/api/admin/brand-categories', init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...brandCategoryDraft, sortOrder: brandCategories.length + 1 }),
    } }], success: 'Категория брендов добавлена', failure: 'Не удалось добавить категорию брендов', onSaved: () => {
      setBrandCategoryCreated(true);
      window.setTimeout(() => setBrandCategoryCreated(false), 2000);
      setBrandCategoryDraft(emptyBrandCategory);
    } });
  };

  const saveBrandCategory = async (category: BrandCategory) => {
    await perform({ requests: [{ url: `/api/admin/brand-categories/${category.id}`, init: {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(category),
    } }], success: 'Категория брендов сохранена', failure: 'Не удалось сохранить категорию брендов', onSaved: () => {
      setSavedBrandCategoryId(category.id);
      window.setTimeout(() => setSavedBrandCategoryId((current) => (current === category.id ? null : current)), 2000);
    } });
  };

  const deleteBrandCategoryItem = async (id: number) => {
    if (!confirm('Удалить категорию брендов? Все бренды внутри нее тоже удалятся.')) return;
    await perform({ requests: [{ url: `/api/admin/brand-categories/${id}`, init: { method: 'DELETE' } }],
      success: 'Категория брендов удалена', failure: 'Не удалось удалить категорию брендов' });
  };

  const createBrand = async () => {
    if (!brandDraft.categoryId || !brandDraft.name.trim()) {
      showStatus('Добавьте категорию и название бренда');
      return;
    }

    const categoryBrands = brands.filter((brand) => brand.categoryId === brandDraft.categoryId);
    await perform({ requests: [{ url: '/api/admin/brands', init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...brandDraft, sortOrder: categoryBrands.length + 1 }),
    } }], success: 'Бренд добавлен', failure: 'Не удалось добавить бренд', onSaved: () => {
      setBrandDraft({ ...emptyBrand, categoryId: brandDraft.categoryId });
    } });
  };

  const saveBrand = async (brand: Brand) => {
    await perform({ requests: [{ url: `/api/admin/brands/${brand.id}`, init: {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(brand),
    } }], success: 'Бренд сохранен', failure: 'Не удалось сохранить бренд', onSaved: () => {
      setSavedBrandId(brand.id);
      window.setTimeout(() => setSavedBrandId((current) => (current === brand.id ? null : current)), 2000);
    } });
  };

  const deleteBrand = async (id: number) => {
    if (!confirm('Удалить бренд?')) return;
    await perform({ requests: [{ url: `/api/admin/brands/${id}`, init: { method: 'DELETE' } }],
      success: 'Бренд удален', failure: 'Не удалось удалить бренд' });
  };

  return {
    brandCategories,
    setBrandCategories,
    brands,
    setBrands,
    brandCategoryDraft,
    setBrandCategoryDraft,
    brandDraft,
    setBrandDraft,
    draggedBrandCategoryId,
    setDraggedBrandCategoryId,
    savedBrandCategoryId,
    savedBrandId,
    brandCategoryCreated,
    updateBrandCategory,
    moveBrandCategory,
    createBrandCategoryItem,
    saveBrandCategory,
    deleteBrandCategoryItem,
    updateBrand,
    createBrand,
    saveBrand,
    deleteBrand,
  };
}
