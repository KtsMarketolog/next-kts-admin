'use client';

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import type { PublicWholesaleCategory } from '@/shared/lib/db';
import { hasVisibleWholesaleStock } from '@/shared/lib/wholesaleStockDisplay';

import {
  NO_PRICE_GROUP_TITLE,
  formatAmountList,
  formatPrice,
  formatRetryAfter,
  formatRubAmount,
  getConvertedRubAmount,
  getCurrencyPriceValues,
  getVariantRequestPrices,
  hasPriceValue,
  isExchangeRatesPayload,
  normalizeQuantityInput,
  normalizeSearchText,
  resizeTextarea,
  stockLabel,
  trackPriceEvent,
} from './PriceRequestForm.helpers';
import type { ExchangeRates, ExchangeRateStatus, PublicPriceVariant, RubConversionRequest } from './PriceRequestForm.helpers';
import styles from './PricePage.module.scss';

type PriceRequestFormProps = {
  token: string;
  categories: PublicWholesaleCategory[];
  showRetailPrices: boolean;
};

function formatIndividualPrices(variant: PublicPriceVariant, exchangeRates: ExchangeRates | null, showLabel = false) {
  const currencyPrices = getCurrencyPriceValues(variant).filter((price) => hasPriceValue(price.value));

  if (currencyPrices.length === 0) {
    return (
      <span className={styles.priceLine}>
        {showLabel ? <span className={styles.priceLabel}>Индивидуальная цена</span> : null}
        <span className={styles.priceValue}>{formatPrice(variant.wholesalePrice)}</span>
      </span>
    );
  }

  return (
    <span className={styles.priceLine}>
      {showLabel ? <span className={styles.priceLabel}>Индивидуальная цена</span> : null}
      <span className={styles.currencyPrices}>
        {currencyPrices.map((price) => {
          const convertedRubAmount = getConvertedRubAmount(price, exchangeRates);

          return (
            <span className={styles.priceValue} key={price.currency}>
              {formatPrice(price.value)}
              <span className={styles.priceCurrency}>{price.currency}</span>
              {convertedRubAmount !== null ? (
                <span className={styles.convertedPrice}>
                  ≈ {formatRubAmount(convertedRubAmount)}
                  <span className={styles.priceCurrency}>RUB</span>
                </span>
              ) : null}
            </span>
          );
        })}
      </span>
    </span>
  );
}

function formatRetailPrice(variant: PublicPriceVariant) {
  if (!hasPriceValue(variant.retailPrice)) {
    return null;
  }

  return (
    <span className={styles.priceValue}>
      {formatPrice(variant.retailPrice)}
      <span className={styles.priceCurrency}>RUB</span>
    </span>
  );
}

