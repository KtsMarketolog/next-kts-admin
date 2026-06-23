import type { Dispatch, SetStateAction } from 'react';

import styles from '@/app/admin/admin.module.scss';

import {
  formatDiscountPercent,
  getGroupDiscountLimit,
  getSavedGroupDiscountPercent,
  groupHasManualWholesalePrices,
  priceGroupKey,
  stockLabel,
  type CatalogCategory,
  type CatalogGroup,
  type CatalogRow,
  type PriceEditor,
  type PriceItem,
} from './AdminWholesaleModel';

type WholesalePriceCatalogPanelProps = {
  catalog: CatalogCategory[];
  catalogQuery: string;
  setCatalogQuery: (value: string) => void;
  catalogCategoryId: string;
  setCatalogCategoryId: (value: string) => void;
  catalogPriceGroup: string;
  setCatalogPriceGroup: (value: string) => void;
  catalogPriceGroups: string[];
  filteredCatalogGroups: CatalogGroup[];
  filteredCatalogRows: CatalogRow[];
  catalogRows: CatalogRow[];
  expandedPriceGroups: Record<string, boolean>;
  togglePriceGroupExpanded: (groupKey: string) => void;
  groupDiscounts: Record<string, string>;
  appliedGroupDiscounts: Record<string, string>;
  setGroupDiscounts: Dispatch<SetStateAction<Record<string, string>>>;
  editor: PriceEditor;
  setEditor: Dispatch<SetStateAction<PriceEditor>>;
  itemByKey: Map<string, PriceItem>;
  catalogDiscountBaseByKey: Map<string, { amount: number | null; groupKey: string }>;
  calculateDiscount: (value: string, groupKey: string) => void;
  setPriceGroupVisible: (groupKey: string, visible: boolean) => void;
  setProductVisible: (productId: number, visible: boolean) => void;
  updateItem: (key: string, patch: Partial<PriceItem>) => void;
};

