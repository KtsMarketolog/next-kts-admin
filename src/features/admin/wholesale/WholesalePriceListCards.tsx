import styles from '@/app/admin/admin.module.scss';
import { getWholesalePriceWorkflowStatusLabel } from '@/shared/lib/wholesalePriceWorkflowStatus';

import { formatDate, renderLastPriceChange, type PriceList } from './AdminWholesaleModel';

type WholesalePriceListCardsProps = {
  priceLists: PriceList[];
  copiedToken: string | null;
  emptyText: string;
  onEdit: (item: PriceList) => void;
  onOpen: (item: PriceList) => void;
  onCopyLink: (item: PriceList) => void;
  onDelete: (id: number) => void;
};

export function WholesalePriceListCards({
  priceLists,
  copiedToken,
  emptyText,
  onEdit,
  onOpen,
  onCopyLink,
  onDelete,
}: WholesalePriceListCardsProps) {
  return (
    <div className={styles.priceListCards}>
      {priceLists.map((item) => (
        <article className={styles.priceListCard} key={item.id}>
          <div className={styles.priceListHeader}>
            <div className={styles.priceListTitle}>
              <strong>{item.title}</strong>
              <span>
                Позиций: {item.itemCount} · Ценовых групп: {item.priceGroupCount}
              </span>
            </div>
            <div className={styles.priceListPrimaryActions}>
              <button onClick={() => onEdit(item)}>Изменить</button>
              <button className={styles.secondary} onClick={() => onOpen(item)}>
                Открыть
              </button>
            </div>
          </div>

          <div className={styles.priceListDetails}>
            <div className={styles.priceListField}>
              <span>Клиент</span>
              <strong>{item.clientName || '—'}</strong>
            </div>
            <div className={styles.priceListField}>
              <span>Менеджер</span>
              <strong>{item.managerName || '—'}</strong>
            </div>
            <div className={styles.priceListField}>
              <span>Действует до</span>
              <strong>{item.validUntil || '—'}</strong>
            </div>
            <div className={styles.priceListField}>
              <span>Дата создания</span>
              <strong>{formatDate(item.createdAt)}</strong>
            </div>
            <div className={styles.priceListField}>
              <span>Последнее изменение</span>
              <strong>{renderLastPriceChange(item)}</strong>
            </div>
          </div>

          <div className={styles.priceListFooter}>
            <div className={styles.priceListStatuses}>
              <div className={styles.priceListField}>
                <span>Статус</span>
                <strong className={item.isActive ? styles.priceStatusActive : styles.priceStatusHidden}>
                  {item.isActive ? 'Активен' : 'Скрыт'}
                </strong>
              </div>
              <div className={styles.priceListField}>
                <span>Этап работы</span>
                <strong className={`${styles.priceWorkflowStatus} ${styles[`priceWorkflowStatus_${item.workflowStatus}`] ?? ''}`}>
                  {item.workflowStatusLabel || getWholesalePriceWorkflowStatusLabel(item.workflowStatus)}
                </strong>
              </div>
            </div>
            <div className={styles.priceListActions}>
              <button
                className={`${styles.secondary} ${copiedToken === item.token ? styles.savedButton : ''}`}
                type="button"
                onClick={() => onCopyLink(item)}
              >
                {copiedToken === item.token ? 'Скопировано' : 'Скопировать ссылку'}
              </button>
              <button className={styles.danger} onClick={() => onDelete(item.id)}>
                Удалить
              </button>
            </div>
          </div>
        </article>
      ))}
      {priceLists.length === 0 ? <p className={styles.mutedText}>{emptyText}</p> : null}
    </div>
  );
}