export function PriceRequestForm({ token, categories, showRetailPrices }: PriceRequestFormProps) {
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [comment, setComment] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedPriceGroups, setExpandedPriceGroups] = useState<Record<string, boolean>>({});
  const [rubConversionGroups, setRubConversionGroups] = useState<Record<string, boolean>>({});
  const [exchangeRates, setExchangeRates] = useState<ExchangeRates | null>(null);
  const [exchangeRateStatus, setExchangeRateStatus] = useState<ExchangeRateStatus>('idle');
  const [exchangeRateError, setExchangeRateError] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const commentRef = useRef<HTMLTextAreaElement | null>(null);
  const openedProductsRef = useRef<Set<number>>(new Set());
  const requestStartedRef = useRef(false);
  const submittedRef = useRef(false);
  const submittingRef = useRef(false);
  const selectionRef = useRef({ selectedItems: 0, totalQuantity: 0 });

  const selectedItems = useMemo(
    () =>
      Object.entries(quantities)
        .map(([id, quantity]) => ({ id: Number(id), quantity }))
        .filter((item) => Number.isInteger(item.id) && item.id > 0 && item.quantity > 0),
    [quantities],
  );

  const totalQuantity = selectedItems.reduce((sum, item) => sum + item.quantity, 0);
  const variantsByPriceItemId = useMemo(() => {
    const variants = new Map<number, PublicPriceVariant>();
    for (const category of categories) {
      for (const product of category.products) {
        for (const variant of product.variants) {
          variants.set(variant.priceItemId, variant);
        }
      }
    }
    return variants;
  }, [categories]);
  const priceGroupByPriceItemId = useMemo(() => {
    const groups = new Map<number, string>();
    for (const category of categories) {
      for (const product of category.products) {
        const groupTitle = product.priceGroup || NO_PRICE_GROUP_TITLE;
        for (const variant of product.variants) {
          groups.set(variant.priceItemId, groupTitle);
        }
      }
    }
    return groups;
  }, [categories]);
  const requestTotalLabel = useMemo(() => {
    const totals = new Map<string, number>();
    for (const item of selectedItems) {
      const variant = variantsByPriceItemId.get(item.id);
      if (!variant) continue;
      for (const price of getVariantRequestPrices(variant)) {
        totals.set(price.currency, (totals.get(price.currency) ?? 0) + price.amount * item.quantity);
      }
    }
    return formatAmountList(Array.from(totals.entries()).map(([currency, amount]) => ({ currency, amount })));
  }, [selectedItems, variantsByPriceItemId]);
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
      .reduce<
        Array<{
          title: string;
          imageUrl: string | null;
          products: Array<{ categoryTitle: string; product: PublicWholesaleCategory['products'][number] }>;
        }>
      >(
        (groups, item) => {
          const groupImageUrl = item.product.priceGroupImageUrl || item.product.imageUrl;
          const lastGroup = groups[groups.length - 1];
          if (lastGroup?.title === item.groupTitle) {
            if (!lastGroup.imageUrl && groupImageUrl) {
              lastGroup.imageUrl = groupImageUrl;
            }
            lastGroup.products.push({ categoryTitle: item.categoryTitle, product: item.product });
          } else {
            groups.push({
              title: item.groupTitle,
              imageUrl: groupImageUrl,
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
    resizeTextarea(commentRef.current);
  }, [comment]);

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

  const togglePriceGroupExpanded = (groupTitle: string) => {
    setExpandedPriceGroups((current) => ({
      ...current,
      [groupTitle]: !current[groupTitle],
    }));
  };

  const loadExchangeRates = async () => {
    if (exchangeRates || exchangeRateStatus === 'loading') return;

    setExchangeRateStatus('loading');
    setExchangeRateError('');

    try {
      const response = await fetch('/api/currency-rates', { cache: 'no-store' });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !isExchangeRatesPayload(payload)) {
        throw new Error('Invalid currency rate response');
      }
      setExchangeRates(payload);
      setExchangeRateStatus('ready');
    } catch {
      setExchangeRateStatus('error');
      setExchangeRateError('Не удалось загрузить курс ЦБ. Попробуйте позже.');
    }
  };

  const toggleRubConversion = (groupTitle: string) => {
    const shouldEnable = rubConversionGroups[groupTitle] !== true;
    setRubConversionGroups((current) => ({
      ...current,
      [groupTitle]: shouldEnable,
    }));

    if (shouldEnable) {
      void loadExchangeRates();
    }
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
    if (submittingRef.current) return;
    if (selectedItems.length === 0) {
      setStatus('Выберите количество хотя бы у одной позиции');
      return;
    }

    submittingRef.current = true;
    setBusy(true);
    setStatus('');
    try {
      const convertedItemIds =
        exchangeRates && exchangeRateStatus === 'ready'
          ? selectedItems
              .filter((item) => {
                const groupTitle = priceGroupByPriceItemId.get(item.id);
                return Boolean(groupTitle && rubConversionGroups[groupTitle]);
              })
              .map((item) => item.id)
          : [];
      const rubConversion: RubConversionRequest | null =
        convertedItemIds.length > 0 && exchangeRates
          ? {
              date: exchangeRates.date,
              rates: exchangeRates.rates,
              itemIds: convertedItemIds,
            }
          : null;
      const response = await fetch(`/api/price/${encodeURIComponent(token)}/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: selectedItems, comment: comment.trim(), rubConversion }),
      });

      if (!response.ok) {
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get('Retry-After'));
          setStatus(`Слишком много заявок. Попробуйте через ${formatRetryAfter(retryAfter)}.`);
        } else {
          setStatus('Не удалось отправить заявку. Проверьте интернет и попробуйте еще раз.');
        }
        return;
      }

      setQuantities({});
      setComment('');
      submittedRef.current = true;
      requestStartedRef.current = false;
      setStatus('Заявка отправлена');
    } catch {
      setStatus('Не удалось отправить заявку. Проверьте интернет и попробуйте еще раз.');
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
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

      {groupedProducts.map((group) => {
        const isExpanded = expandedPriceGroups[group.title] === true;
        const isRubConversionActive = rubConversionGroups[group.title] === true;
        const activeExchangeRates = isRubConversionActive && exchangeRates ? exchangeRates : null;

        return (
          <section className={styles.category} key={group.title}>
            <div className={styles.categoryHeader}>
              <div className={styles.categoryTitle}>
                <div className={styles.groupImageBox}>
                  {group.imageUrl ? <img src={group.imageUrl} alt="" /> : <span>Нет фото</span>}
                </div>
                <div>
                  <h2>{group.title}</h2>
                  <span className={styles.categoryMeta}>
                    Товаров - {group.products.length}
                  </span>
                </div>
              </div>
              <button
                className={styles.categoryToggle}
                type="button"
                onClick={() => togglePriceGroupExpanded(group.title)}
                aria-expanded={isExpanded}
              >
                {isExpanded ? 'Скрыть' : 'Раскрыть'}
              </button>
            </div>
            {isExpanded ? (
              <>
                <div className={styles.conversionBar}>
                  <button
                    type="button"
                    className={styles.conversionButton}
                    onClick={() => toggleRubConversion(group.title)}
                    disabled={isRubConversionActive && exchangeRateStatus === 'loading'}
                  >
                    {isRubConversionActive ? 'Скрыть пересчет в рубли' : 'Пересчитать в рубли по сегодняшнему курсу'}
                  </button>
                  {isRubConversionActive && exchangeRateStatus === 'loading' ? <span>Загружаем курс ЦБ...</span> : null}
                  {isRubConversionActive && exchangeRateStatus === 'ready' && exchangeRates ? (
                    <span>
                      Курс ЦБ на {exchangeRates.date || 'сегодня'}: EUR {formatPrice(String(exchangeRates.rates.EUR))}, CNY{' '}
                      {formatPrice(String(exchangeRates.rates.CNY))}
                    </span>
                  ) : null}
                  {isRubConversionActive && exchangeRateStatus === 'error' ? <span className={styles.conversionError}>{exchangeRateError}</span> : null}
                </div>
                <div className={styles.products}>
                {group.products.map(({ categoryTitle, product }) => (
                  <article
                    className={styles.product}
                    key={`${group.title}-${categoryTitle}-${product.id}`}
                    onFocusCapture={() => trackProductOpen(product)}
                    onMouseEnter={() => trackProductOpen(product)}
                  >
                    <div className={styles.productInfo}>
                      <h3>{product.title}</h3>
                      {product.sku ? <p>Артикул: {product.sku}</p> : null}
                      {product.description ? <p>{product.description}</p> : null}
                      {hasVisibleWholesaleStock(product.stockDisplayMode) ? <p className={styles.stockStatus}>{stockLabel(product)}</p> : null}
                    </div>
                    <table className={styles.prices}>
                      <thead>
                        <tr>
                          <th>{showRetailPrices ? 'Цена' : 'Индивидуальная цена'}</th>
                          <th>Количество</th>
                        </tr>
                      </thead>
                      <tbody>
                        {product.variants.map((variant, index) => {
                          const currentQuantity = quantities[variant.priceItemId] || 0;
                          const retailPrice = showRetailPrices ? formatRetailPrice(variant) : null;

                          return (
                            <tr key={`${variant.id ?? 'base'}-${index}`}>
                              <td>
                                <span className={styles.priceStack}>
                                  {formatIndividualPrices(variant, activeExchangeRates, showRetailPrices)}
                                  {retailPrice ? (
                                    <span className={styles.priceLine}>
                                      <span className={styles.priceLabel}>Розничная цена</span>
                                      {retailPrice}
                                    </span>
                                  ) : null}
                                </span>
                              </td>
                              <td className={styles.quantityCell}>
                                <div className={styles.quantityStepper}>
                                  <button
                                    type="button"
                                    className={styles.quantityButton}
                                    onClick={() => changeQuantity(variant.priceItemId, Math.max(0, currentQuantity - 1), product.title)}
                                    aria-label="Уменьшить количество"
                                  >
                                    -1
                                  </button>
                                  <input
                                    className={styles.quantityValue}
                                    type="number"
                                    inputMode="numeric"
                                    min={0}
                                    max={999}
                                    step={1}
                                    value={currentQuantity}
                                    onChange={(event) => changeQuantity(variant.priceItemId, normalizeQuantityInput(event.target.value), product.title)}
                                    onFocus={(event) => event.currentTarget.select()}
                                    aria-label={`Количество для ${product.title}`}
                                  />
                                  <button
                                    type="button"
                                    className={styles.quantityButton}
                                    onClick={() => changeQuantity(variant.priceItemId, Math.min(999, currentQuantity + 1), product.title)}
                                    aria-label="Увеличить количество"
                                  >
                                    +1
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </article>
                ))}
                </div>
              </>
            ) : null}
          </section>
        );
      })}

      <section className={styles.requestBar}>
        <div>
          <strong>Позиций в заявке: {selectedItems.length}</strong>
          <span>Общее количество: {totalQuantity}</span>
          <span>Общая сумма: {requestTotalLabel}</span>
        </div>
        <label className={styles.requestComment}>
          <span>Комментарий к заявке</span>
          <textarea
            ref={commentRef}
            rows={2}
            value={comment}
            maxLength={1000}
            placeholder="Например: условия доставки, сроки, уточнения по заказу"
            onChange={(event) => {
              setComment(event.target.value);
              resizeTextarea(event.currentTarget);
            }}
          />
        </label>
        <button className={styles.requestButton} type="submit" disabled={busy}>
          {busy ? 'Отправка...' : 'Отправить заявку'}
        </button>
      </section>
      {status ? <p className={styles.requestStatus}>{status}</p> : null}
    </form>
  );
}
