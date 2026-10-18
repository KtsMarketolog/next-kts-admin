'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { startClientRealtimeSync } from '@/shared/lib/clientRealtimeSync';
import { AdminRequestError, ADMIN_UNKNOWN_OUTCOME } from '../shared/adminRequest';
import { useAdminRequestScope } from '../shared/useAdminRequestScope';

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
import { assertWholesaleEditorCompanies, parseWholesaleEditorCatalog, parseWholesaleEditorPrice, readWholesaleEditorResponse } from './wholesaleEditorLoad';

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
  const { request, cancelAll, isActive } = useAdminRequestScope();
  const router = useRouter();
  const {
    analyticsBackHref,
    createManagerId,
    editId,
    editorBackHref,
    managerAnalyticsId,
    managerDetailId,
    screen,
  } = useAdminWholesaleGatewayPath(canManageWholesale);
  const [currentManager, setCurrentManager] = useState<CurrentManager | null>(null);
  const [priceLists, setPriceLists] = useState<PriceList[]>([]);
  const [clientCompanies, setClientCompanies] = useState<ClientCompanyOption[]>([]);
  const editorCompaniesRef = useRef<ClientCompanyOption[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogCategory[]>([]);
  const [editor, setEditor] = useState<PriceEditor>(() => emptyEditor());
  const editorKey = `${screen}:${editId ?? ''}:${createManagerId ?? ''}:${canManageWholesale}`;
  const viewKeyRef = useRef(editorKey);
  useLayoutEffect(() => {
    viewKeyRef.current = editorKey;
    return cancelAll;
  }, [cancelAll, editorKey]);
  const [editorLoad, setEditorLoad] = useState<
    { key: string; state: 'loading' | 'ready' } | { key: string; state: 'error'; message: string }
  >({ key: '', state: 'loading' });
  const [editorLoadAttempt, setEditorLoadAttempt] = useState(0);
  const editorLoading = editorLoad.key !== editorKey || editorLoad.state === 'loading';
  const editorReady = editorLoad.key === editorKey && editorLoad.state === 'ready';
  const editorLoadError = editorLoad.key === editorKey && editorLoad.state === 'error' ? editorLoad.message : '';
  const [editorSaveError, setEditorSaveError] = useState('');
  const [editorSaveConflict, setEditorSaveConflict] = useState(false);
  const savingRef = useRef(false);
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
    managerRequestError,
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

  const loadPriceLists = useCallback(async () => {
    const view = viewKeyRef.current;
    const res = await request('/api/admin/wholesale/price-lists', { cache: 'no-store' });
    if (!res.ok) throw new Error(await readApiError(res, 'Не удалось загрузить прайсы'));
    const data = await res.json();
    if (!Array.isArray(data.priceLists)) throw new Error('Список прайсов получен не полностью');
    if (!isActive() || view !== viewKeyRef.current) return;
    setPriceLists(data.priceLists);
  }, [isActive, request]);

  const loadCurrentManager = useCallback(async () => {
    const view = viewKeyRef.current;
    const res = await request('/api/admin/session', { cache: 'no-store' });
    if (!res.ok) throw new Error('Не удалось загрузить данные менеджера');
    const data = await res.json();
    if (!isActive() || view !== viewKeyRef.current) return;
    setCurrentManager(data.manager ?? null);
  }, [isActive, request]);

  const loadManagerPriceLists = useCallback(async (managerId: number) => {
    const view = viewKeyRef.current;
    const res = await request(`/api/admin/wholesale/managers/${managerId}/price-lists`, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(await readApiError(res, 'Не удалось загрузить прайсы менеджера'));
    }
    const data = await res.json();
    if (!Array.isArray(data.priceLists)) throw new Error('Список прайсов получен не полностью');
    if (!isActive() || view !== viewKeyRef.current) return;
    setCurrentManager(data.manager ?? null);
    setPriceLists(data.priceLists);
  }, [isActive, request]);

  const loadClientCompanies = useCallback(async (signal: AbortSignal): Promise<ClientCompanyOption[]> => {
    const data = await readWholesaleEditorResponse('/api/admin/clients', signal, 'Не удалось загрузить список клиентов');
    assertWholesaleEditorCompanies(data);
    return normalizeClientCompanyOptions(data);
  }, []);

  useEffect(() => {
    let active = true;
    const failed = (error: unknown) => {
      if (active) setStatus(error instanceof Error ? error.message : 'Не удалось загрузить прайсы');
    };
    if ((screen === 'create' || screen === 'edit') || (canManageWholesale && screen === 'admin')) void loadManagers();
    if (screen === 'manager') {
      void loadCurrentManager().catch(failed);
      void loadPriceLists().catch(failed);
    }
    if (canManageWholesale && screen === 'managerDetail' && managerDetailId) {
      void loadManagerPriceLists(managerDetailId).catch(failed);
    }
    return () => { active = false; };
  }, [canManageWholesale, loadCurrentManager, loadManagerPriceLists, loadManagers, loadPriceLists, managerDetailId, screen]);

  useEffect(() => {
    if (!canManageWholesale && (screen === 'admin' || screen === 'managerDetail' || screen === 'managerAnalytics')) {
      router.replace('/admin/wholesale/manager', { scroll: false });
    }
  }, [canManageWholesale, router, screen]);

  useEffect(() => {
    if (screen !== 'create' && screen !== 'edit') {
      editorCompaniesRef.current = null;
      return;
    }

    let isActive = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      if (!isActive) return;
      isActive = false;
      controller.abort();
      setEditorLoad({ key: editorKey, state: 'error', message: 'Сервер не ответил вовремя. Повторите загрузку.' });
    }, 60_000);

    async function loadEditorData() {
      editorCompaniesRef.current = null;
      setEditorLoad({ key: editorKey, state: 'loading' });
      setEditorSaveError('');
      setEditorSaveConflict(false);
      const [catalogData, nextClientCompanies, priceData] = await Promise.all([
        readWholesaleEditorResponse('/api/admin/wholesale/catalog', controller.signal, 'Не удалось загрузить каталог'),
        loadClientCompanies(controller.signal),
        screen === 'edit' && editId
          ? readWholesaleEditorResponse(`/api/admin/wholesale/price-lists/${editId}`, controller.signal, 'Не удалось загрузить прайс')
          : Promise.resolve(null),
      ]);
      if (!isActive) return;
      const nextCatalog = parseWholesaleEditorCatalog(catalogData);
      const nextEditor = screen === 'create'
        ? {
          ...emptyEditor(),
          managerId: canManageWholesale ? createManagerId : null,
          supportManagerId: null,
          items: mergeEditorItems(nextCatalog, []),
        }
        : buildPriceEditorFromPayload(parseWholesaleEditorPrice(priceData, editId!), nextCatalog, nextClientCompanies);
      // Publish one complete load only. Never expose a prior route's draft or a partial catalogue.
      editorCompaniesRef.current = nextClientCompanies;
      setCatalog(nextCatalog);
      setClientCompanies(nextClientCompanies);
      setEditor(nextEditor);
      setEditorLoad({ key: editorKey, state: 'ready' });
    }

    void loadEditorData().catch((error: unknown) => {
      if (!isActive) return;
      controller.abort();
      setEditorLoad({ key: editorKey, state: 'error', message: error instanceof Error ? error.message : 'Не удалось загрузить данные прайса' });
    }).finally(() => window.clearTimeout(timeout));

    return () => {
      isActive = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [canManageWholesale, createManagerId, editId, editorKey, editorLoadAttempt, loadClientCompanies, screen]);

  useEffect(() => {
    if ((screen !== 'create' && screen !== 'edit') || !editorReady || !editorCompaniesRef.current) return undefined;

    let previousCompanies = editorCompaniesRef.current;
    return startClientRealtimeSync({
      eventsEndpoint: '/api/admin/clients/events',
      eventTypes: ['client.updated'],
      refresh: async (signal) => {
        const nextCompanies = await loadClientCompanies(signal);
        if (signal.aborted) return;
        setClientCompanies(nextCompanies);
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
  }, [editorReady, editorKey, loadClientCompanies, screen]);

  const savePriceList = async () => {
    if (editorSaveConflict) return;
    if (!editorReady || (screen === 'edit' && editor.id !== editId)) {
      setEditorSaveError('Дождитесь полной загрузки редактора. Сохранение недоступно.');
      return;
    }
    if (savingRef.current) return;
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
    savingRef.current = true;
    setBusy(true);
    setEditorSaveError('');
    try {
      const res = await request(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...editor,
          expectedRevision: editor.revision,
          // Unavailable rows are retained in the model, but are not edited here.
          // With server-side upsert they remain untouched, including legacy overrides.
          items: editor.items.filter((item) => catalogDiscountBaseByKey.has(`${item.productId}:${item.variantId ?? 'base'}`)),
          clientCompanyId: selectedClientCompany.id,
          clientName: selectedClientCompany.title,
        }),
      }, { timeoutMs: 60_000 });
      if (!isActive() || viewKeyRef.current !== editorKey) return;
      if (!res.ok) {
        if (res.status === 409) setEditorSaveConflict(true);
        setEditorSaveError(await readApiError(res, 'Не удалось сохранить прайс'));
        return;
      }
      showStatus('Прайс сохранён');
      router.push(editorBackHref);
    } catch (error) {
      if (isActive() && viewKeyRef.current === editorKey) {
        setEditorSaveError(error instanceof AdminRequestError ? error.message : ADMIN_UNKNOWN_OUTCOME);
      }
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  };

  const deletePriceList = async (id: number) => {
    if (savingRef.current) return;
    if (!confirm('Удалить прайс?')) return;
    savingRef.current = true;
    setBusy(true);
    let deleted = false;
    try {
      const res = await request(`/api/admin/wholesale/price-lists/${id}`, { method: 'DELETE' });
      if (!isActive() || viewKeyRef.current !== editorKey) return;
      if (!res.ok) {
        setStatus(await readApiError(res, 'Не удалось удалить прайс'));
        return;
      }
      deleted = true;
      setPriceLists((current) => current.filter((item) => item.id !== id));
      if (screen === 'managerDetail' && managerDetailId) {
        await loadManagerPriceLists(managerDetailId);
      } else {
        await loadPriceLists();
      }
      if (isActive() && viewKeyRef.current === editorKey) showStatus('Прайс удалён');
    } catch (error) {
      if (isActive() && viewKeyRef.current === editorKey) setStatus(deleted
        ? 'Прайс удалён, но список не обновился. Обновите страницу; повторно удалять не нужно.'
        : error instanceof AdminRequestError ? error.message : ADMIN_UNKNOWN_OUTCOME);
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  };

  const copyLink = async (item: PriceList) => {
    const url = `${window.location.origin}/price/${item.token}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      setStatus('Не удалось скопировать ссылку. Разрешите доступ к буферу обмена и повторите.');
      return;
    }
    void request(`/api/admin/wholesale/price-lists/${item.id}/copy-link`, { method: 'POST' }).catch(() => {});
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
          <div className={styles.actions}>
            <button className={styles.secondary} onClick={() => router.push('/admin/wholesale/requests')}>Заявки из прайсов</button>
            <button className={styles.secondary} onClick={onBack}>Вернуться в панель управления</button>
          </div>
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
              requestError={managerRequestError}
              reloadManagers={loadManagers}
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
            busy={busy}
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
        busy={busy}
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
        editorLoadError={editorLoadError}
        editorSaveError={editorSaveError}
        editorSaveConflict={editorSaveConflict}
        retryEditorLoad={() => {
          if (editorSaveConflict && !confirm('Загрузить актуальные данные? Ваши несохранённые изменения в этой форме будут заменены.')) return;
          setEditorLoad({ key: editorKey, state: 'loading' });
          setEditorLoadAttempt((attempt) => attempt + 1);
        }}
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
