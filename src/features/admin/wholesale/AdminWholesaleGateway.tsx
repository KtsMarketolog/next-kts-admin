'use client';

import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import styles from '@/app/admin/admin.module.scss';
import { shortToken } from '@/shared/lib/wholesaleSecurity';
import {
  getWholesalePriceWorkflowStatusLabel,
  WHOLESALE_PRICE_WORKFLOW_STATUSES,
  type WholesalePriceWorkflowStatus,
} from '@/shared/lib/wholesalePriceWorkflowStatus';
import { AdminManagerAnalytics } from './AdminManagerAnalytics';
import { AdminWholesaleAnalytics, type AdminWholesaleAnalyticsTab } from './AdminWholesaleAnalytics';

type Manager = {
  id: number;
  name: string;
  login: string;
  email: string;
  phone: string;
  isActive: boolean;
  priceListCount: number;
  password?: string;
};

type PriceList = {
  id: number;
  title: string;
  clientName: string;
  token: string;
  validUntil: string | null;
  workflowStatus: WholesalePriceWorkflowStatus;
  workflowStatusLabel: string;
  showRetailPrices: boolean;
  isActive: boolean;
  managerId: number | null;
  managerName: string | null;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  lastChangedAt: string | null;
  lastChangedTitle: string | null;
  lastChangedByName: string | null;
};

type CatalogVariant = {
  id: number | null;
  title: string;
  retailPrice: string | null;
  wholesalePrice: string | null;
};

type CatalogProduct = {
  id: number;
  title: string;
  sku: string;
  description: string;
  imageUrl: string | null;
  priceGroup: string;
  priceEur: string | null;
  priceRub: string | null;
  priceCny: string | null;
  variants: CatalogVariant[];
};

type CatalogCategory = {
  id: number;
  title: string;
  products: CatalogProduct[];
};

type PriceItem = {
  productId: number;
  variantId: number | null;
  customWholesalePrice: string | null;
  visible: boolean;
  sortOrder: number;
};

type PriceEditor = {
  id?: number;
  title: string;
  clientName: string;
  token: string;
  validUntil: string;
  comment: string;
  workflowStatus: WholesalePriceWorkflowStatus;
  showRetailPrices: boolean;
  isActive: boolean;
  managerId: number | null;
  items: PriceItem[];
};

type AdminWholesaleGatewayProps = {
  canManageWholesale?: boolean;
  onBack: () => void;
};

type CurrentManager = {
  id: number;
  name: string;
  login: string;
  email: string;
  phone: string;
};

const emptyManager = {
  name: '',
  login: '',
  email: '',
  phone: '',
  password: '',
  isActive: true,
};

const CATALOG_PAGE_SIZE = 120;
const NO_PRICE_GROUP_TITLE = 'Без ценовой группы';

function makeToken() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function getDefaultPriceTitle() {
  return `Прайс от ${new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow' }).format(new Date())}`;
}

function emptyEditor(): PriceEditor {
  return {
    title: getDefaultPriceTitle(),
    clientName: '',
    token: makeToken(),
    validUntil: '',
    comment: '',
    workflowStatus: 'not_sent',
    showRetailPrices: false,
    isActive: true,
    managerId: null,
    items: [],
  };
}

function formatDate(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ru-RU');
}

function renderLastPriceChange(item: PriceList) {
  if (!item.lastChangedAt) return '—';

  return (
    <>
      {formatDate(item.lastChangedAt)}
      {item.lastChangedByName ? (
        <>
          <br />
          <span>{item.lastChangedByName}</span>
        </>
      ) : null}
    </>
  );
}

function flatCatalogItems(categories: CatalogCategory[]) {
  return categories.flatMap((category) =>
    category.products.flatMap((product) =>
      product.variants.map((variant) => ({
        category,
        product,
        variant,
        key: `${product.id}:${variant.id ?? 'base'}`,
      })),
    ),
  );
}

type CatalogRow = ReturnType<typeof flatCatalogItems>[number];

type CatalogGroup = {
  id: string;
  title: string;
  products: CatalogProduct[];
};