export function WholesalePriceCatalogPanel({
  catalog,
  catalogQuery,
  setCatalogQuery,
  catalogCategoryId,
  setCatalogCategoryId,
  catalogPriceGroup,
  setCatalogPriceGroup,
  catalogPriceGroups,
  filteredCatalogGroups,
  filteredCatalogRows,
  catalogRows,
  expandedPriceGroups,
  togglePriceGroupExpanded,
  groupDiscounts,
  appliedGroupDiscounts,
  setGroupDiscounts,
  editor,
  setEditor,
  itemByKey,
  catalogDiscountBaseByKey,
  calculateDiscount,
  setPriceGroupVisible,
  setProductVisible,
  updateItem,
}: WholesalePriceCatalogPanelProps) {
  if (catalog.length === 0) {
    return (
      <p className={styles.mutedText}>
        В базе прайс-товаров пока нет позиций. Сначала нужно добавить отдельные wholesale-товары.
      </p>
    );
  }

  return (
    <>
      <div className={styles.wholesaleCatalogTools}>
        <label>
          <span>Поиск товаров</span>
          <input
            value={catalogQuery}
            onChange={(event) => setCatalogQuery(event.target.value)}
            placeholder="Название, модель, бренд, категория или артикул"
          />
        </label>
        <label>
          <span>Категория</span>
          <select value={catalogCategoryId} onChange={(event) => setCatalogCategoryId(event.target.value)}>
            <option value="all">Все категории</option>
            {catalog.map((category) => (
              <option key={category.id} value={category.id}>
                {category.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Ценовая группа</span>
          <select value={catalogPriceGroup} onChange={(event) => setCatalogPriceGroup(event.target.value)}>
            <option value="all">Все группы</option>
            {catalogPriceGroups.map((group) => (
              <option key={group} value={group}>
                {group}
              </option>
            ))}
          </select>
        </label>
        <p>
          Ценовых групп: {filteredCatalogGroups.length}. Позиции: {filteredCatalogRows.length} из {catalogRows.length}.
        </p>
      </div>

      {filteredCatalogRows.length === 0 ? (
        <p className={styles.mutedText}>По выбранному фильтру товары не найдены.</p>
      ) : (
        filteredCatalogGroups.map((group) => {
          const isExpanded = expandedPriceGroups[group.id] === true;
          const groupAddedCount = group.products.reduce(
            (sum, product) =>
              sum +
              product.variants.filter((variant) => {
                const key = `${product.id}:${variant.id ?? 'base'}`;
                return Boolean(itemByKey.get(key)?.visible);
              }).length,
            0,
          );
          const hasManualGroupPrice = groupHasManualWholesalePrices(group, itemByKey);
          const groupDiscountPercent = hasManualGroupPrice
            ? null
            : (appliedGroupDiscounts[group.id] ?? getSavedGroupDiscountPercent(group, itemByKey, catalogDiscountBaseByKey));
          const groupMaxDiscount = getGroupDiscountLimit(group);
          const groupStockKey = priceGroupKey(group.title);
          const groupStockSetting = editor.priceGroupStockSettings[groupStockKey] ?? {
            priceGroup: group.title,
            showStock: false,
            showStockText: false,
          };
          const updateGroupStockSetting = (patch: Partial<typeof groupStockSetting>) => {
            setEditor((current) => {
              const currentSetting = current.priceGroupStockSettings[groupStockKey] ?? {
                priceGroup: group.title,
                showStock: false,
                showStockText: false,
              };
              const nextSetting = { ...currentSetting, ...patch, priceGroup: group.title };
              const nextSettings = { ...current.priceGroupStockSettings };
              if (nextSetting.showStock || nextSetting.showStockText) {
                nextSettings[groupStockKey] = nextSetting;
              } else {
                delete nextSettings[groupStockKey];
              }
              return { ...current, priceGroupStockSettings: nextSettings };
            });
          };

          return (
            <div className={styles.priceCategory} key={group.id}>
              <div className={styles.priceCategoryHeader}>
                <div className={styles.priceCategoryTitle}>
                  <div className={styles.priceGroupImageBox}>
                    {group.imageUrl ? <img src={group.imageUrl} alt="" /> : <span>Нет фото</span>}
                  </div>
                  <div>
                    <h3>{group.title}</h3>
                    <span className={styles.priceCategoryMeta}>
                      <span>Товаров: всего - {group.products.length}</span>
                      <span className={`${styles.priceCategoryAdded} ${groupAddedCount > 0 ? styles.priceCategoryAddedActive : ''}`}>
                        добавлено - {groupAddedCount}
                      </span>
                      {hasManualGroupPrice ? (
                        <span className={styles.priceCategoryDiscount}>ручная скидка</span>
                      ) : groupDiscountPercent ? (
                        <span className={styles.priceCategoryDiscount}>скидка - {groupDiscountPercent}%</span>
                      ) : null}
                    </span>
                  </div>
                </div>
                <button
                  className={`${styles.secondary} ${styles.priceCategoryToggle}`}
                  type="button"
                  onClick={() => togglePriceGroupExpanded(group.id)}
                  aria-expanded={isExpanded}
                >
                  {isExpanded ? 'Скрыть' : 'Раскрыть'}
                </button>
              </div>

              {isExpanded ? (
                <>
                  <div className={styles.priceGroupTools}>
                    <div className={styles.priceGroupDiscount}>
                      <span>Скидка для группы, %</span>
                      <input
                        value={groupDiscounts[group.id] ?? ''}
                        onChange={(event) =>
                          setGroupDiscounts((current) => ({
                            ...current,
                            [group.id]: event.target.value,
                          }))
                        }
                        inputMode="decimal"
                        placeholder={
                          groupMaxDiscount === null
                            ? 'рекомендованная максимальная скидка не задана'
                            : `рекомендованная максимальная скидка ${formatDiscountPercent(groupMaxDiscount)}`
                        }
                      />
                      <button className={styles.secondary} onClick={() => calculateDiscount(groupDiscounts[group.id] ?? '', group.id)}>
                        Рассчитать
                      </button>
                    </div>
                    <div className={styles.priceGroupStockOptions}>
                      <span>Остатки в прайсе</span>
                      <label className={styles.checkbox}>
                        <input
                          type="checkbox"
                          checked={groupStockSetting.showStock}
                          onChange={(event) => updateGroupStockSetting({ showStock: event.target.checked })}
                        />
                        Цифрами
                      </label>
                      <label className={styles.checkbox}>
                        <input
                          type="checkbox"
                          checked={groupStockSetting.showStockText}
                          onChange={(event) => updateGroupStockSetting({ showStockText: event.target.checked })}
                        />
                        Текстом
                      </label>
                    </div>
                    <div className={styles.priceGroupVisibility}>
                      <button className={styles.secondary} onClick={() => setPriceGroupVisible(group.id, true)}>Показать все</button>
                      <button className={styles.secondary} onClick={() => setPriceGroupVisible(group.id, false)}>Убрать все</button>
                    </div>
                  </div>
                  <div className={styles.priceGroupProducts}>
                    {group.products.map((product) => {
                      const hasSeveralPositions = product.variants.length > 1;

                      return (
                        <article className={styles.priceProduct} key={product.id}>
                          <div className={styles.priceProductInfo}>
                            <div>
                              <strong>{product.title}</strong>
                              {product.model ? <p>Модель: {product.model}</p> : null}
                              {product.sku ? <p>Арт.: {product.sku}</p> : null}
                              {product.description ? <p>{product.description}</p> : null}
                              {hasSeveralPositions ? (
                                <div className={styles.actions}>
                                  <button className={styles.secondary} onClick={() => setProductVisible(product.id, true)}>Показать все позиции</button>
                                  <button className={styles.secondary} onClick={() => setProductVisible(product.id, false)}>Убрать все позиции</button>
                                </div>
                              ) : null}
                            </div>
                          </div>
                          <div className={styles.variantTable}>
                            <div>EUR</div>
                            <div>RUB</div>
                            <div>CNY</div>
                            <div>Остаток</div>
                            <div>Цена в прайсе</div>
                            <div>Показ</div>
                            {product.variants.map((variant) => {
                              const key = `${product.id}:${variant.id ?? 'base'}`;
                              const item = itemByKey.get(key);
                              return (
                                <div className={styles.variantRow} key={key}>
                                  <span>{product.priceEur || '—'}</span>
                                  <span>{product.priceRub || '—'}</span>
                                  <span>{product.priceCny || '—'}</span>
                                  <span>{stockLabel(product)}</span>
                                  <input
                                    value={item?.customWholesalePrice ?? ''}
                                    onChange={(event) => updateItem(key, { customWholesalePrice: event.target.value })}
                                    inputMode="decimal"
                                  />
                                  <label className={styles.checkbox}>
                                    <input type="checkbox" checked={Boolean(item?.visible)} onChange={(event) => updateItem(key, { visible: event.target.checked })} />
                                    Показывать
                                  </label>
                                </div>
                              );
                            })}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </>
              ) : null}
            </div>
          );
        })
      )}
    </>
  );
}
