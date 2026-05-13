'use client';

import { useState } from 'react';

import type { AdminCrudHookOptions } from '@/features/admin/model/hookTypes';
import type { PriceGroupImage } from '@/features/admin/types';

export function useAdminPriceGroups({ setBusy, showStatus, reloadAdminData }: AdminCrudHookOptions) {
  const [priceGroups, setPriceGroups] = useState<PriceGroupImage[]>([]);
  const [savedPriceGroupTitle, setSavedPriceGroupTitle] = useState<string | null>(null);

  const updatePriceGroup = (title: string, patch: Partial<PriceGroupImage>) => {
    setPriceGroups((current) => current.map((group) => (group.title === title ? { ...group, ...patch } : group)));
  };

  const savePriceGroup = async (group: PriceGroupImage) => {
    setBusy(true);
    const res = await fetch('/api/admin/price-groups', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: group.title, imageUrl: group.imageUrl }),
    });
    setBusy(false);

    if (res.ok) {
      setSavedPriceGroupTitle(group.title);
      window.setTimeout(() => setSavedPriceGroupTitle((current) => (current === group.title ? null : current)), 2000);
      showStatus('Картинка ценовой группы сохранена');
      await reloadAdminData();
      return;
    }

    showStatus('Не удалось сохранить картинку ценовой группы');
  };

  return {
    priceGroups,
    setPriceGroups,
    savedPriceGroupTitle,
    updatePriceGroup,
    savePriceGroup,
  };
}
