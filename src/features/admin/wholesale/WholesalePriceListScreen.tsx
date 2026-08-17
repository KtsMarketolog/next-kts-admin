import styles from '@/app/admin/admin.module.scss';

import type { CurrentManager, PriceList } from './AdminWholesaleModel';
import { WholesalePriceListCards } from './WholesalePriceListCards';

type WholesalePriceListScreenProps = {
  mode: 'manager' | 'managerDetail';
  currentManager: CurrentManager | null;
  canManageWholesale: boolean;
  managerDetailId: number | null;
  status: string;
  priceLists: PriceList[];
  copiedToken: string | null;
  onBack: () => void;
  onAdminBack: () => void;
  onManagersBack: () => void;
  onCreate: (managerId?: number | null) => void;
  onEdit: (item: PriceList) => void;
  onOpen: (item: PriceList) => void;
  onCopyLink: (item: PriceList) => void;
  onDelete: (id: number) => void;
  embedded?: boolean;
};

export function WholesalePriceListScreen({
  mode,
  currentManager,
  canManageWholesale,
  managerDetailId,
  status,
  priceLists,
  copiedToken,
  onBack,
  onAdminBack,
  onManagersBack,
  onCreate,
  onEdit,
  onOpen,
  onCopyLink,
  onDelete,
  embedded = false,
}: WholesalePriceListScreenProps) {
  const isManagerDetail = mode === 'managerDetail';
  const backLabel = isManagerDetail ? 'Вернуться к менеджерам' : 'Вернуться в панель управления';
  const emptyText = 'У менеджера пока нет прайсов.';

  return (
    <section className={`${styles.section} ${embedded ? styles.sectionEmbedded : ''}`}>
      <div className={styles.sectionHeader}>
        <div>
          <p>Индивидуальные прайсы</p>
          <h2>
            {isManagerDetail ? 'Прайсы менеджера' : 'Менеджер'}
            {currentManager?.name ? <span className={styles.headingMeta}>{currentManager.name}</span> : null}
          </h2>
        </div>
        <div className={styles.topbarActions}>
          <button className={styles.secondary} onClick={isManagerDetail ? onManagersBack : canManageWholesale ? onAdminBack : onBack}>
            {backLabel}
          </button>
          <button onClick={() => onCreate(isManagerDetail ? managerDetailId : null)}>Создать прайс</button>
        </div>
      </div>

      {status ? <p className={styles.status}>{status}</p> : null}

      <WholesalePriceListCards
        priceLists={priceLists}
        copiedToken={copiedToken}
        emptyText={emptyText}
        onEdit={onEdit}
        onOpen={onOpen}
        onCopyLink={onCopyLink}
        onDelete={onDelete}
      />
    </section>
  );
}
