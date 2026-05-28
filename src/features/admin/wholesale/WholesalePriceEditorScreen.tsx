'use client';

import type { Dispatch, SetStateAction } from 'react';

import styles from '@/app/admin/admin.module.scss';
import { WHOLESALE_PRICE_WORKFLOW_STATUSES, type WholesalePriceWorkflowStatus } from '@/shared/lib/wholesalePriceWorkflowStatus';

import {
  formatDiscountPercent,
  getGroupDiscountLimit,
  getSavedGroupDiscountPercent,
  priceGroupKey,
  renderWholesaleEditorSkeleton,
  stockLabel,
  type CatalogCategory,
  type CatalogGroup,
  type CatalogRow,
  type ClientCompanyOption,
  type Manager,
  type PriceEditor,
  type PriceItem,
} from './AdminWholesaleModel';

type RouterLike = {
  push: (href: string) => void;
};

type WholesalePriceEditorScreenProps = {
  screen: 'create' | 'edit';
  status: string;
  analyticsBackHref: string | null;
  editorBackHref: string;
  editorLoading: boolean;
  editor: PriceEditor;
  setEditor: Dispatch<SetStateAction<PriceEditor>>;
  commentRows: number;
  canManageWholesale: boolean;
  clientCompanies: ClientCompanyOption[];
  developmentManagers: Manager[];
  supportManagers: Manager[];
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
  itemByKey: Map<string, PriceItem>;
  catalogDiscountBaseByKey: Map<string, { amount: number | null; groupKey: string }>;
  calculateDiscount: (value: string, groupKey: string) => void;
  setPriceGroupVisible: (groupKey: string, visible: boolean) => void;
  setProductVisible: (productId: number, visible: boolean) => void;
  updateItem: (key: string, patch: Partial<PriceItem>) => void;
  savePriceList: () => Promise<void>;
  busy: boolean;
  router: RouterLike;
};

