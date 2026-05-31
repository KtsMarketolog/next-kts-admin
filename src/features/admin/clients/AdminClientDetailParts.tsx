import Link from 'next/link';

import styles from '@/app/admin/admin.module.scss';
import type { ClientCompanyPriceList } from '@/shared/lib/db';

import { formatDate } from './AdminClientDetail.helpers';

export function DetailRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  const displayValue = value === null || value === undefined || value === '' ? '—' : value;
  return (
    <div className={styles.clientDetailInfoItem}>
      <span>{label}</span>
      <strong>{displayValue}</strong>
    </div>
  );
}

export function EmptyClientTab({ title, text }: { title: string; text: string }) {
  return (
    <div className={styles.clientEmptyState}>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

export function ClientPriceListGrid({ clientId, priceLists }: { clientId: number; priceLists: ClientCompanyPriceList[] }) {
  if (priceLists.length === 0) {
    return <EmptyClientTab title="Прайсы пока не привязаны" text="Действующие прайсы появятся здесь после выбора клиента в прайсе." />;
  }

  return (
    <div className={styles.clientPriceListGrid}>
      {priceLists.map((priceList) => (
        <article className={styles.clientPriceListCard} key={priceList.id}>
          <div>
            <span>{priceList.isActive ? 'Активный прайс' : 'Отключенный прайс'}</span>
            <h3>{priceList.title}</h3>
          </div>
          <dl>
            <div>
              <dt>Позиций</dt>
              <dd>{priceList.itemCount}</dd>
            </div>
            <div>
              <dt>Действует до</dt>
              <dd>{priceList.validUntil || '—'}</dd>
            </div>
            <div>
              <dt>Статус</dt>
              <dd>{priceList.workflowStatusLabel}</dd>
            </div>
            <div>
              <dt>Обновлен</dt>
              <dd>{formatDate(priceList.updatedAt)}</dd>
            </div>
          </dl>
          <div className={styles.clientPriceListActions}>
            <Link
              className={styles.clientPriceListSecondaryLink}
              href={`/admin/wholesale/${priceList.id}/edit?returnClientId=${clientId}`}
            >
              Редактировать
            </Link>
            <Link className={styles.clientPriceListLink} href={`/price/${priceList.token}`} target="_blank" rel="noreferrer">
              Открыть прайс
            </Link>
          </div>
        </article>
      ))}
    </div>
  );
}