function groupCatalogRowsByPriceGroup(rows: CatalogRow[]) {
  const groups = new Map<string, CatalogGroup>();
  const products = new Map<string, CatalogProduct>();

  for (const row of rows) {
    const groupTitle = row.product.priceGroup || NO_PRICE_GROUP_TITLE;
    const groupKey = groupTitle.toLowerCase();
    let group = groups.get(groupKey);
    if (!group) {
      group = { id: groupKey, title: groupTitle, products: [] };
      groups.set(groupKey, group);
    }

    const productKey = `${groupKey}:${row.product.id}`;
    let product = products.get(productKey);
    if (!product) {
      product = { ...row.product, variants: [] };
      products.set(productKey, product);
      group.products.push(product);
    }

    product.variants.push(row.variant);
  }

  return Array.from(groups.values());
}

function parseCatalogAmount(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, '').replace(',', '.');
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function formatCatalogAmount(value: number) {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function getDiscountBaseAmount(row: CatalogRow) {
  return (
    parseCatalogAmount(row.product.priceRub) ??
    parseCatalogAmount(row.variant.retailPrice) ??
    parseCatalogAmount(row.variant.wholesalePrice) ??
    parseCatalogAmount(row.product.priceEur) ??
    parseCatalogAmount(row.product.priceCny)
  );
}

function getTextareaRows(value: string) {
  const visualRows = value.split(/\r\n|\r|\n/).reduce((total, line) => total + Math.max(1, Math.ceil(line.length / 120)), 0);
  return Math.max(2, visualRows + 1);
}

function mergeEditorItems(categories: CatalogCategory[], items: PriceItem[]) {
  const current = new Map(items.map((item) => [`${item.productId}:${item.variantId ?? 'base'}`, item]));
  return flatCatalogItems(categories).map(({ product, variant }, index) => {
    const key = `${product.id}:${variant.id ?? 'base'}`;
    return (
      current.get(key) ?? {
        productId: product.id,
        variantId: variant.id,
        customWholesalePrice: variant.wholesalePrice,
        visible: false,
        sortOrder: index + 1,
      }
    );
  });
}

export function AdminWholesaleGateway({ canManageWholesale = true, onBack }: AdminWholesaleGatewayProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [managers, setManagers] = useState<Manager[]>([]);
  const [currentManager, setCurrentManager] = useState<CurrentManager | null>(null);
  const [managerDraft, setManagerDraft] = useState(emptyManager);
  const [priceLists, setPriceLists] = useState<PriceList[]>([]);
  const [catalog, setCatalog] = useState<CatalogCategory[]>([]);
  const [editor, setEditor] = useState<PriceEditor>(() => emptyEditor());
  const [discount, setDiscount] = useState('');
  const [groupDiscounts, setGroupDiscounts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [savedManagerId, setSavedManagerId] = useState<number | null>(null);
  const [managerCreated, setManagerCreated] = useState(false);
  const [adminAnalyticsTab, setAdminAnalyticsTab] = useState<AdminWholesaleAnalyticsTab>('overview');
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogCategoryId, setCatalogCategoryId] = useState('all');
  const [catalogPriceGroup, setCatalogPriceGroup] = useState('all');
  const [catalogVisibleLimit, setCatalogVisibleLimit] = useState(CATALOG_PAGE_SIZE);
  const deferredCatalogQuery = useDeferredValue(catalogQuery);

  const editMatch = pathname.match(/\/admin\/wholesale\/(\d+)\/edit$/);
  const editId = editMatch ? Number(editMatch[1]) : null;
  const managerAnalyticsMatch = pathname.match(/\/admin\/wholesale\/admin\/managers\/(\d+)\/analytics$/);
  const managerAnalyticsId = managerAnalyticsMatch ? Number(managerAnalyticsMatch[1]) : null;
  const managerDetailMatch = pathname.match(/\/admin\/wholesale\/admin\/managers\/(\d+)$/);
  const managerDetailId = managerDetailMatch ? Number(managerDetailMatch[1]) : null;
  const screen = pathname.endsWith('/admin')
    ? 'admin'
    : managerAnalyticsId
      ? 'managerAnalytics'
      : managerDetailId
        ? 'managerDetail'
        : pathname.endsWith('/manager')
          ? 'manager'
          : pathname.endsWith('/create')
            ? 'create'
            : editId
              ? 'edit'
              : 'home';
  const analyticsManagerIdParam = Number(searchParams.get('analyticsManagerId'));
  const analyticsBackHref =
    canManageWholesale && screen === 'edit' && Number.isInteger(analyticsManagerIdParam) && analyticsManagerIdParam > 0
      ? `/admin/wholesale/admin/managers/${analyticsManagerIdParam}/analytics`
      : null;
  const editorBackHref = analyticsBackHref ?? '/admin/wholesale/manager';

  const catalogRows = useMemo(() => flatCatalogItems(catalog), [catalog]);
  const catalogDiscountBaseByKey = useMemo(
    () =>
      new Map(
        catalogRows.map((row) => [
          row.key,
          {
            amount: getDiscountBaseAmount(row),
            groupKey: (row.product.priceGroup || NO_PRICE_GROUP_TITLE).toLowerCase(),
          },
        ]),
      ),
    [catalogRows],
  );
  const catalogPriceGroups = useMemo(() => {
    const groups = new Set<string>();
    for (const { product } of catalogRows) {
      if (product.priceGroup) groups.add(product.priceGroup);
    }
    return Array.from(groups).sort((first, second) => first.localeCompare(second, 'ru'));
  }, [catalogRows]);
  const itemByKey = useMemo(
    () => new Map(editor.items.map((item) => [`${item.productId}:${item.variantId ?? 'base'}`, item])),
    [editor.items],
  );
  const filteredCatalogRows = useMemo(() => {
    const query = deferredCatalogQuery.trim().toLowerCase();
    return catalogRows.filter(({ category, product, variant }) => {
      if (catalogCategoryId !== 'all' && String(category.id) !== catalogCategoryId) return false;
      if (catalogPriceGroup !== 'all' && product.priceGroup !== catalogPriceGroup) return false;
      if (!query) return true;
      return [
        category.title,
        product.title,
        product.sku,
        product.description,
        product.priceGroup,
        product.priceEur,
        product.priceRub,
        product.priceCny,
        variant.title,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
  }, [catalogCategoryId, catalogPriceGroup, catalogRows, deferredCatalogQuery]);
  const sortedCatalogRows = useMemo(
    () =>
      [...filteredCatalogRows].sort((first, second) => {
        const firstGroup = first.product.priceGroup;
        const secondGroup = second.product.priceGroup;
        if (!firstGroup && secondGroup) return 1;
        if (firstGroup && !secondGroup) return -1;
        return (
          firstGroup.localeCompare(secondGroup, 'ru') ||
          first.category.title.localeCompare(second.category.title, 'ru') ||
          first.product.title.localeCompare(second.product.title, 'ru') ||
          first.variant.title.localeCompare(second.variant.title, 'ru')
        );
      }),
    [filteredCatalogRows],
  );
  const visibleCatalogRows = useMemo(
    () => sortedCatalogRows.slice(0, catalogVisibleLimit),
    [catalogVisibleLimit, sortedCatalogRows],
  );
  const visibleCatalogGroups = useMemo(() => groupCatalogRowsByPriceGroup(visibleCatalogRows), [visibleCatalogRows]);
  const commentRows = useMemo(() => getTextareaRows(editor.comment), [editor.comment]);

  useEffect(() => {
    setCatalogVisibleLimit(CATALOG_PAGE_SIZE);
  }, [catalogCategoryId, catalogPriceGroup, deferredCatalogQuery]);

  const showStatus = (message: string) => {
    setStatus(message);
    window.setTimeout(() => {
      setStatus((current) => (current === message ? '' : current));
    }, 2000);
  };

  const loadManagers = async () => {
    const res = await fetch('/api/admin/wholesale/managers', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    setManagers(Array.isArray(data.managers) ? data.managers : []);
  };

  const loadPriceLists = async () => {
    const res = await fetch('/api/admin/wholesale/price-lists', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    setPriceLists(Array.isArray(data.priceLists) ? data.priceLists : []);
  };

  const loadCurrentManager = async () => {
    const res = await fetch('/api/admin/session', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    setCurrentManager(data.manager ?? null);
  };

  const loadManagerPriceLists = async (managerId: number) => {
    const res = await fetch(`/api/admin/wholesale/managers/${managerId}/price-lists`, { cache: 'no-store' });
    if (!res.ok) {
      showStatus('Менеджер не найден');
      return;
    }
    const data = await res.json();
    setCurrentManager(data.manager ?? null);
    setPriceLists(Array.isArray(data.priceLists) ? data.priceLists : []);
  };

  const loadCatalog = async () => {
    const res = await fetch('/api/admin/wholesale/catalog', { cache: 'no-store' });
    if (!res.ok) return [];
    const data = await res.json();
    const nextCatalog = Array.isArray(data.categories) ? data.categories : [];
    setCatalog(nextCatalog);
    return nextCatalog as CatalogCategory[];
  };

  useEffect(() => {
    if (canManageWholesale && (screen === 'admin' || screen === 'create' || screen === 'edit')) void loadManagers();
    if (screen === 'manager') {
      void loadCurrentManager();
      void loadPriceLists();
    }
    if (canManageWholesale && screen === 'managerDetail' && managerDetailId) {
      void loadManagerPriceLists(managerDetailId);
    }
  }, [canManageWholesale, managerDetailId, screen]);

  useEffect(() => {
    if (!canManageWholesale && (screen === 'admin' || screen === 'managerDetail' || screen === 'managerAnalytics')) {
      router.replace('/admin/wholesale/manager', { scroll: false });
    }
  }, [canManageWholesale, router, screen]);

  useEffect(() => {
    if (screen !== 'create' && screen !== 'edit') return;

    async function loadEditorData() {
      const nextCatalog = await loadCatalog();
      if (screen === 'create') {
        setEditor({ ...emptyEditor(), items: mergeEditorItems(nextCatalog, []) });
        return;
      }

      if (!editId) return;
      const res = await fetch(`/api/admin/wholesale/price-lists/${editId}`, { cache: 'no-store' });
      if (!res.ok) {
        showStatus('Прайс не найден');
        return;
      }
      const data = await res.json();
      const priceList = data.priceList;
      setEditor({
        id: priceList.id,
        title: priceList.title ?? '',
        clientName: priceList.clientName ?? '',
        token: priceList.token ?? makeToken(),
        validUntil: priceList.validUntil ?? '',
        comment: priceList.comment ?? '',
        workflowStatus: priceList.workflowStatus ?? 'not_sent',
        showRetailPrices: Boolean(priceList.showRetailPrices),
        isActive: Boolean(priceList.isActive),
        managerId: priceList.managerId ?? null,
        items: mergeEditorItems(nextCatalog, Array.isArray(priceList.items) ? priceList.items : []),
      });
    }

    void loadEditorData();
  }, [editId, screen]);

  const createManager = async () => {
    if (!managerDraft.name.trim() || !managerDraft.login.trim() || !managerDraft.password.trim()) {
      showStatus('Заполните имя, логин и пароль менеджера');
      return;
    }

    setBusy(true);
    const res = await fetch('/api/admin/wholesale/managers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(managerDraft),
    });
    setBusy(false);
    showStatus(res.ok ? 'Менеджер добавлен' : 'Не удалось добавить менеджера');
    if (res.ok) {
      setManagerCreated(true);
      setManagerDraft(emptyManager);
      await loadManagers();
      window.setTimeout(() => setManagerCreated(false), 2200);
    }
  };

  const saveManager = async (manager: Manager) => {
    setBusy(true);
    const res = await fetch(`/api/admin/wholesale/managers/${manager.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(manager),
    });
    setBusy(false);
    showStatus(res.ok ? 'Менеджер сохранён' : 'Не удалось сохранить менеджера');
    if (res.ok) {
      setSavedManagerId(manager.id);
      await loadManagers();
      window.setTimeout(() => {
        setSavedManagerId((current) => (current === manager.id ? null : current));
      }, 2200);
    }
  };

  const deleteManager = async (id: number) => {
    if (!confirm('Удалить менеджера? Его прайсы останутся без менеджера.')) return;
    setBusy(true);
    const res = await fetch(`/api/admin/wholesale/managers/${id}`, { method: 'DELETE' });
    setBusy(false);
    showStatus(res.ok ? 'Менеджер удалён' : 'Не удалось удалить менеджера');
    if (res.ok) await loadManagers();
  };

  const updateItem = (key: string, patch: Partial<PriceItem>) => {
    setEditor((current) => ({
      ...current,
      items: current.items.map((item) =>
        `${item.productId}:${item.variantId ?? 'base'}` === key ? { ...item, ...patch } : item,
      ),
    }));
  };

  const setProductVisible = (productId: number, visible: boolean) => {
    setEditor((current) => ({
      ...current,
      items: current.items.map((item) => (item.productId === productId ? { ...item, visible } : item)),
    }));
  };

  const setPriceGroupVisible = (groupKey: string, visible: boolean) => {
    setEditor((current) => ({
      ...current,
      items: current.items.map((item) => {
        const key = `${item.productId}:${item.variantId ?? 'base'}`;
        const base = catalogDiscountBaseByKey.get(key);
        return base?.groupKey === groupKey ? { ...item, visible } : item;
      }),
    }));
  };

  const calculateDiscount = (value = discount, groupKey?: string) => {
    if (!value.trim()) {
      showStatus('Введите процент скидки');
      return;
    }
    const percent = Number(value.replace(',', '.'));
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      showStatus('Введите процент скидки');
      return;
    }
    const changedCount = editor.items.filter((item) => {
      const key = `${item.productId}:${item.variantId ?? 'base'}`;
      const base = catalogDiscountBaseByKey.get(key);
      return Boolean(base && base.amount !== null && (!groupKey || base.groupKey === groupKey));
    }).length;
    setEditor((current) => ({
      ...current,
      items: current.items.map((item) => {
        const key = `${item.productId}:${item.variantId ?? 'base'}`;
        const base = catalogDiscountBaseByKey.get(key);
        if (!base || base.amount === null || (groupKey && base.groupKey !== groupKey)) return item;
        return {
          ...item,
          customWholesalePrice: formatCatalogAmount(base.amount * (1 - percent / 100)),
        };
      }),
    }));
    showStatus(changedCount > 0 ? 'Цены рассчитаны' : 'В выбранной группе нет цен для расчёта');
  };

  const savePriceList = async () => {
    if (!editor.title.trim()) {
      showStatus('Введите название прайса');
      return;
    }

    const method = screen === 'edit' ? 'PUT' : 'POST';
    const url = screen === 'edit' && editor.id ? `/api/admin/wholesale/price-lists/${editor.id}` : '/api/admin/wholesale/price-lists';
    setBusy(true);
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editor),
    });
    setBusy(false);
    showStatus(res.ok ? 'Прайс сохранён' : 'Не удалось сохранить прайс');
    if (res.ok) router.push(editorBackHref);
  };

  const deletePriceList = async (id: number) => {
    if (!confirm('Удалить прайс?')) return;
    setBusy(true);
    const res = await fetch(`/api/admin/wholesale/price-lists/${id}`, { method: 'DELETE' });
    setBusy(false);
    showStatus(res.ok ? 'Прайс удалён' : 'Не удалось удалить прайс');
    if (res.ok) {
      if (screen === 'managerDetail' && managerDetailId) {
        await loadManagerPriceLists(managerDetailId);
        return;
      }
      await loadPriceLists();
    }
  };

  const copyLink = async (item: PriceList) => {
    const url = `${window.location.origin}/price/${item.token}`;
    await navigator.clipboard.writeText(url);
    void fetch(`/api/admin/wholesale/price-lists/${item.id}/copy-link`, { method: 'POST' });
    setCopiedToken(item.token);
    showStatus('Ссылка скопирована');
    window.setTimeout(() => {
      setCopiedToken((current) => (current === item.token ? null : current));
    }, 2200);
  };

  const renderPriceListCards = (emptyText: string) => (
    <div className={styles.priceListCards}>
      {priceLists.map((item) => (
        <article className={styles.priceListCard} key={item.id}>
          <div className={styles.priceListMain}>
            <div className={styles.priceListTitle}>
              <strong>{item.title}</strong>
              <span>Позиций: {item.itemCount}</span>
            </div>
            <div className={styles.priceListField}>
              <span>Клиент</span>
              <strong>{item.clientName || '—'}</strong>
            </div>
            <div className={styles.priceListField}>
              <span>Менеджер</span>
              <strong>{item.managerName || '—'}</strong>
            </div>
            <div className={styles.priceListField}>
              <span>Ссылка</span>
              <code>{shortToken(item.token)}</code>
            </div>
          </div>
          <div className={styles.priceListMeta}>
            <div className={styles.priceListField}>
              <span>Дата создания</span>
              <strong>{formatDate(item.createdAt)}</strong>
            </div>
            <div className={styles.priceListField}>
              <span>Последнее изменение</span>
              <strong>{renderLastPriceChange(item)}</strong>
            </div>
            <div className={styles.priceListField}>
              <span>Действует до</span>
              <strong>{item.validUntil || '—'}</strong>
            </div>
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
            <div className={styles.priceListActions}>
              <button onClick={() => router.push(`/admin/wholesale/${item.id}/edit`)}>Изменить</button>
              <button className={styles.secondary} onClick={() => window.open(`/price/${item.token}`, '_blank')}>Открыть</button>
              <button
                className={`${styles.secondary} ${copiedToken === item.token ? styles.savedButton : ''}`}
                type="button"
                onClick={() => copyLink(item)}
              >
                {copiedToken === item.token ? 'Скопировано' : 'Скопировать'}
              </button>
              <button className={styles.danger} onClick={() => deletePriceList(item.id)}>Удалить</button>
            </div>
          </div>
        </article>
      ))}
      {priceLists.length === 0 ? <p className={styles.mutedText}>{emptyText}</p> : null}
    </div>
  );

  if (screen === 'managerAnalytics' && managerAnalyticsId) {
    return <AdminManagerAnalytics managerId={managerAnalyticsId} />;
  }

  if (screen === 'admin') {
    return (
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div>
            <p>Индивидуальные прайсы</p>
            <h2>Администратор</h2>
          </div>
          <button className={styles.secondary} onClick={onBack}>
            Вернуться в панель управления
          </button>
        </div>

        {status ? <p className={styles.status}>{status}</p> : null}

        <AdminWholesaleAnalytics onTabChange={setAdminAnalyticsTab} />

        {adminAnalyticsTab === 'managers' ? (
          <div className={styles.wholesaleManagersAdminBlock}>

        <h3>Добавить менеджера</h3>
        <div className={styles.wholesaleRow}>
          <input value={managerDraft.name} onChange={(event) => setManagerDraft({ ...managerDraft, name: event.target.value })} placeholder="Имя менеджера" autoComplete="off" />
          <input value={managerDraft.login} onChange={(event) => setManagerDraft({ ...managerDraft, login: event.target.value })} placeholder="Логин" autoComplete="new-password" />
          <input value={managerDraft.email} onChange={(event) => setManagerDraft({ ...managerDraft, email: event.target.value })} placeholder="Email" autoComplete="new-password" />
          <input value={managerDraft.phone} onChange={(event) => setManagerDraft({ ...managerDraft, phone: event.target.value })} placeholder="Телефон" autoComplete="tel" />
          <input type="password" value={managerDraft.password} onChange={(event) => setManagerDraft({ ...managerDraft, password: event.target.value })} placeholder="Пароль" autoComplete="new-password" />
          <label className={styles.checkbox}>
            <input type="checkbox" checked={managerDraft.isActive} onChange={(event) => setManagerDraft({ ...managerDraft, isActive: event.target.checked })} />
            Активен
          </label>
          <button className={managerCreated ? styles.savedButton : undefined} disabled={busy} onClick={createManager}>
            {managerCreated ? 'Менеджер добавлен' : 'Добавить менеджера'}
          </button>
        </div>

        <h3>Менеджеры и статистика</h3>
        <div className={styles.managerCards}>
          {managers.map((manager) => (
            <article className={styles.managerCard} key={manager.id}>
              <div className={styles.managerFields}>
                <label>
                  <span>Имя</span>
                  <input value={manager.name} onChange={(event) => setManagers((current) => current.map((item) => item.id === manager.id ? { ...item, name: event.target.value } : item))} />
                </label>
                <label>
                  <span>Логин</span>
                  <input value={manager.login} onChange={(event) => setManagers((current) => current.map((item) => item.id === manager.id ? { ...item, login: event.target.value } : item))} />
                </label>
                <label>
                  <span>Email</span>
                  <input value={manager.email} onChange={(event) => setManagers((current) => current.map((item) => item.id === manager.id ? { ...item, email: event.target.value } : item))} />
                </label>
                <label>
                  <span>Телефон</span>
                  <input value={manager.phone} onChange={(event) => setManagers((current) => current.map((item) => item.id === manager.id ? { ...item, phone: event.target.value } : item))} />
                </label>
                <label>
                  <span>Новый пароль</span>
                  <input type="password" value={manager.password ?? ''} onChange={(event) => setManagers((current) => current.map((item) => item.id === manager.id ? { ...item, password: event.target.value } : item))} placeholder="Не менять" />
                </label>
              </div>
              <div className={styles.managerControls}>
                <button
                  className={styles.managerMetric}
                  type="button"
                  onClick={() => router.push(`/admin/wholesale/admin/managers/${manager.id}`)}
                >
                  <span>Прайсов</span>
                  <strong>{manager.priceListCount}</strong>
                </button>
                <label className={styles.managerActive}>
                  <input type="checkbox" checked={manager.isActive} onChange={(event) => setManagers((current) => current.map((item) => item.id === manager.id ? { ...item, isActive: event.target.checked } : item))} />
                  <span>Активен</span>
                </label>
                <div className={styles.managerActions}>
                  <button
                    className={styles.secondary}
                    type="button"
                    onClick={() => router.push(`/admin/wholesale/admin/managers/${manager.id}/analytics`)}
                  >
                    Аналитика
                  </button>
                  <button
                    className={styles.secondary}
                    type="button"
                    onClick={() => router.push(`/admin/wholesale/admin/managers/${manager.id}`)}
                  >
                    Прайсы
                  </button>
                  <button
                    className={savedManagerId === manager.id ? styles.savedButton : undefined}
                    disabled={busy}
                    onClick={() => saveManager(manager)}
                  >
                    {savedManagerId === manager.id ? 'Сохранено' : 'Сохранить'}
                  </button>
                  <button className={styles.danger} disabled={busy} onClick={() => deleteManager(manager.id)}>Удалить</button>
                </div>
              </div>
            </article>
          ))}
          {managers.length === 0 ? <p className={styles.mutedText}>Менеджеров пока нет</p> : null}
        </div>
          </div>
        ) : null}
      </section>
    );
  }

  if (screen === 'manager') {
    return (
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div>
            <p>Индивидуальные прайсы</p>
            <h2>
              Менеджер
              {currentManager?.name ? <span className={styles.headingMeta}>{currentManager.name}</span> : null}
            </h2>
          </div>
          <div className={styles.topbarActions}>
            <button className={styles.secondary} onClick={onBack}>
              Вернуться в панель управления
            </button>
            <button onClick={() => router.push('/admin/wholesale/create')}>Создать прайс</button>
          </div>
        </div>

        {status ? <p className={styles.status}>{status}</p> : null}

        {renderPriceListCards('У менеджера пока нет прайсов.')}
      </section>
    );
  }

  if (screen === 'managerDetail') {
    return (
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div>
            <p>Индивидуальные прайсы</p>
            <h2>
              Прайсы менеджера
              {currentManager?.name ? <span className={styles.headingMeta}>{currentManager.name}</span> : null}
            </h2>
          </div>
          <button className={styles.secondary} onClick={() => router.push('/admin/wholesale/admin')}>
            Вернуться к менеджерам
          </button>
        </div>

        {status ? <p className={styles.status}>{status}</p> : null}

        {renderPriceListCards('У менеджера пока нет прайсов.')}
      </section>
    );
  }

  if (screen === 'create' || screen === 'edit') {
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
            <button className={styles.secondary} type="button" onClick={() => router.push('/admin/wholesale/manager')}>
              Вернуться в панель управления
            </button>
          </div>
        </div>

        {status ? <p className={styles.status}>{status}</p> : null}

        <div className={styles.wholesaleEditorGrid}>
          <label>
            <span>Название прайса</span>
            <input value={editor.title} onChange={(event) => setEditor({ ...editor, title: event.target.value })} />
          </label>
          <label>
            <span>Клиент / компания</span>
            <input value={editor.clientName} onChange={(event) => setEditor({ ...editor, clientName: event.target.value })} />
          </label>
          <label>
            <span>Token ссылки</span>
            <input value={editor.token} onChange={(event) => setEditor({ ...editor, token: event.target.value })} />
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
                {managers.map((manager) => (
                  <option key={manager.id} value={manager.id}>{manager.name}</option>
                ))}
              </select>
            </label>
          )}
          <label className={styles.wholesaleWide}>
            <span>Комментарий</span>
            <textarea rows={commentRows} value={editor.comment} onChange={(event) => setEditor({ ...editor, comment: event.target.value })} />
          </label>
          <label className={styles.checkbox}>
            <input type="checkbox" checked={editor.isActive} onChange={(event) => setEditor({ ...editor, isActive: event.target.checked })} />
            Активен
          </label>
          <label className={styles.checkbox}>
            <input type="checkbox" checked={editor.showRetailPrices} onChange={(event) => setEditor({ ...editor, showRetailPrices: event.target.checked })} />
            Показать розничные цены
          </label>
        </div>

        <div className={styles.discountBox}>
          <span>Применить скидку ко всем позициям, %</span>
          <input value={discount} onChange={(event) => setDiscount(event.target.value)} placeholder="Например 20" />
          <button className={styles.secondary} onClick={() => calculateDiscount()}>Рассчитать цены</button>
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
                Показано {visibleCatalogRows.length} из {filteredCatalogRows.length}. Всего позиций: {catalogRows.length}.
              </p>
            </div>

            {filteredCatalogRows.length === 0 ? (
              <p className={styles.mutedText}>По выбранному фильтру товары не найдены.</p>
            ) : (
              visibleCatalogGroups.map((group) => (
                <div className={styles.priceCategory} key={group.id}>
                  <div className={styles.priceCategoryHeader}>
                    <h3>{group.title}</h3>
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
                          placeholder="Например 20"
                        />
                        <button className={styles.secondary} onClick={() => calculateDiscount(groupDiscounts[group.id] ?? '', group.id)}>
                          Рассчитать
                        </button>
                      </div>
                      <div className={styles.priceGroupVisibility}>
                        <button className={styles.secondary} onClick={() => setPriceGroupVisible(group.id, true)}>Показать все</button>
                        <button className={styles.secondary} onClick={() => setPriceGroupVisible(group.id, false)}>Убрать все</button>
                      </div>
                    </div>
                  </div>
                  {group.products.map((product) => {
                    const hasSeveralPositions = product.variants.length > 1;

                    return (
                      <article className={styles.priceProduct} key={product.id}>
                        <div className={styles.priceProductInfo}>
                          {product.imageUrl ? <img src={product.imageUrl} alt="" /> : <span>Нет фото</span>}
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
                                <input value={item?.customWholesalePrice ?? ''} onChange={(event) => updateItem(key, { customWholesalePrice: event.target.value })} />
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
              ))
            )}

            {visibleCatalogRows.length < filteredCatalogRows.length ? (
              <button
                className={`${styles.secondary} ${styles.wholesaleLoadMore}`}
                onClick={() => setCatalogVisibleLimit((current) => current + CATALOG_PAGE_SIZE)}
              >
                Показать ещё {Math.min(CATALOG_PAGE_SIZE, filteredCatalogRows.length - visibleCatalogRows.length)}
              </button>
            ) : null}
          </>
        )}

        <div className={styles.actions}>
          <button disabled={busy} onClick={savePriceList}>Сохранить прайс</button>
          <button className={styles.secondary} onClick={() => router.push(editorBackHref)}>Отмена</button>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <p>Индивидуальные прайсы</p>
          <h2>Выберите режим работы</h2>
        </div>
        <button className={styles.secondary} onClick={onBack}>
          Вернуться в панель управления
        </button>
      </div>

      <div className={styles.dashboardGrid}>
        {canManageWholesale && (
          <article className={styles.dashboardCard}>
            <div>
              <h2>Администратор</h2>
              <p>Добавление, изменение и удаление менеджеров, статистика по созданным прайсам и журналу изменений.</p>
            </div>
            <button onClick={() => router.push('/admin/wholesale/admin')}>Открыть</button>
          </article>
        )}

        <article className={styles.dashboardCard}>
          <div>
            <h2>Менеджер</h2>
            <p>Создание индивидуальных прайсов, настройка цен, видимости размеров и публичных ссылок.</p>
          </div>
          <button onClick={() => router.push('/admin/wholesale/manager')}>Открыть</button>
        </article>
      </div>
    </section>
  );
}