export function WholesalePriceEditorScreen({
  screen,
  status,
  analyticsBackHref,
  editorBackHref,
  editorLoading,
  editor,
  setEditor,
  commentRows,
  canManageWholesale,
  clientCompanies,
  developmentManagers,
  supportManagers,
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
  itemByKey,
  catalogDiscountBaseByKey,
  calculateDiscount,
  setPriceGroupVisible,
  setProductVisible,
  updateItem,
  savePriceList,
  busy,
  router,
}: WholesalePriceEditorScreenProps) {
  const selectedClientCompany =
    clientCompanies.find((company) => company.id === editor.clientCompanyId) ??
    clientCompanies.find((company) => company.title.trim().toLowerCase() === editor.clientName.trim().toLowerCase()) ??
    null;
  const hasLegacyClientName = Boolean(editor.clientName.trim() && !selectedClientCompany);

  return (
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div>
            <p>Индивидуальные прайсы</p>
            <h2>{screen === 'edit' ? 'Изменить прайс' : 'Создать оптовый прайс'}</h2>
          </div>
          <div className={styles.topbarActions}>
            {analyticsBackHref ? (
              <button className={styles.secondary} type="button" onClick={() => router.push(analyticsBackHref)}>
                Вернуться в аналитику
              </button>
            ) : null}
            <button className={styles.secondary} type="button" onClick={() => router.push(editorBackHref)}>
              Вернуться в панель управления
            </button>
          </div>
        </div>

        {status ? <p className={styles.status}>{status}</p> : null}

        {editorLoading ? (
          renderWholesaleEditorSkeleton()
        ) : (
          <>
        <div className={styles.wholesaleEditorGrid}>
          <label>
            <span>Название прайса</span>
            <input value={editor.title} onChange={(event) => setEditor({ ...editor, title: event.target.value })} />
          </label>
          <label>
            <span>Клиент / компания</span>
            <select
              value={selectedClientCompany?.id ?? ''}
              onChange={(event) => {
                const companyId = Number(event.target.value);
                const company = clientCompanies.find((item) => item.id === companyId) ?? null;
                setEditor({
                  ...editor,
                  clientCompanyId: company?.id ?? null,
                  clientName: company?.title ?? '',
                });
              }}
              disabled={clientCompanies.length === 0}
            >
              <option value="">Выберите клиента</option>
              {clientCompanies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.title}
                </option>
              ))}
            </select>
            {hasLegacyClientName ? (
              <span className={styles.fieldHint}>Текущий клиент не выбран из списка: {editor.clientName}</span>
            ) : null}
          </label>
          <label>
            <span>Token ссылки</span>
            <input
              value={editor.token}
              disabled={screen === 'edit'}
              onChange={(event) => setEditor({ ...editor, token: event.target.value })}
            />
          </label>
          <label>
            <span>Срок действия</span>
            <input type="date" value={editor.validUntil} onChange={(event) => setEditor({ ...editor, validUntil: event.target.value })} />
          </label>
          <label>
            <span>Статус прайса</span>
            <select
              value={editor.workflowStatus}
              onChange={(event) => setEditor({ ...editor, workflowStatus: event.target.value as WholesalePriceWorkflowStatus })}
            >
              {WHOLESALE_PRICE_WORKFLOW_STATUSES.map((statusItem) => (
                <option key={statusItem.value} value={statusItem.value}>
                  {statusItem.label}
                </option>
              ))}
            </select>
          </label>
          {canManageWholesale && (
            <label>
              <span>Менеджер</span>
              <select value={editor.managerId ?? ''} onChange={(event) => setEditor({ ...editor, managerId: event.target.value ? Number(event.target.value) : null })}>
                <option value="">Не назначен</option>
                {developmentManagers.map((manager) => (
                  <option key={manager.id} value={manager.id}>{manager.name}</option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span>Менеджер по сопровождению</span>
            <select
              required
              value={editor.supportManagerId ?? ''}
              onChange={(event) => setEditor({ ...editor, supportManagerId: event.target.value ? Number(event.target.value) : null })}
              disabled={supportManagers.length === 0}
            >
              <option value="">Не выбран</option>
              {supportManagers.map((manager) => (
                <option key={manager.id} value={manager.id}>{manager.name || manager.login}</option>
              ))}
            </select>
          </label>
          <label className={styles.wholesaleWide}>
            <span>Комментарий</span>
            <textarea rows={commentRows} value={editor.comment} onChange={(event) => setEditor({ ...editor, comment: event.target.value })} />
          </label>
          <label className={styles.checkbox}>
            <input type="checkbox" checked={editor.isActive} onChange={(event) => setEditor({ ...editor, isActive: event.target.checked })} />
            Активен
          </label>
          <label className={styles.checkbox}>
            <input type="checkbox" checked={editor.showStock} onChange={(event) => setEditor({ ...editor, showStock: event.target.checked })} />
            Показывать остатки цифрами
          </label>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={editor.showStockText}
              onChange={(event) => setEditor({ ...editor, showStockText: event.target.checked })}
            />
            Показывать остатки текстом
          </label>
          <label className={styles.checkbox}>
            <input type="checkbox" checked={editor.showRetailPrices} onChange={(event) => setEditor({ ...editor, showRetailPrices: event.target.checked })} />
            Показать розничные цены
          </label>
        </div>

        {catalog.length === 0 ? (
          <p className={styles.mutedText}>В базе прайс-товаров пока нет позиций. Сначала нужно добавить отдельные wholesale-товары.</p>
        ) : (
          <>
            <div className={styles.wholesaleCatalogTools}>
              <label>
                <span>Поиск товаров</span>
                <input
                  value={catalogQuery}
                  onChange={(event) => setCatalogQuery(event.target.value)}
                  placeholder="Название, бренд, категория или артикул"
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
                const groupDiscountPercent =
                  appliedGroupDiscounts[group.id] ?? getSavedGroupDiscountPercent(group, itemByKey, catalogDiscountBaseByKey);
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
                            {groupDiscountPercent ? (
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
                                        <input value={item?.customWholesalePrice ?? ''} disabled readOnly />
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
        )}

        <div className={styles.actions}>
          <button disabled={busy} onClick={savePriceList}>Сохранить прайс</button>
          <button className={styles.secondary} onClick={() => router.push(editorBackHref)}>Отмена</button>
        </div>
          </>
        )}
      </section>
    );
}
