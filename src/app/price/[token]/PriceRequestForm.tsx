'use client';

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import type { PublicWholesaleCategory } from '@/shared/lib/db';

import styles from './PricePage.module.scss';

type PriceRequestFormProps = {
  token: string;
  showRetailPrices: boolean;
  categories: PublicWholesaleCategory[];
};

const NO_PRICE_GROUP_TITLE = 'Без ценовой группы';

function formatPrice(value: string | null) {
  if (!value) return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(number);
}

function hasPriceValue(value: string | null) {
  if (!value) return false;
  const number = Number(value.replace(/\s+/g, '').replace(',', '.'));
  return Number.isFinite(number) ? number > 0 : value.trim().length > 0;
}

type PublicPriceVariant = PublicWholesaleCategory['products'][number]['variants'][number];

function formatIndividualPrices(variant: PublicPriceVariant) {
  const currencyPrices = [
    { value: variant.priceEur, currency: 'EUR' },
    { value: variant.priceRub, currency: 'RUB' },
    { value: variant.priceCny, currency: 'CNY' },
  ].filter((price) => hasPriceValue(price.value));

  if (currencyPrices.length === 0) {
    return <span className={styles.priceValue}>{formatPrice(variant.wholesalePrice)}</span>;
  }

  return (
    <span className={styles.currencyPrices}>
      {currencyPrices.map((price) => (
        <span className={styles.priceValue} key={price.currency}>
          {formatPrice(price.value)}
          <span className={styles.priceCurrency}>{price.currency}</span>
        </span>
      ))}
    </span>
  );
}

function normalizeSearchText(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function stockLabel(product: PublicWholesaleCategory['products'][number]) {
  if (product.stock > 0) return `В наличии: ${product.stock} шт.`;
  return product.isExpected ? 'Скоро поступление' : 'Под заказ';
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
  const [searchQuery, setSearchQuery] = useState('');
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
  const totalProductCount = useMemo(
    () => categories.reduce((sum, category) => sum + category.products.length, 0),
    [categories],
  );
  const groupedProducts = useMemo(() => {
    const query = normalizeSearchText(searchQuery);
    const products = categories.flatMap((category) =>
      category.products.map((product) => ({
        categoryTitle: category.title,
        groupTitle: product.priceGroup || NO_PRICE_GROUP_TITLE,
        product,
      })),
    );

    return products
      .filter(({ categoryTitle, product }) => {
        if (!query) return true;
        return [
          categoryTitle,
          product.title,
          product.sku,
          product.description,
          product.priceGroup,
          ...product.variants.map((variant) => variant.title),
        ]
          .filter(Boolean)
          .some((value) => normalizeSearchText(String(value)).includes(query));
      })
      .sort((first, second) => {
        const firstGroup = first.product.priceGroup;
        const secondGroup = second.product.priceGroup;
        if (!firstGroup && secondGroup) return 1;
        if (firstGroup && !secondGroup) return -1;
        return (
          firstGroup.localeCompare(secondGroup, 'ru') ||
          first.categoryTitle.localeCompare(second.categoryTitle, 'ru') ||
          first.product.title.localeCompare(second.product.title, 'ru')
        );
      })
      .reduce<Array<{ title: string; products: Array<{ categoryTitle: string; product: PublicWholesaleCategory['products'][number] }> }>>(
        (groups, item) => {
          const lastGroup = groups[groups.length - 1];
          if (lastGroup?.title === item.groupTitle) {
            lastGroup.products.push({ categoryTitle: item.categoryTitle, product: item.product });
          } else {
            groups.push({
              title: item.groupTitle,
              products: [{ categoryTitle: item.categoryTitle, product: item.product }],
            });
          }
          return groups;
        },
        [],
      );
  }, [categories, searchQuery]);
  const visibleProductCount = groupedProducts.reduce((sum, group) => sum + group.products.length, 0);

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
      <section className={styles.priceSearch}>
        <label>
          <span>Поиск по прайсу</span>
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Название, артикул, категория или ценовая группа"
          />
        </label>
        <p>
          Показано {visibleProductCount} из {totalProductCount}
        </p>
      </section>

      {groupedProducts.length === 0 ? (
        <section className={styles.category}>
          <p className={styles.empty}>По запросу ничего не найдено.</p>
        </section>
      ) : null}

      {groupedProducts.map((group) => (
        <section className={styles.category} key={group.title}>
          <h2>{group.title}</h2>
          <div className={styles.products}>
            {group.products.map(({ categoryTitle, product }) => (
              <article
                className={styles.product}
                key={`${group.title}-${categoryTitle}-${product.id}`}
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
                  <p className={styles.stockStatus}>{stockLabel(product)}</p>
                </div>
                <table className={styles.prices}>
                  <thead>
                    <tr>
                      {showRetailPrices ? <th>Розница</th> : null}
                      <th>Индивидуальная цена</th>
                      <th>Количество</th>
                    </tr>
                  </thead>
                  <tbody>
                    {product.variants.map((variant, index) => (
                      <tr key={`${variant.id ?? 'base'}-${index}`}>
                        {showRetailPrices ? <td>{formatPrice(variant.retailPrice)}</td> : null}
                        <td>{formatIndividualPrices(variant)}</td>
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
