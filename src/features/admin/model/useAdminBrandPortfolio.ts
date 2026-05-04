'use client';

import { useState } from 'react';

import { emptyBrand, emptyBrandCategory } from '@/features/admin/model/defaults';
import type { AdminCrudHookOptions } from '@/features/admin/model/hookTypes';
import { reorderByDrop } from '@/features/admin/model/reorder';
import type { Brand, BrandCategory } from '@/features/admin/types';

export function useAdminBrandPortfolio({ setBusy, showStatus, reloadAdminData }: AdminCrudHookOptions) {
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
    setBusy(true);
    const responses = await Promise.all(
      orderedCategories.map((category) =>
        fetch(`/api/admin/brand-categories/${category.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(category),
        }),
      ),
    );
    setBusy(false);

    const saved = responses.every((res) => res.ok);
    showStatus(saved ? 'Очередность категорий брендов сохранена' : 'Не удалось сохранить очередность категорий брендов');
    if (saved) await reloadAdminData();
  };

  const moveBrandCategory = async (draggedId: number, targetId: number) => {
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

    setBusy(true);
    const res = await fetch('/api/admin/brand-categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...brandCategoryDraft, sortOrder: brandCategories.length + 1 }),
    });
    setBusy(false);
    showStatus(res.ok ? 'Категория брендов добавлена' : 'Не удалось добавить категорию брендов');
    if (res.ok) {
      setBrandCategoryCreated(true);
      window.setTimeout(() => setBrandCategoryCreated(false), 2000);
      setBrandCategoryDraft(emptyBrandCategory);
      await reloadAdminData();
    }
  };

  const saveBrandCategory = async (category: BrandCategory) => {
    setBusy(true);
    const res = await fetch(`/api/admin/brand-categories/${category.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(category),
    });
    setBusy(false);
    showStatus(res.ok ? 'Категория брендов сохранена' : 'Не удалось сохранить категорию брендов');
    if (res.ok) {
      setSavedBrandCategoryId(category.id);
      window.setTimeout(() => setSavedBrandCategoryId((current) => (current === category.id ? null : current)), 2000);
      await reloadAdminData();
    }
  };

  const deleteBrandCategoryItem = async (id: number) => {
    if (!confirm('Удалить категорию брендов? Все бренды внутри нее тоже удалятся.')) return;
    setBusy(true);
    const res = await fetch(`/api/admin/brand-categories/${id}`, { method: 'DELETE' });
    setBusy(false);
    showStatus(res.ok ? 'Категория брендов удалена' : 'Не удалось удалить категорию брендов');
    if (res.ok) await reloadAdminData();
  };

  const createBrand = async () => {
    if (!brandDraft.categoryId || !brandDraft.name.trim()) {
      showStatus('Добавьте категорию и название бренда');
      return;
    }

    const categoryBrands = brands.filter((brand) => brand.categoryId === brandDraft.categoryId);
    setBusy(true);
    const res = await fetch('/api/admin/brands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...brandDraft, sortOrder: categoryBrands.length + 1 }),
    });
    setBusy(false);
    showStatus(res.ok ? 'Бренд добавлен' : 'Не удалось добавить бренд');
    if (res.ok) {
      setBrandDraft({ ...emptyBrand, categoryId: brandDraft.categoryId });
      await reloadAdminData();
    }
  };

  const saveBrand = async (brand: Brand) => {
    setBusy(true);
    const res = await fetch(`/api/admin/brands/${brand.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(brand),
    });
    setBusy(false);
    showStatus(res.ok ? 'Бренд сохранен' : 'Не удалось сохранить бренд');
    if (res.ok) {
      setSavedBrandId(brand.id);
      window.setTimeout(() => setSavedBrandId((current) => (current === brand.id ? null : current)), 2000);
      await reloadAdminData();
    }
  };

  const deleteBrand = async (id: number) => {
    if (!confirm('Удалить бренд?')) return;
    setBusy(true);
    const res = await fetch(`/api/admin/brands/${id}`, { method: 'DELETE' });
    setBusy(false);
    showStatus(res.ok ? 'Бренд удален' : 'Не удалось удалить бренд');
    if (res.ok) await reloadAdminData();
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
