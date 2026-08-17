'use client';

import type { ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { AnalogFinder } from '@/features/analogs/AnalogFinder';
import { CabinetDashboard } from '@/shared/ui/CabinetDashboard/CabinetDashboard';

type ManagerSection = 'prices' | 'analogs';

const SECTIONS: Array<{ value: ManagerSection; label: string; description: string }> = [
  { value: 'prices', label: 'Прайсы', description: 'Индивидуальные прайсы' },
  { value: 'analogs', label: 'Аналоги', description: 'Подбор замены оборудования' },
];

type WholesaleManagerDashboardProps = {
  priceContent: ReactNode;
  priceCount: number;
};

export function WholesaleManagerDashboard({ priceContent, priceCount }: WholesaleManagerDashboardProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeSection: ManagerSection = searchParams.get('view') === 'analogs' ? 'analogs' : 'prices';

  const selectSection = (section: ManagerSection) => {
    const params = new URLSearchParams(searchParams.toString());
    if (section === 'prices') {
      params.delete('view');
    } else {
      params.set('view', section);
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return (
    <CabinetDashboard
      activeValue={activeSection}
      ariaLabel="Разделы кабинета менеджера"
      headerAside={activeSection === 'prices' ? <strong>{priceCount} прайсов</strong> : null}
      items={SECTIONS}
      onSelect={(value) => selectSection(value as ManagerSection)}
      sidebarLabel="Кабинет менеджера"
    >
      {activeSection === 'prices' ? priceContent : <AnalogFinder />}
    </CabinetDashboard>
  );
}
