'use client';

import { FormEvent, useMemo, useState } from 'react';

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

export function PriceRequestForm({ token, showRetailPrices, categories }: PriceRequestFormProps) {
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const selectedItems = useMemo(
    () =>
      Object.entries(quantities)
        .map(([id, quantity]) => ({ id: Number(id), quantity }))
        .filter((item) => Number.isInteger(item.id) && item.id > 0 && item.quantity > 0),
    [quantities],
  );

  const totalQuantity = selectedItems.reduce((sum, item) => sum + item.quantity, 0);

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
    setStatus('Заявка отправлена');
  };

  return (
    <form className={styles.requestForm} onSubmit={submit}>
      {categories.map((category) => (
        <section className={styles.category} key={category.id}>
          <h2>{category.title}</h2>
          <div className={styles.products}>
            {category.products.map((product) => (
              <article className={styles.product} key={product.id}>
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
                              setQuantities((current) => ({ ...current, [variant.priceItemId]: value }));
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
