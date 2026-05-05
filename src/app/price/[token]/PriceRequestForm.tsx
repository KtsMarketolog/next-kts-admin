'use client';

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import type { PublicWholesaleCategory } from '@/shared/lib/db';

import styles from './PricePage.module.scss';

type PriceRequestFormProps = {
  token: string;
  showRetailPrices: boolean;
  categories: PublicWholesaleCategory[];
};

function formatPrice(value: string | null) {
  if (!value) return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(number);
}

type PriceClientEventType =
  | 'public_price_product_opened'
  | 'public_price_request_started'
  | 'public_price_quantity_changed'
  | 'public_price_request_abandoned';

function trackPriceEvent(token: string, eventType: PriceClientEventType, metadata: Record<string, unknown>, beacon = false) {
  const payload = JSON.stringify({ eventType, metadata });
  const url = `/api/price/${encodeURIComponent(token)}/event`;

  if (beacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
    navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
    return;
  }

  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: beacon,
  }).catch(() => {
    // Analytics must not block the public price request flow.
  });
}

export function PriceRequestForm({ token, showRetailPrices, categories }: PriceRequestFormProps) {
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const openedProductsRef = useRef<Set<number>>(new Set());
  const requestStartedRef = useRef(false);
  const submittedRef = useRef(false);
  const selectionRef = useRef({ selectedItems: 0, totalQuantity: 0 });

  const selectedItems = useMemo(
    () =>
      Object.entries(quantities)
        .map(([id, quantity]) => ({ id: Number(id), quantity }))
        .filter((item) => Number.isInteger(item.id) && item.id > 0 && item.quantity > 0),
    [quantities],
  );

  const totalQuantity = selectedItems.reduce((sum, item) => sum + item.quantity, 0);

  useEffect(() => {
    selectionRef.current = { selectedItems: selectedItems.length, totalQuantity };
  }, [selectedItems.length, totalQuantity]);

  useEffect(() => {
    const trackAbandonedRequest = () => {
      const selection = selectionRef.current;
      if (submittedRef.current || selection.selectedItems === 0 || selection.totalQuantity === 0) return;
      trackPriceEvent(
        token,
        'public_price_request_abandoned',
        { selectedItems: selection.selectedItems, totalQuantity: selection.totalQuantity },
        true,
      );
    };

    window.addEventListener('pagehide', trackAbandonedRequest);
    return () => window.removeEventListener('pagehide', trackAbandonedRequest);
  }, [token]);

  const trackProductOpen = (product: PublicWholesaleCategory['products'][number]) => {
    if (openedProductsRef.current.has(product.id)) return;
    openedProductsRef.current.add(product.id);
    trackPriceEvent(token, 'public_price_product_opened', {
      productId: product.id,
      productTitle: product.title,
      source: 'product_card',
    });
  };

  const changeQuantity = (priceItemId: number, quantity: number, productTitle: string) => {
    submittedRef.current = false;
    if (quantity > 0 && !requestStartedRef.current) {
      requestStartedRef.current = true;
      trackPriceEvent(token, 'public_price_request_started', {
        priceItemId,
        productTitle,
        quantity,
      });
    }
    if (quantity > 0) {
      trackPriceEvent(token, 'public_price_quantity_changed', {
        priceItemId,
        productTitle,
        quantity,
      });
    }
    setQuantities((current) => ({ ...current, [priceItemId]: quantity }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (selectedItems.length === 0) {
      setStatus('Выберите количество хотя бы у одной позиции');
      return;
    }

    setBusy(true);
    setStatus('');
    const response = await fetch(`/api/price/${encodeURIComponent(token)}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: selectedItems }),
    });
    setBusy(false);

    if (!response.ok) {
      setStatus(response.status === 429 ? 'Слишком много заявок. Попробуйте позже.' : 'Не удалось отправить заявку');
      return;
    }

    setQuantities({});
    submittedRef.current = true;
    requestStartedRef.current = false;
    setStatus('Заявка отправлена');
  };

  return (
    <form className={styles.requestForm} onSubmit={submit}>
      {categories.map((category) => (
        <section className={styles.category} key={category.id}>
          <h2>{category.title}</h2>
          <div className={styles.products}>
            {category.products.map((product) => (
              <article
                className={styles.product}
                key={product.id}
                onFocusCapture={() => trackProductOpen(product)}
                onMouseEnter={() => trackProductOpen(product)}
              >
                <div className={styles.imageBox}>
                  {product.imageUrl ? <img src={product.imageUrl} alt="" /> : <span>Нет фото</span>}
                </div>
                <div className={styles.productInfo}>
                  <h3>{product.title}</h3>
                  {product.sku ? <p>Артикул: {product.sku}</p> : null}
                  {product.description ? <p>{product.description}</p> : null}
                </div>
                <table className={styles.prices}>
                  <thead>
                    <tr>
                      <th>Размер</th>
                      {showRetailPrices ? <th>Розница</th> : null}
                      <th>Опт</th>
                      <th>Заявка</th>
                    </tr>
                  </thead>
                  <tbody>
                    {product.variants.map((variant, index) => (
                      <tr key={`${variant.id ?? 'base'}-${index}`}>
                        <td>{variant.title}</td>
                        {showRetailPrices ? <td>{formatPrice(variant.retailPrice)}</td> : null}
                        <td>{formatPrice(variant.wholesalePrice)}</td>
                        <td>
                          <input
                            className={styles.quantityInput}
                            type="number"
                            min="0"
                            max="999"
                            step="1"
                            value={quantities[variant.priceItemId] || ''}
                            onChange={(event) => {
                              const value = Math.max(0, Math.min(999, Number(event.target.value) || 0));
                              changeQuantity(variant.priceItemId, value, product.title);
                            }}
                            aria-label={`Количество: ${product.title} ${variant.title}`}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </article>
            ))}
          </div>
        </section>
      ))}

      <section className={styles.requestBar}>
        <div>
          <strong>Позиций в заявке: {selectedItems.length}</strong>
          <span>Общее количество: {totalQuantity}</span>
        </div>
        <button className={styles.requestButton} type="submit" disabled={busy}>
          {busy ? 'Отправка...' : 'Отправить заявку'}
        </button>
      </section>
      {status ? <p className={styles.requestStatus}>{status}</p> : null}
    </form>
  );
}
