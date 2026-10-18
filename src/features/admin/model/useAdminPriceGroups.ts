'use client';

import { useState } from 'react';

import type { AdminCrudHookOptions } from '@/features/admin/model/hookTypes';
import { useAdminContentAction } from '@/features/admin/model/useAdminContentAction';
import type { PriceGroupImage } from '@/features/admin/types';

export function useAdminPriceGroups(options: AdminCrudHookOptions) {
  const perform = useAdminContentAction(options);
  const [priceGroups, setPriceGroups] = useState<PriceGroupImage[]>([]);
  const [savedPriceGroupTitle, setSavedPriceGroupTitle] = useState<string | null>(null);

  const updatePriceGroup = (title: string, patch: Partial<PriceGroupImage>) => {
    setPriceGroups((current) => current.map((group) => (group.title === title ? { ...group, ...patch } : group)));
  };

  const savePriceGroup = async (group: PriceGroupImage) => {
    await perform({ requests: [{ url: '/api/admin/price-groups', init: {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: group.title, imageUrl: group.imageUrl }),
    } }], success: 'Картинка ценовой группы сохранена', failure: 'Не удалось сохранить картинку ценовой группы', onSaved: () => {
      setSavedPriceGroupTitle(group.title);
      window.setTimeout(() => setSavedPriceGroupTitle((current) => (current === group.title ? null : current)), 2000);
    } });
  };

  return {
    priceGroups,
    setPriceGroups,
    savedPriceGroupTitle,
    updatePriceGroup,
    savePriceGroup,
  };
}
