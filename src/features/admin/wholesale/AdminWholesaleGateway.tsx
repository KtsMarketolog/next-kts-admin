'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import styles from '@/app/admin/admin.module.scss';
import { AdminManagerAnalytics } from './AdminManagerAnalytics';
import { AdminWholesaleAnalytics } from './AdminWholesaleAnalytics';

type Manager = {
  id: number;
  name: string;
  login: string;
  email: string;
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
};

const emptyManager = {
  name: '',
  login: '',
  email: '',
  password: '',
  isActive: true,
};

function makeToken() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function emptyEditor(): PriceEditor {
  return {
    title: '',
    clientName: '',
    token: makeToken(),
    validUntil: '',
    comment: '',
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

function mergeEditorItems(categories: CatalogCategory[], items: PriceItem[]) {
  const current = new Map(items.map((item) => [`${item.productId}:${item.variantId ?? 'base'}`, item]));
  return flatCatalogItems(categories).map(({ product, variant }, index) => {
    const key = `${product.id}:${variant.id ?? 'base'}`;
    return (
      current.get(key) ?? {
        productId: product.id,
        variantId: variant.id,
        customWholesalePrice: variant.wholesalePrice,
        visible: true,
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
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [savedManagerId, setSavedManagerId] = useState<number | null>(null);
  const [managerCreated, setManagerCreated] = useState(false);

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
        setEditor((current) => ({ ...current, items: mergeEditorItems(nextCatalog, current.items) }));
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

  const calculateDiscount = () => {
    const percent = Number(discount.replace(',', '.'));
    if (!Number.isFinite(percent)) {
      showStatus('Введите процент скидки');
      return;
    }
    const retailByKey = new Map(catalogRows.map(({ key, variant }) => [key, Number(variant.retailPrice ?? 0)]));
    setEditor((current) => ({
      ...current,
      items: current.items.map((item) => {
        const key = `${item.productId}:${item.variantId ?? 'base'}`;
        const retail = retailByKey.get(key) ?? 0;
        return {
          ...item,
          customWholesalePrice: retail > 0 ? String(Math.round(retail * (1 - percent / 100))) : item.customWholesalePrice,
        };
      }),
    }));
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

        <AdminWholesaleAnalytics />

        <h3>Добавить менеджера</h3>
        <div className={styles.wholesaleRow}>
          <input value={managerDraft.name} onChange={(event) => setManagerDraft({ ...managerDraft, name: event.target.value })} placeholder="Имя менеджера" autoComplete="off" />
          <input value={managerDraft.login} onChange={(event) => setManagerDraft({ ...managerDraft, login: event.target.value })} placeholder="Логин" autoComplete="new-password" />
          <input value={managerDraft.email} onChange={(event) => setManagerDraft({ ...managerDraft, email: event.target.value })} placeholder="Email" autoComplete="new-password" />
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
        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead>
              <tr>
                <th>Имя</th>
                <th>Логин</th>
                <th>Email</th>
                <th>Новый пароль</th>
                <th>Прайсов</th>
                <th>Активен</th>
                <th>Аналитика</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {managers.map((manager) => (
                <tr key={manager.id}>
                  <td><input value={manager.name} onChange={(event) => setManagers((current) => current.map((item) => item.id === manager.id ? { ...item, name: event.target.value } : item))} /></td>
                  <td><input value={manager.login} onChange={(event) => setManagers((current) => current.map((item) => item.id === manager.id ? { ...item, login: event.target.value } : item))} /></td>
                  <td><input value={manager.email} onChange={(event) => setManagers((current) => current.map((item) => item.id === manager.id ? { ...item, email: event.target.value } : item))} /></td>
                  <td><input type="password" value={manager.password ?? ''} onChange={(event) => setManagers((current) => current.map((item) => item.id === manager.id ? { ...item, password: event.target.value } : item))} placeholder="Не менять" /></td>
                  <td className={styles.countCell}>
                    <button
                      className={styles.textButton}
                      type="button"
                      onClick={() => router.push(`/admin/wholesale/admin/managers/${manager.id}`)}
                    >
                      {manager.priceListCount}
                    </button>
                  </td>
                  <td><input type="checkbox" checked={manager.isActive} onChange={(event) => setManagers((current) => current.map((item) => item.id === manager.id ? { ...item, isActive: event.target.checked } : item))} /></td>
                  <td>
                    <button
                      className={styles.secondary}
                      type="button"
                      onClick={() => router.push(`/admin/wholesale/admin/managers/${manager.id}/analytics`)}
                    >
                      Аналитика
                    </button>
                  </td>
                  <td className={styles.tableActions}>
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead>
              <tr>
                <th>Название</th>
                <th>Клиент</th>
                <th>Менеджер</th>
                <th>Ссылка</th>
                <th>Дата создания</th>
                <th>Последнее изменение</th>
                <th>Действует до</th>
                <th>Статус</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {priceLists.map((item) => (
                <tr key={item.id}>
                  <td><strong>{item.title}</strong><br /><span>Позиций: {item.itemCount}</span></td>
                  <td>{item.clientName || '—'}</td>
                  <td>{item.managerName || '—'}</td>
                  <td>{item.token}</td>
                  <td>{formatDate(item.createdAt)}</td>
                  <td>{renderLastPriceChange(item)}</td>
                  <td>{item.validUntil || '—'}</td>
                  <td>{item.isActive ? 'Активен' : 'Скрыт'}</td>
                  <td className={styles.tableActions}>
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

        <div className={styles.tableWrap}>
          <table className={styles.adminTable}>
            <thead>
              <tr>
                <th>Название</th>
                <th>Клиент</th>
                <th>Менеджер</th>
                <th>Ссылка</th>
                <th>Дата создания</th>
                <th>Последнее изменение</th>
                <th>Действует до</th>
                <th>Статус</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {priceLists.map((item) => (
                <tr key={item.id}>
                  <td><strong>{item.title}</strong><br /><span>Позиций: {item.itemCount}</span></td>
                  <td>{item.clientName || '—'}</td>
                  <td>{item.managerName || '—'}</td>
                  <td>{item.token}</td>
                  <td>{formatDate(item.createdAt)}</td>
                  <td>{renderLastPriceChange(item)}</td>
                  <td>{item.validUntil || '—'}</td>
                  <td>{item.isActive ? 'Активен' : 'Скрыт'}</td>
                  <td className={styles.tableActions}>
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
                  </td>
                </tr>
              ))}
              {priceLists.length === 0 ? (
                <tr>
                  <td colSpan={9}>У менеджера пока нет прайсов.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
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
            <textarea value={editor.comment} onChange={(event) => setEditor({ ...editor, comment: event.target.value })} />
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
          <button className={styles.secondary} onClick={calculateDiscount}>Рассчитать цены</button>
        </div>

        {catalog.length === 0 ? (
          <p className={styles.mutedText}>В базе прайс-товаров пока нет позиций. Сначала нужно добавить отдельные wholesale-товары.</p>
        ) : (
          catalog.map((category) => (
            <div className={styles.priceCategory} key={category.id}>
              <h3>{category.title}</h3>
              {category.products.map((product) => (
                <article className={styles.priceProduct} key={product.id}>
                  <div className={styles.priceProductInfo}>
                    {product.imageUrl ? <img src={product.imageUrl} alt="" /> : <span>Нет фото</span>}
                    <div>
                      <strong>{product.title}</strong>
                      {product.sku ? <p>{product.sku}</p> : null}
                      {product.description ? <p>{product.description}</p> : null}
                      <div className={styles.actions}>
                        <button className={styles.secondary} onClick={() => setProductVisible(product.id, true)}>Показать все размеры</button>
                        <button className={styles.secondary} onClick={() => setProductVisible(product.id, false)}>Убрать все размеры</button>
                      </div>
                    </div>
                  </div>
                  <div className={styles.variantTable}>
                    <div>Размер</div>
                    <div>Розница</div>
                    <div>Опт</div>
                    <div>Показывать</div>
                    {product.variants.map((variant) => {
                      const key = `${product.id}:${variant.id ?? 'base'}`;
                      const item = editor.items.find((candidate) => `${candidate.productId}:${candidate.variantId ?? 'base'}` === key);
                      return (
                        <div className={styles.variantRow} key={key}>
                          <span>{variant.title}</span>
                          <span>{variant.retailPrice || '—'}</span>
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
              ))}
            </div>
          ))
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
