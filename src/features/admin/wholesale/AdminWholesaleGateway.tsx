'use client';

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import styles from '@/app/admin/admin.module.scss';
import {
  removeWholesaleManagerPassword as removeManagerPassword,
  saveWholesaleManagerPassword as saveManagerPassword,
} from '@/shared/lib/adminPasswordStorage';
import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';
import { AdminManagerAnalytics } from './AdminManagerAnalytics';
import { AdminWholesaleAnalytics } from './AdminWholesaleAnalytics';
import { WholesaleManagerManagement } from './WholesaleManagerManagement';
import { WholesalePriceListCards } from './WholesalePriceListCards';
import { WholesalePriceEditorScreen } from './WholesalePriceEditorScreen';
import { useAdminWholesaleGatewayPath } from './useAdminWholesaleGatewayPath';

import {
  NO_PRICE_GROUP_TITLE,
  attachManagerPasswords,
  emptyEditor,
  emptyManager,
  flatCatalogItems,
  formatCatalogAmount,
  formatDiscountPercent,
  getDiscountBaseAmount,
  getProductDiscountLimit,
  getTextareaRows,
  groupCatalogRowsByPriceGroup,
  makeToken,
  mergeEditorItems,
  normalizeDiscountPercent,
  normalizePriceGroupStockSettings,
  readApiError,
  readManagerRoleTab,
  type AdminWholesaleGatewayProps,
  type CatalogCategory,
  type CurrentManager,
  type Manager,
  type ManagerRole,
  type PriceEditor,
  type PriceItem,
  type PriceList,
} from './AdminWholesaleModel';
export function AdminWholesaleGateway({ canManageWholesale = true, onBack }: AdminWholesaleGatewayProps) {
  const router = useRouter();
  const {
    analyticsBackHref,
    createManagerId,
    editId,
    editorBackHref,
    managerAnalyticsId,
    managerDetailId,
    screen,
    startsInEditor,
  } = useAdminWholesaleGatewayPath(canManageWholesale);
  const [managers, setManagers] = useState<Manager[]>([]);
  const [currentManager, setCurrentManager] = useState<CurrentManager | null>(null);
  const [managerDraft, setManagerDraft] = useState(emptyManager);
  const [priceLists, setPriceLists] = useState<PriceList[]>([]);
  const [catalog, setCatalog] = useState<CatalogCategory[]>([]);
  const [editor, setEditor] = useState<PriceEditor>(() => emptyEditor());
  const [editorLoading, setEditorLoading] = useState(startsInEditor);
  const [groupDiscounts, setGroupDiscounts] = useState<Record<string, string>>({});
  const [appliedGroupDiscounts, setAppliedGroupDiscounts] = useState<Record<string, string>>({});
  const [expandedPriceGroups, setExpandedPriceGroups] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [savedManagerId, setSavedManagerId] = useState<number | null>(null);
  const [managerCreated, setManagerCreated] = useState(false);
  const [managerRoleTab, setManagerRoleTab] = useState<ManagerRole>(() => readManagerRoleTab());
  const [managerPasswordDrafts, setManagerPasswordDrafts] = useState<Record<number, string>>({});
  const [managerPasswordEditIds, setManagerPasswordEditIds] = useState<Record<number, boolean>>({});
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogCategoryId, setCatalogCategoryId] = useState('all');
  const [catalogPriceGroup, setCatalogPriceGroup] = useState('all');
  const deferredCatalogQuery = useDeferredValue(catalogQuery);

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
  const catalogDiscountLimitByGroupKey = useMemo(() => {
    const limits = new Map<string, number>();
    for (const { product } of catalogRows) {
      const groupKey = (product.priceGroup || NO_PRICE_GROUP_TITLE).toLowerCase();
      const productLimit = getProductDiscountLimit(product);
      if (productLimit === null) continue;
      const currentLimit = limits.get(groupKey);
      limits.set(groupKey, currentLimit === undefined ? productLimit : Math.min(currentLimit, productLimit));
    }
    return limits;
  }, [catalogRows]);
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
        product.priceUsd,
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
  const filteredCatalogGroups = useMemo(() => groupCatalogRowsByPriceGroup(sortedCatalogRows), [sortedCatalogRows]);
  const commentRows = useMemo(() => getTextareaRows(editor.comment), [editor.comment]);
  const supportManagers = useMemo(
    () =>
      managers
        .filter((manager) => manager.role === 'support_manager' && manager.isActive)
        .sort((first, second) => Number(second.isActive) - Number(first.isActive) || first.name.localeCompare(second.name, 'ru')),
    [managers],
  );
  const developmentManagers = useMemo(() => managers.filter((manager) => manager.role === 'manager'), [managers]);
  const supportManagerRows = useMemo(() => managers.filter((manager) => manager.role === 'support_manager'), [managers]);
  const managerRoleLabel = managerRoleTab === 'support_manager' ? 'менеджера по сопровождению' : 'менеджера по развитию';
  const managerRoleTitle = managerRoleTab === 'support_manager' ? 'Менеджер по сопровождению' : 'Менеджер по развитию';
  const managerRoleRows = managerRoleTab === 'support_manager' ? supportManagerRows : developmentManagers;

  const showStatus = useCallback((message: string) => {
    setStatus(message);
    window.setTimeout(() => {
      setStatus((current) => (current === message ? '' : current));
    }, 2000);
  }, []);

  const loadManagers = async () => {
    const res = await fetch('/api/admin/wholesale/managers', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    setManagers(attachManagerPasswords(Array.isArray(data.managers) ? data.managers : []));
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

  const loadManagerPriceLists = useCallback(async (managerId: number) => {
    const res = await fetch(`/api/admin/wholesale/managers/${managerId}/price-lists`, { cache: 'no-store' });
    if (!res.ok) {
      showStatus('Менеджер не найден');
      return;
    }
    const data = await res.json();
    setCurrentManager(data.manager ?? null);
    setPriceLists(Array.isArray(data.priceLists) ? data.priceLists : []);
  }, [showStatus]);

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
  }, [canManageWholesale, loadManagerPriceLists, managerDetailId, screen]);

  useEffect(() => {
    if (!canManageWholesale && (screen === 'admin' || screen === 'managerDetail' || screen === 'managerAnalytics')) {
      router.replace('/admin/wholesale/manager', { scroll: false });
    }
  }, [canManageWholesale, router, screen]);

  useEffect(() => {
    if (screen !== 'create' && screen !== 'edit') {
      setEditorLoading(false);
      return;
    }

    let isActive = true;

    async function loadEditorData() {
      setEditorLoading(true);
      const nextCatalog = await loadCatalog();
      if (!isActive) return;
      if (screen === 'create') {
        setEditor({ ...emptyEditor(), managerId: canManageWholesale ? createManagerId : null, items: mergeEditorItems(nextCatalog, []) });
        setEditorLoading(false);
        return;
      }

      if (!editId) {
        setEditorLoading(false);
        return;
      }
      const res = await fetch(`/api/admin/wholesale/price-lists/${editId}`, { cache: 'no-store' });
      if (!isActive) return;
      if (!res.ok) {
        setEditorLoading(false);
        showStatus('Прайс не найден');
        return;
      }
      const data = await res.json();
      if (!isActive) return;
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
        showStock: priceList.showStock !== false,
        showStockText: Boolean(priceList.showStockText),
        isActive: Boolean(priceList.isActive),
        managerId: priceList.managerId ?? null,
        items: mergeEditorItems(nextCatalog, Array.isArray(priceList.items) ? priceList.items : []),
        priceGroupStockSettings: normalizePriceGroupStockSettings(priceList.priceGroupStockSettings),
      });
      setEditorLoading(false);
    }

    void loadEditorData().catch(() => {
      if (!isActive) return;
      showStatus('Не удалось загрузить данные прайса');
      setEditorLoading(false);
    });

    return () => {
      isActive = false;
    };
  }, [canManageWholesale, createManagerId, editId, screen, showStatus]);

  const validateManagerPassword = (password: string) => {
    const passwordPolicy = validatePasswordPolicy(password);
    if (!passwordPolicy.ok) {
      showStatus(passwordPolicy.error || 'Пароль не подходит. Измените пароль и сохраните снова.');
      return false;
    }
    return true;
  };

  const copyManagerPassword = async (password?: string) => {
    if (!password) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(password);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = password;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      showStatus('Пароль скопирован');
    } catch {
      showStatus('Не удалось скопировать пароль');
    }
  };

  const createManager = async () => {
    if (!managerDraft.name.trim() || !managerDraft.login.trim() || !managerDraft.password.trim()) {
      showStatus(`Заполните имя, логин и пароль ${managerRoleLabel}`);
      return;
    }
    if (!validateManagerPassword(managerDraft.password.trim())) return;

    setBusy(true);
    const res = await fetch('/api/admin/wholesale/managers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...managerDraft,
        name: managerDraft.name.trim(),
        login: managerDraft.login.trim(),
        email: managerDraft.email.trim(),
        phone: managerRoleTab === 'manager' ? managerDraft.phone.trim() : '',
        role: managerRoleTab,
        supportManagerId: managerRoleTab === 'manager' ? managerDraft.supportManagerId : null,
        password: managerDraft.password.trim(),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      showStatus(await readApiError(res, 'Не удалось добавить менеджера'));
      return;
    }

    const data = await res.json().catch(() => ({}));
    const createdId = Number(data.id);
    if (Number.isInteger(createdId) && createdId > 0) saveManagerPassword(createdId, managerDraft.password.trim());
    showStatus(`${managerRoleTitle} добавлен`);
    setManagerCreated(true);
    setManagerDraft(emptyManager);
    await loadManagers();
    window.setTimeout(() => setManagerCreated(false), 2200);
  };

  const saveManager = async (manager: Manager) => {
    const passwordIsEdited = Boolean(managerPasswordEditIds[manager.id]);
    const nextPassword = passwordIsEdited ? (managerPasswordDrafts[manager.id] || '').trim() : '';
    if (passwordIsEdited && !nextPassword) {
      showStatus('Введите новый пароль или нажмите «Отменить пароль»');
      return;
    }
    if (nextPassword && !validateManagerPassword(nextPassword)) return;

    setBusy(true);
    const res = await fetch(`/api/admin/wholesale/managers/${manager.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...manager,
        name: manager.name.trim(),
        login: manager.login.trim(),
        email: manager.email.trim(),
        phone: manager.phone.trim(),
        password: nextPassword,
        supportManagerId: manager.role === 'manager' ? manager.supportManagerId : null,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      showStatus(await readApiError(res, 'Не удалось сохранить менеджера'));
      return;
    }

    if (nextPassword) saveManagerPassword(manager.id, nextPassword);
    setManagerPasswordDrafts((current) => {
      const next = { ...current };
      delete next[manager.id];
      return next;
    });
    setManagerPasswordEditIds((current) => {
      const next = { ...current };
      delete next[manager.id];
      return next;
    });
    showStatus('Менеджер сохранён');
    setSavedManagerId(manager.id);
    await loadManagers();
    window.setTimeout(() => {
      setSavedManagerId((current) => (current === manager.id ? null : current));
    }, 2200);
  };

  const deleteManager = async (id: number) => {
    if (!confirm('Удалить менеджера? Его прайсы останутся без менеджера.')) return;
    setBusy(true);
    const res = await fetch(`/api/admin/wholesale/managers/${id}`, { method: 'DELETE' });
    setBusy(false);
    showStatus(res.ok ? 'Менеджер удалён' : 'Не удалось удалить менеджера');
    if (res.ok) {
      removeManagerPassword(id);
      await loadManagers();
    }
  };

  const updateItem = (key: string, patch: Partial<PriceItem>) => {
    if ('customWholesalePrice' in patch) {
      const groupKey = catalogDiscountBaseByKey.get(key)?.groupKey;
      if (groupKey) {
        setAppliedGroupDiscounts((current) => {
          const next = { ...current };
          delete next[groupKey];
          return next;
        });
      }
    }
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

  const togglePriceGroupExpanded = (groupKey: string) => {
    setExpandedPriceGroups((current) => ({
      ...current,
      [groupKey]: !current[groupKey],
    }));
  };

  const calculateDiscount = (value: string, groupKey: string) => {
    const percent = normalizeDiscountPercent(value);
    if (percent === null) {
      showStatus('Введите процент скидки');
      return;
    }
    const maxDiscount = catalogDiscountLimitByGroupKey.get(groupKey);
    if (maxDiscount !== undefined && percent - maxDiscount > 0.000001) {
      showStatus(`Максимальная скидка для группы: ${formatDiscountPercent(maxDiscount)}%`);
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
    if (changedCount > 0) {
      setAppliedGroupDiscounts((current) => ({
        ...current,
        [groupKey]: formatDiscountPercent(percent),
      }));
    }
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
    <WholesalePriceListCards
      priceLists={priceLists}
      copiedToken={copiedToken}
      emptyText={emptyText}
      onEdit={(item) => router.push(`/admin/wholesale/${item.id}/edit`)}
      onOpen={(item) => window.open(`/price/${item.token}`, '_blank')}
      onCopyLink={copyLink}
      onDelete={deletePriceList}
    />
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

        <AdminWholesaleAnalytics
          managerManagementContent={(
            <WholesaleManagerManagement
              managerRoleTab={managerRoleTab}
              managerDraft={managerDraft}
              managerRoleTitle={managerRoleTitle}
              managerRoleLabel={managerRoleLabel}
              supportManagers={supportManagers}
              managerRoleRows={managerRoleRows}
              managerPasswordEditIds={managerPasswordEditIds}
              managerPasswordDrafts={managerPasswordDrafts}
              busy={busy}
              managerCreated={managerCreated}
              savedManagerId={savedManagerId}
              router={router}
              setManagerRoleTab={setManagerRoleTab}
              setManagerCreated={setManagerCreated}
              setManagerDraft={setManagerDraft}
              setManagers={setManagers}
              setManagerPasswordDrafts={setManagerPasswordDrafts}
              setManagerPasswordEditIds={setManagerPasswordEditIds}
              createManager={createManager}
              copyManagerPassword={copyManagerPassword}
              saveManager={saveManager}
              deleteManager={deleteManager}
            />
          )}
        />
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
            <button className={styles.secondary} onClick={() => (canManageWholesale ? router.push('/admin/wholesale/admin') : onBack())}>
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
          <div className={styles.topbarActions}>
            <button className={styles.secondary} onClick={() => router.push('/admin/wholesale/admin')}>
              Вернуться к менеджерам
            </button>
            <button onClick={() => router.push(`/admin/wholesale/create?managerId=${managerDetailId}`)}>
              Создать прайс
            </button>
          </div>
        </div>

        {status ? <p className={styles.status}>{status}</p> : null}

        {renderPriceListCards('У менеджера пока нет прайсов.')}
      </section>
    );
  }

  if (screen === 'create' || screen === 'edit') {
    return (
      <WholesalePriceEditorScreen
        screen={screen}
        status={status}
        analyticsBackHref={analyticsBackHref}
        editorBackHref={editorBackHref}
        editorLoading={editorLoading}
        editor={editor}
        setEditor={setEditor}
        commentRows={commentRows}
        canManageWholesale={canManageWholesale}
        developmentManagers={developmentManagers}
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
        itemByKey={itemByKey}
        catalogDiscountBaseByKey={catalogDiscountBaseByKey}
        calculateDiscount={calculateDiscount}
        setPriceGroupVisible={setPriceGroupVisible}
        setProductVisible={setProductVisible}
        updateItem={updateItem}
        savePriceList={savePriceList}
        busy={busy}
        router={router}
      />
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
