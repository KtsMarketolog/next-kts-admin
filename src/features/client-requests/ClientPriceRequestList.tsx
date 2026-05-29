import Link from 'next/link';

import type { ClientPriceRequest, ClientPriceRequestItemPrice } from '@/shared/lib/db';
import styles from './ClientPriceRequestList.module.scss';

type ClientPriceRequestListProps = {
  emptyText: string;
  emptyTitle: string;
  requests: ClientPriceRequest[];
};

function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatNumber(value: number, maximumFractionDigits = 2) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits }).format(value);
}

function formatAmount(value: number, currency: string) {
  return `${formatNumber(value)}${currency ? ` ${currency}` : ''}`;
}

function formatRub(value: number | null) {
  if (value === null) return '—';
  return `≈ ${formatNumber(Math.round(value), 0)} RUB`;
}

function PriceRow({ price, quantity }: { price: ClientPriceRequestItemPrice; quantity: number }) {
  return (
    <div className={styles.requestPriceRow}>
      <div>
        <span>Цена</span>
        <strong>{formatAmount(price.amount, price.currency)}</strong>
      </div>
      <div>
        <span>Кол-во</span>
        <strong>{quantity}</strong>
      </div>
      <div>
        <span>Сумма</span>
        <strong>{formatAmount(price.lineTotal, price.currency)}</strong>
      </div>
      {price.convertedRubLineTotal !== null ? (
        <div>
          <span>Сумма RUB</span>
          <strong>{formatRub(price.convertedRubLineTotal)}</strong>
        </div>
      ) : null}
    </div>
  );
}

export function ClientPriceRequestList({ emptyText, emptyTitle, requests }: ClientPriceRequestListProps) {
  if (requests.length === 0) {
    return (
      <div className={styles.emptyState}>
        <h3>{emptyTitle}</h3>
        <p>{emptyText}</p>
      </div>
    );
  }

  return (
    <div className={styles.requestList}>
      {requests.map((request) => (
        <details className={styles.requestCard} key={request.id}>
          <summary className={styles.requestSummary}>
            <div className={styles.requestSummaryTitle}>
              <span>Заявка от {formatDate(request.createdAt)}</span>
              <h3>{request.priceTitle || 'Прайс без названия'}</h3>
            </div>
            <dl className={styles.requestSummaryMeta}>
              <div>
                <dt>Позиций</dt>
                <dd>{request.totalQuantity}</dd>
              </div>
              <div>
                <dt>Итого</dt>
                <dd>{request.totalPriceLabel || '—'}</dd>
              </div>
              <div>
                <dt>Итого RUB</dt>
                <dd>{formatRub(request.totalConvertedRub)}</dd>
              </div>
            </dl>
            <span className={styles.summaryToggle}>
              <span className={styles.summaryToggleClosed}>Раскрыть</span>
              <span className={styles.summaryToggleOpen}>Скрыть</span>
            </span>
          </summary>

          <div className={styles.requestDetails}>
            <div className={styles.requestHeader}>
              <dl className={styles.requestMeta}>
                <div>
                  <dt>Позиций</dt>
                  <dd>{request.totalQuantity}</dd>
                </div>
                <div>
                  <dt>Итого</dt>
                  <dd>{request.totalPriceLabel || '—'}</dd>
                </div>
                <div>
                  <dt>Итого RUB</dt>
                  <dd>{formatRub(request.totalConvertedRub)}</dd>
                </div>
                <div>
                  <dt>Пересчет</dt>
                  <dd>{request.rubConversionInfo || 'Не выбран'}</dd>
                </div>
              </dl>
              {request.token ? (
                <Link className={styles.requestLink} href={`/price/${request.token}`} target="_blank" rel="noreferrer">
                  Открыть прайс
                </Link>
              ) : null}
            </div>

            {request.convertedBreakdownLabel ? (
              <div className={styles.requestComment}>
                <span>В пересчет вошло</span>
                <p>{request.convertedBreakdownLabel}</p>
              </div>
            ) : null}

            {request.comment ? (
              <div className={styles.requestComment}>
                <span>Комментарий</span>
                <p>{request.comment}</p>
              </div>
            ) : null}

            <div className={styles.requestItems}>
              {request.items.map((item) => (
                <div className={styles.requestItem} key={`${request.id}:${item.priceItemId}`}>
                  <div className={styles.requestItemTitle}>
                    <h4>{item.productTitle}</h4>
                    <p>Артикул: {item.sku || '—'}</p>
                    <p>{item.variantTitle || 'Цена'}</p>
                  </div>
                  <div className={styles.requestPrices}>
                    {item.prices.map((price) => (
                      <PriceRow
                        key={`${price.currency}:${price.amount}:${price.lineTotal}`}
                        price={price}
                        quantity={item.quantity}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </details>
      ))}
    </div>
  );
}
