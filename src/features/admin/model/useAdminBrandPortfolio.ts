'use client';

import { useCallback, useState } from 'react';

import { readSavedContentItem } from '@/features/admin/model/adminContentRead';
import { emptyBrand, emptyBrandCategory } from '@/features/admin/model/defaults';
import type { AdminCrudHookOptions } from '@/features/admin/model/hookTypes';
import { readConfirmedOrder, reorderByDrop, reorderRequest } from '@/features/admin/model/reorder';
import { useAdminContentAction } from '@/features/admin/model/useAdminContentAction';
import { useAdminDraft, useAdminDraftCollection } from '@/features/admin/model/useAdminDraftState';
import type { Brand, BrandCategory } from '@/features/admin/types';

const categoryKey = (category: BrandCategory) => category.id;
const brandKey = (brand: Brand) => brand.id;
const portfolioEndpoint = '/api/admin/brand-categories';

export function useAdminBrandPortfolio(options: AdminCrudHookOptions) {
  const { showStatus } = options;
  const perform = useAdminContentAction(options);
  const categories = useAdminDraftCollection<BrandCategory>(categoryKey, options.draftScope && `${options.draftScope}:brand-categories`);
  const brandItems = useAdminDraftCollection<Brand>(brandKey, options.draftScope && `${options.draftScope}:brands`);
  const categoryDraft = useAdminDraft(emptyBrandCategory, options.draftScope && `${options.draftScope}:new-brand-category`);
  const newBrandDraft = useAdminDraft(emptyBrand, options.draftScope && `${options.draftScope}:new-brand`);
  const brandCategories = [...categories.items].sort((left, right) => left.sortOrder - right.sortOrder);
  const { items: brands } = brandItems;
  const brandCategoryDraft = categoryDraft.value;
  const brandDraft = newBrandDraft.value;
  const { hydrate: hydrateBrandDraft } = newBrandDraft;
  const initializeBrandDraft = useCallback((categoryId: number) => {
    hydrateBrandDraft({ ...emptyBrand, categoryId });
  }, [hydrateBrandDraft]);
  const [savedBrandCategoryId, setSavedBrandCategoryId] = useState<number | null>(null);
  const [savedBrandId, setSavedBrandId] = useState<number | null>(null);
  const [brandCategoryCreated, setBrandCategoryCreated] = useState(false);
  const [draggedBrandCategoryId, setDraggedBrandCategoryId] = useState<number | null>(null);

  const updateBrandCategory = (id: number, patch: Partial<BrandCategory>) => categories.update(id, patch);
  const updateBrand = (id: number, patch: Partial<Brand>) => brandItems.update(id, patch);

  const persistBrandCategoryOrder = async (orderedCategories: BrandCategory[], originalCategories: BrandCategory[]) => {
    await perform({
      requests: [reorderRequest(portfolioEndpoint, orderedCategories)],
      success: 'Очередность категорий брендов сохранена',
      failure: 'Не удалось сохранить очередность категорий брендов',
      onSaved: async (responses, signal) => {
        const warnings = await readConfirmedOrder(responses[0], orderedCategories, signal);
        for (const saved of orderedCategories) {
          const submitted = originalCategories.find((category) => category.id === saved.id)!;
          categories.accept(submitted, saved, ['sortOrder']);
        }
        if (warnings.length) return `Очередность категорий брендов сохранена. ${warnings.join(' ')}`;
      },
    });
  };

  const moveBrandCategory = async (draggedId: number, targetId: number) => {
    if (options.actionLock?.current) return;
    const normalized = reorderByDrop(brandCategories, draggedId, targetId);
    if (!normalized) return;
    await persistBrandCategoryOrder(normalized, brandCategories);
  };

  const createBrandCategoryItem = async () => {
    if (!brandCategoryDraft.title.trim()) {
      showStatus('Добавьте название категории брендов');
      return;
    }
    const submitted = { ...brandCategoryDraft };
    await perform({
      requests: [{ url: portfolioEndpoint, init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...submitted, sortOrder: brandCategories.length + 1 }),
      } }],
      success: 'Категория брендов добавлена',
      failure: 'Не удалось добавить категорию брендов',
      onSaved: async (responses, signal) => {
        const data = await responses[0].json();
        const id = Number(data?.id);
        if (!Number.isInteger(id) || id <= 0) throw new Error('Сервер не вернул идентификатор категории');
        const saved = await readSavedContentItem<BrandCategory>(portfolioEndpoint, 'categories', (item) => item.id === id, signal);
        if (signal.aborted) return;
        categories.accept({ ...submitted, id }, saved);
        categoryDraft.resetAfterSave(submitted);
        if (!brandDraft.categoryId) initializeBrandDraft(saved.id);
        setBrandCategoryCreated(true);
        window.setTimeout(() => setBrandCategoryCreated(false), 2000);
      },
    });
  };

  const saveBrandCategory = async (category: BrandCategory) => {
    const submitted = { ...category };
    await perform({
      requests: [{ url: `${portfolioEndpoint}/${submitted.id}`, init: {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submitted),
      } }],
      success: 'Категория брендов сохранена',
      failure: 'Не удалось сохранить категорию брендов',
      onSaved: async (_responses, signal) => {
        const saved = await readSavedContentItem<BrandCategory>(portfolioEndpoint, 'categories', (item) => item.id === submitted.id, signal);
        if (signal.aborted) return;
        categories.accept(submitted, saved);
        setSavedBrandCategoryId(submitted.id);
        window.setTimeout(() => setSavedBrandCategoryId((current) => (current === submitted.id ? null : current)), 2000);
      },
    });
  };

  const deleteBrandCategoryItem = async (id: number) => {
    if (!confirm('Удалить категорию брендов? Все бренды внутри нее тоже удалятся.')) return;
    // Cascading deletion follows the saved category, not a locally edited one.
    const persistedChildren = brands.filter((brand) => brandItems.baseline(brand.id)?.categoryId === id).map((brand) => brand.id);
    await perform({
      requests: [{ url: `${portfolioEndpoint}/${id}`, init: { method: 'DELETE' } }],
      success: 'Категория брендов удалена',
      failure: 'Не удалось удалить категорию брендов',
      onSaved: () => {
        categories.remove(id);
        persistedChildren.forEach((brandId) => brandItems.remove(brandId));
      },
    });
  };

  const createBrand = async () => {
    if (!brandDraft.categoryId || !brandDraft.name.trim()) {
      showStatus('Добавьте категорию и название бренда');
      return;
    }
    const submitted = { ...brandDraft };
    const categoryBrands = brands.filter((brand) => brand.categoryId === submitted.categoryId);
    await perform({
      requests: [{ url: '/api/admin/brands', init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...submitted, sortOrder: categoryBrands.length + 1 }),
      } }],
      success: 'Бренд добавлен',
      failure: 'Не удалось добавить бренд',
      onSaved: async (responses, signal) => {
        const data = await responses[0].json();
        const id = Number(data?.id);
        if (!Number.isInteger(id) || id <= 0) throw new Error('Сервер не вернул идентификатор бренда');
        const saved = await readSavedContentItem<Brand>(portfolioEndpoint, 'brands', (item) => item.id === id, signal);
        if (signal.aborted) return;
        brandItems.accept({ ...submitted, id }, saved);
        newBrandDraft.accept(submitted, { ...emptyBrand, categoryId: submitted.categoryId });
      },
    });
  };

  const saveBrand = async (brand: Brand) => {
    const submitted = { ...brand };
    await perform({
      requests: [{ url: `/api/admin/brands/${submitted.id}`, init: {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(submitted),
      } }],
      success: 'Бренд сохранен',
      failure: 'Не удалось сохранить бренд',
      onSaved: async (_responses, signal) => {
        const saved = await readSavedContentItem<Brand>(portfolioEndpoint, 'brands', (item) => item.id === submitted.id, signal);
        if (signal.aborted) return;
        brandItems.accept(submitted, saved);
        setSavedBrandId(submitted.id);
        window.setTimeout(() => setSavedBrandId((current) => (current === submitted.id ? null : current)), 2000);
      },
    });
  };

  const deleteBrand = async (id: number) => {
    if (!confirm('Удалить бренд?')) return;
    await perform({
      requests: [{ url: `/api/admin/brands/${id}`, init: { method: 'DELETE' } }],
      success: 'Бренд удален',
      failure: 'Не удалось удалить бренд',
      onSaved: () => brandItems.remove(id),
    });
  };

  return {
    brandCategories,
    setBrandCategories: categories.hydrate,
    brands,
    setBrands: brandItems.hydrate,
    brandCategoryDraft,
    setBrandCategoryDraft: categoryDraft.setValue,
    brandDraft,
    setBrandDraft: newBrandDraft.setValue,
    initializeBrandDraft,
    dirtyCount: categories.dirtyKeys.size + brandItems.dirtyKeys.size + Number(categoryDraft.dirty) + Number(newBrandDraft.dirty),
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
