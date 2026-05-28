'use client';

import type { Dispatch, SetStateAction } from 'react';

import styles from '@/app/admin/admin.module.scss';

import {
  renderWholesaleEditorSkeleton,
  type CatalogCategory,
  type CatalogGroup,
  type CatalogRow,
  type ClientCompanyOption,
  type Manager,
  type PriceEditor,
  type PriceItem,
} from './AdminWholesaleModel';
import { WholesalePriceCatalogPanel } from './WholesalePriceCatalogPanel';
import { WholesalePriceEditorDetails } from './WholesalePriceEditorDetails';

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
          <WholesalePriceEditorDetails
            screen={screen}
            editor={editor}
            setEditor={setEditor}
            commentRows={commentRows}
            canManageWholesale={canManageWholesale}
            clientCompanies={clientCompanies}
            developmentManagers={developmentManagers}
            supportManagers={supportManagers}
          />

          <WholesalePriceCatalogPanel
            catalog={catalog}
            catalogQuery={catalogQuery}
            setCatalogQuery={setCatalogQuery}
            catalogCategoryId={catalogCategoryId}
            setCatalogCategoryId={setCatalogCategoryId}
            catalogPriceGroup={catalogPriceGroup}
            setCatalogPriceGroup={setCatalogPriceGroup}
            catalogPriceGroups={catalogPriceGroups}
            filteredCatalogGroups={filteredCatalogGroups}
            filteredCatalogRows={filteredCatalogRows}
            catalogRows={catalogRows}
            expandedPriceGroups={expandedPriceGroups}
            togglePriceGroupExpanded={togglePriceGroupExpanded}
            groupDiscounts={groupDiscounts}
            appliedGroupDiscounts={appliedGroupDiscounts}
            setGroupDiscounts={setGroupDiscounts}
            editor={editor}
            setEditor={setEditor}
            itemByKey={itemByKey}
            catalogDiscountBaseByKey={catalogDiscountBaseByKey}
            calculateDiscount={calculateDiscount}
            setPriceGroupVisible={setPriceGroupVisible}
            setProductVisible={setProductVisible}
            updateItem={updateItem}
          />

          <div className={styles.actions}>
            <button disabled={busy} onClick={savePriceList}>Сохранить прайс</button>
            <button className={styles.secondary} onClick={() => router.push(editorBackHref)}>Отмена</button>
          </div>
        </>
      )}
    </section>
  );
}
