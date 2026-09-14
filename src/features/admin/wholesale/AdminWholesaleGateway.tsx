'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { startClientRealtimeSync } from '@/shared/lib/clientRealtimeSync';

import styles from '@/app/admin/admin.module.scss';
import { AdminManagerAnalytics } from './AdminManagerAnalytics';
import { AdminWholesaleAnalytics } from './AdminWholesaleAnalytics';
import { WholesaleManagerManagement } from './WholesaleManagerManagement';
import { WholesaleManagerDashboard } from './WholesaleManagerDashboard';
import { WholesalePriceEditorScreen } from './WholesalePriceEditorScreen';
import { WholesalePriceListScreen } from './WholesalePriceListScreen';
import { useAdminWholesaleGatewayPath } from './useAdminWholesaleGatewayPath';
import { useWholesaleCatalogFilters } from './useWholesaleCatalogFilters';
import { useWholesaleEditorActions } from './useWholesaleEditorActions';
import { useWholesaleManagers } from './useWholesaleManagers';
import { buildPriceEditorFromPayload, normalizeClientCompanyOptions } from './AdminWholesaleGateway.helpers';

import {
  emptyEditor,
  getTextareaRows,
  mergeEditorItems,
  readApiError,
  type AdminWholesaleGatewayProps,
  type CatalogCategory,
  type ClientCompanyOption,
  type CurrentManager,
  type PriceEditor,
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
  const [currentManager, setCurrentManager] = useState<CurrentManager | null>(null);
  const [priceLists, setPriceLists] = useState<PriceList[]>([]);
  const [clientCompanies, setClientCompanies] = useState<ClientCompanyOption[]>([]);
  const editorCompaniesRef = useRef<ClientCompanyOption[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogCategory[]>([]);
  const [editor, setEditor] = useState<PriceEditor>(() => emptyEditor());
  const [editorLoading, setEditorLoading] = useState(startsInEditor);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogCategoryId, setCatalogCategoryId] = useState('all');
  const [catalogPriceGroup, setCatalogPriceGroup] = useState('all');

  const showStatus = useCallback((message: string) => {
    setStatus(message);
    window.setTimeout(() => {
      setStatus((current) => (current === message ? '' : current));
    }, 2000);
  }, []);

  const {
    setManagers,
    managerDraft,
    setManagerDraft,
    managerBusy,
    savedManagerId,
    managerCreated,
    setManagerCreated,
    managerRoleTab,
    setManagerRoleTab,
    managerPasswordDrafts,
    setManagerPasswordDrafts,
    managerPasswordEditIds,
    setManagerPasswordEditIds,
    supportManagers,
    developmentManagers,
    managerRoleLabel,
    managerRoleTitle,
    managerRoleRows,
    loadManagers,
    copyManagerPassword,
    createManager,
    saveManager,
    deleteManager,
  } = useWholesaleManagers({ showStatus });

  const { catalogRows, catalogDiscountBaseByKey, catalogPriceGroups, filteredCatalogRows, filteredCatalogGroups } =
    useWholesaleCatalogFilters({
      catalog,
      catalogQuery,
      catalogCategoryId,
      catalogPriceGroup,
    });
  const {
    groupDiscounts,
    setGroupDiscounts,
    appliedGroupDiscounts,
    expandedPriceGroups,
    updateItem,
    setProductVisible,
    setPriceGroupVisible,
    togglePriceGroupExpanded,
    calculateDiscount,
  } = useWholesaleEditorActions({
    editor,
    setEditor,
    catalogDiscountBaseByKey,
    showStatus,
  });
  const itemByKey = useMemo(
    () => new Map(editor.items.map((item) => [`${item.productId}:${item.variantId ?? 'base'}`, item])),
    [editor.items],
  );
  const commentRows = useMemo(() => getTextareaRows(editor.comment), [editor.comment]);

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

  const loadClientCompanies = useCallback(async (signal?: AbortSignal): Promise<ClientCompanyOption[]> => {
    const res = await fetch('/api/admin/clients', { cache: 'no-store', signal });
    if (!res.ok) {
      if (signal) throw new Error('Не удалось обновить клиентов');
      setClientCompanies([]);
      return [];
    }
    const data = await res.json().catch(() => ({}));
    if (signal?.aborted) return [];
    const nextClientCompanies = normalizeClientCompanyOptions(data);
    setClientCompanies(nextClientCompanies);
    return nextClientCompanies;
  }, []);

  useEffect(() => {
    if ((screen === 'create' || screen === 'edit') || (canManageWholesale && screen === 'admin')) void loadManagers();
    if (screen === 'manager') {
      void loadCurrentManager();
      void loadPriceLists();
    }
    if (canManageWholesale && screen === 'managerDetail' && managerDetailId) {
      void loadManagerPriceLists(managerDetailId);
    }
  }, [canManageWholesale, loadManagerPriceLists, loadManagers, managerDetailId, screen]);

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
      editorCompaniesRef.current = null;
      setEditorLoading(true);
      const [nextCatalog, nextClientCompanies] = await Promise.all([loadCatalog(), loadClientCompanies()]);
      if (!isActive) return;
      if (screen === 'create') {
        editorCompaniesRef.current = nextClientCompanies;
        setEditor({
          ...emptyEditor(),
          managerId: canManageWholesale ? createManagerId : null,
          supportManagerId: null,
          items: mergeEditorItems(nextCatalog, []),
        });
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
      editorCompaniesRef.current = nextClientCompanies;
      setEditor(buildPriceEditorFromPayload(data.priceList, nextCatalog, nextClientCompanies));
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
  }, [canManageWholesale, createManagerId, editId, loadClientCompanies, screen, showStatus]);

  useEffect(() => {
    if ((screen !== 'create' && screen !== 'edit') || editorLoading || !editorCompaniesRef.current) return undefined;

    let previousCompanies = editorCompaniesRef.current;
    return startClientRealtimeSync({
      eventsEndpoint: '/api/admin/clients/events',
      eventTypes: ['client.updated'],
      refresh: async (signal) => {
        const nextCompanies = await loadClientCompanies(signal);
        if (signal.aborted) return;
        const previous = previousCompanies;
        previousCompanies = nextCompanies;
        setEditor((current) => {
          const company = nextCompanies.find((item) => item.id === current.clientCompanyId);
          const before = previous.find((item) => item.id === current.clientCompanyId);
          if (!company || !before) return current;
          // Only synchronize changed server assignments, preserving local unsaved choices.
          return {
            ...current,
            clientName: current.clientName === before.title ? company.title : current.clientName,
            managerId: current.managerId === before.managerId ? company.managerId : current.managerId,
            supportManagerId: current.supportManagerId === before.supportManagerId ? company.supportManagerId : current.supportManagerId,
          };
        });
      },
    });
  }, [editorLoading, loadClientCompanies, screen]);

  const savePriceList = async () => {
    if (!editor.title.trim()) {
      showStatus('Введите название прайса');
      return;
    }
    const selectedClientCompany = clientCompanies.find((company) => company.id === editor.clientCompanyId)
      ?? clientCompanies.find((company) => company.title.trim().toLowerCase() === editor.clientName.trim().toLowerCase())
      ?? null;
    if (!selectedClientCompany) {
      showStatus('Выберите клиента из списка');
      return;
    }
    if (canManageWholesale && !editor.managerId) {
      showStatus('Выберите менеджера по развитию');
      return;
    }
    if (!editor.supportManagerId) {
      showStatus('Выберите менеджера по сопровождению');
      return;
    }

    const method = screen === 'edit' ? 'PUT' : 'POST';
    const url = screen === 'edit' && editor.id ? `/api/admin/wholesale/price-lists/${editor.id}` : '/api/admin/wholesale/price-lists';
    setBusy(true);
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...editor,
        clientCompanyId: selectedClientCompany.id,
        clientName: selectedClientCompany.title,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      showStatus(await readApiError(res, 'Не удалось сохранить прайс'));
      return;
    }
    showStatus('Прайс сохранён');
    router.push(editorBackHref);
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

  const editPriceList = (item: PriceList) => {
    const managerReturnParam = screen === 'managerDetail' && managerDetailId ? `?managerId=${managerDetailId}` : '';
    router.push(`/admin/wholesale/${item.id}/edit${managerReturnParam}`);
  };

  const createPriceList = (managerId?: number | null) => {
    router.push(managerId ? `/admin/wholesale/create?managerId=${managerId}` : '/admin/wholesale/create');
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

        <AdminWholesaleAnalytics
          managerManagementContent={(
            <WholesaleManagerManagement
              managerRoleTab={managerRoleTab}
              managerDraft={managerDraft}
              managerRoleTitle={managerRoleTitle}
              managerRoleLabel={managerRoleLabel}
              managerRoleRows={managerRoleRows}
              managerPasswordEditIds={managerPasswordEditIds}
              managerPasswordDrafts={managerPasswordDrafts}
              busy={managerBusy}
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
      <WholesaleManagerDashboard
        onBack={onBack}
        priceCount={priceLists.length}
        priceContent={(
          <WholesalePriceListScreen
            mode="manager"
            currentManager={currentManager}
            canManageWholesale={canManageWholesale}
            managerDetailId={managerDetailId}
            status={status}
            priceLists={priceLists}
            copiedToken={copiedToken}
            onBack={onBack}
            onAdminBack={() => router.push('/admin/wholesale/admin')}
            onManagersBack={() => router.push('/admin/wholesale/admin?tab=managers')}
            onCreate={createPriceList}
            onEdit={editPriceList}
            onOpen={(item) => window.open(`/price/${item.token}`, '_blank')}
            onCopyLink={copyLink}
            onDelete={deletePriceList}
            embedded
            showBackButton={false}
          />
        )}
      />
    );
  }

  if (screen === 'managerDetail') {
    return (
      <WholesalePriceListScreen
        mode="managerDetail"
        currentManager={currentManager}
        canManageWholesale={canManageWholesale}
        managerDetailId={managerDetailId}
        status={status}
        priceLists={priceLists}
        copiedToken={copiedToken}
        onBack={onBack}
        onAdminBack={() => router.push('/admin/wholesale/admin')}
        onManagersBack={() => router.push('/admin/wholesale/admin?tab=managers')}
        onCreate={createPriceList}
        onEdit={editPriceList}
        onOpen={(item) => window.open(`/price/${item.token}`, '_blank')}
        onCopyLink={copyLink}
        onDelete={deletePriceList}
      />
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
        clientCompanies={clientCompanies}
        developmentManagers={developmentManagers}
        supportManagers={supportManagers}
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
