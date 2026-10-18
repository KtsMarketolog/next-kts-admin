'use client';

import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import styles from '@/app/admin/admin.module.scss';
import { ClientChatPanel } from '@/features/client-chat/ClientChatPanel';
import { AdminClientDocumentsPanel } from './AdminClientDocumentsPanel';
import { DetailRow, ClientPriceListGrid } from './AdminClientDetailParts';
import { formatDate, readApiError } from './AdminClientDetail.helpers';
import { resolveClientTab, tabs } from './AdminClientDetail.types';
import type { AdminClientDetailSectionProps, ClientCompany, ClientTab } from './AdminClientDetail.types';
import { ClientPriceRequestList } from '@/features/client-requests/ClientPriceRequestList';
import type { ClientCompanyPriceList, ClientDocument, ClientPriceRequest } from '@/shared/lib/db';
import { startClientRealtimeSync } from '@/shared/lib/clientRealtimeSync';
import { ADMIN_UNKNOWN_OUTCOME, ADMIN_UPLOAD_TIMEOUT_MS } from '../shared/adminRequest';
import { useAdminRequestScope } from '../shared/useAdminRequestScope';

function isSavedDocument(value: unknown, clientId: number): value is ClientDocument {
  if (!value || typeof value !== 'object') return false;
  const document = value as Partial<ClientDocument>;
  return Number.isInteger(document.id) && Number(document.id) > 0 && document.companyId === clientId
    && typeof document.title === 'string' && typeof document.originalName === 'string';
}

export function AdminClientDetailSection({ clientId, onBack }: AdminClientDetailSectionProps) {
  const { request, cancelAll, isActive } = useAdminRequestScope();
  const documentBusyRef = useRef(false);
  const documentsGeneration = useRef(0);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const [client, setClient] = useState<ClientCompany | null>(null);
  const [priceLists, setPriceLists] = useState<ClientCompanyPriceList[]>([]);
  const [priceRequests, setPriceRequests] = useState<ClientPriceRequest[]>([]);
  const [documents, setDocuments] = useState<ClientDocument[]>([]);
  const [activeTab, setActiveTab] = useState<ClientTab>(() => resolveClientTab(tabParam));
  const [chatUnreadCount, setChatUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [documentTitle, setDocumentTitle] = useState('');
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const [documentVisible, setDocumentVisible] = useState(true);
  const [documentBusy, setDocumentBusy] = useState(false);
  const [documentStatus, setDocumentStatus] = useState('');
  const [documentFileInputKey, setDocumentFileInputKey] = useState(0);

  useEffect(() => {
    setActiveTab(resolveClientTab(tabParam));
  }, [tabParam]);

  const loadUnreadCount = useCallback(async (signal?: AbortSignal) => {
    const response = await request(`/api/admin/clients/${clientId}/chat/unread`, { cache: 'no-store', signal });
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    if (signal?.aborted) return;
    setChatUnreadCount(Number(data.unreadCount ?? 0));
  }, [clientId, request]);

  const loadDocuments = useCallback(async (signal?: AbortSignal) => {
    if (documentBusyRef.current) return;
    const generation = documentsGeneration.current;
    const response = await request(`/api/admin/clients/${clientId}/documents`, { cache: 'no-store', signal });
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    if (signal?.aborted || generation !== documentsGeneration.current) return;
    setDocuments(Array.isArray(data.documents) ? data.documents : []);
  }, [clientId, request]);

  useEffect(() => {
    if (activeTab === 'chat') return undefined;

    return startClientRealtimeSync({
      eventsEndpoint: `/api/admin/clients/${clientId}/events`,
      eventTypes: ['chat.updated', 'documents.updated', 'client.updated'],
      refresh: async (signal) => {
        await Promise.all([
          loadUnreadCount(signal),
          activeTab === 'documents' ? loadDocuments(signal) : undefined,
          request('/api/admin/clients', { cache: 'no-store', signal })
            .then((response) => response.ok ? response.json() : null)
            .then((data) => {
              if (signal.aborted || !Array.isArray(data?.companies)) return;
              const nextClient = (data.companies as ClientCompany[]).find((company) => company.id === clientId);
              if (nextClient) setClient(nextClient);
            }),
        ]);
      },
    });
  }, [activeTab, clientId, loadDocuments, loadUnreadCount, request]);

  const selectTab = (tab: ClientTab) => {
    setActiveTab(tab);
    const params = new URLSearchParams(searchParams.toString());
    if (tab === 'prices') {
      params.delete('tab');
    } else {
      params.set('tab', tab);
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const loadClient = async () => {
      setLoading(true);
      setError('');
      const [clientResponse, priceListResponse, priceRequestResponse, documentsResponse] = await Promise.all([
        request('/api/admin/clients', { cache: 'no-store', signal: controller.signal }),
        request(`/api/admin/clients/${clientId}/price-lists`, { cache: 'no-store', signal: controller.signal }),
        request(`/api/admin/clients/${clientId}/price-requests`, { cache: 'no-store', signal: controller.signal }),
        request(`/api/admin/clients/${clientId}/documents`, { cache: 'no-store', signal: controller.signal }),
      ]);
      if (!clientResponse.ok) throw new Error(await readApiError(clientResponse, 'Не удалось загрузить клиента'));
      if (!priceListResponse.ok) throw new Error(await readApiError(priceListResponse, 'Не удалось загрузить прайсы клиента'));
      if (!priceRequestResponse.ok) throw new Error(await readApiError(priceRequestResponse, 'Не удалось загрузить заявки клиента'));
      if (!documentsResponse.ok) throw new Error(await readApiError(documentsResponse, 'Не удалось загрузить документы клиента'));

      const data = await clientResponse.json();
      const priceListData = await priceListResponse.json().catch(() => ({}));
      const priceRequestData = await priceRequestResponse.json().catch(() => ({}));
      const documentsData = await documentsResponse.json().catch(() => ({}));
      const companies = Array.isArray(data.companies) ? (data.companies as ClientCompany[]) : [];
      const nextClient = companies.find((company) => company.id === clientId) ?? null;
      if (!nextClient) throw new Error('Клиент не найден');
      if (!cancelled) {
        setClient(nextClient);
        setPriceLists(Array.isArray(priceListData.priceLists) ? priceListData.priceLists : []);
        setPriceRequests(Array.isArray(priceRequestData.requests) ? priceRequestData.requests : []);
        setDocuments(Array.isArray(documentsData.documents) ? documentsData.documents : []);
        setChatUnreadCount(nextClient.chatUnreadCount || 0);
      }
    };

    loadClient()
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить клиента');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [clientId, request]);

  const runDocumentAction = async (action: () => Promise<void>) => {
    if (documentBusyRef.current) return;
    documentBusyRef.current = true;
    documentsGeneration.current += 1;
    setDocumentBusy(true);
    setDocumentStatus('');
    try {
      await action();
    } catch (actionError) {
      if (isActive()) setDocumentStatus(actionError instanceof Error ? actionError.message : 'Не удалось получить результат операции. Проверьте список документов перед повтором.');
    } finally {
      documentsGeneration.current += 1;
      documentBusyRef.current = false;
      if (isActive()) setDocumentBusy(false);
    }
  };

  const handleDocumentFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    setDocumentFile(event.target.files?.[0] ?? null);
    setDocumentStatus('');
  };

  const uploadDocument = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDocumentStatus('');
    if (!documentFile) {
      setDocumentStatus('Выберите файл');
      return;
    }

    await runDocumentAction(async () => {
      const formData = new FormData();
      formData.append('file', documentFile);
      formData.append('title', documentTitle);
      formData.append('isVisible', documentVisible ? 'true' : 'false');

      const response = await request(`/api/admin/clients/${clientId}/documents`, {
        method: 'POST',
        body: formData,
      }, { timeoutMs: ADMIN_UPLOAD_TIMEOUT_MS });
      const data = await response.json().catch(() => null);
      if (!isActive()) return;

      if (!response.ok) {
        setDocumentStatus(typeof data?.error === 'string' ? data.error : ADMIN_UNKNOWN_OUTCOME);
        return;
      }

      if (!isSavedDocument(data?.document, clientId)) throw new Error(ADMIN_UNKNOWN_OUTCOME);
      const savedDocument = data.document;
      setDocuments((current) => [savedDocument, ...current]);
      setDocumentTitle('');
      setDocumentFile(null);
      setDocumentVisible(true);
      setDocumentFileInputKey((current) => current + 1);
      setDocumentStatus('Документ прикреплен');
    });
  };

  const toggleDocumentVisibility = async (document: ClientDocument, isVisible: boolean) => {
    await runDocumentAction(async () => {
      const response = await request(`/api/admin/clients/${clientId}/documents/${document.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isVisible }),
      });
      const data = await response.json().catch(() => null);
      if (!isActive()) return;

      if (!response.ok) {
        setDocumentStatus(typeof data?.error === 'string' ? data.error : ADMIN_UNKNOWN_OUTCOME);
        return;
      }

      if (!isSavedDocument(data?.document, clientId) || data.document.id !== document.id) throw new Error(ADMIN_UNKNOWN_OUTCOME);
      const savedDocument = data.document;
      setDocuments((current) => current.map((currentDocument) => currentDocument.id === document.id ? savedDocument : currentDocument));
      setDocumentStatus('Видимость документа обновлена');
    });
  };

  const deleteDocument = async (document: ClientDocument) => {
    if (!window.confirm(`Удалить документ "${document.title || document.originalName}"?`)) return;

    await runDocumentAction(async () => {
      const response = await request(`/api/admin/clients/${clientId}/documents/${document.id}`, {
        method: 'DELETE',
      });
      const data = await response.json().catch(() => null);
      if (!isActive()) return;

      if (!response.ok) {
        setDocumentStatus(typeof data?.error === 'string' ? data.error : ADMIN_UNKNOWN_OUTCOME);
        return;
      }

      if (data?.ok !== true) throw new Error(ADMIN_UNKNOWN_OUTCOME);
      setDocuments((current) => current.filter((currentDocument) => currentDocument.id !== document.id));
      setDocumentStatus('Документ удален');
    });
  };

  const panel = (() => {
    if (!client) return null;

    if (activeTab === 'prices') return <ClientPriceListGrid clientId={clientId} priceLists={priceLists} />;

    if (activeTab === 'requests') {
      return (
        <ClientPriceRequestList
          emptyText="Заявки появятся здесь после отправки клиентом из прайса."
          emptyTitle="Заявок пока нет"
          requests={priceRequests}
        />
      );
    }

    if (activeTab === 'documents') {
      return (
        <AdminClientDocumentsPanel
          busy={documentBusy}
          clientId={client.id}
          documents={documents}
          fileInputKey={documentFileInputKey}
          isVisible={documentVisible}
          status={documentStatus}
          title={documentTitle}
          onDelete={deleteDocument}
          onFileChange={handleDocumentFileChange}
          onTitleChange={setDocumentTitle}
          onToggleVisibility={toggleDocumentVisibility}
          onUpload={uploadDocument}
          onVisibleChange={setDocumentVisible}
          onCancel={cancelAll}
        />
      );
    }

    if (activeTab === 'chat') {
      return (
        <ClientChatPanel
          key={client.id}
          endpoint={`/api/admin/clients/${client.id}/chat`}
          eventsEndpoint={`/api/admin/clients/${client.id}/events`}
          currentAuthorType="employee"
          onUnreadCountChange={setChatUnreadCount}
        />
      );
    }

    return (
      <div className={styles.clientDetailInfoGrid}>
        <DetailRow label="Компания" value={client.title} />
        <DetailRow label="Email" value={client.email} />
        <DetailRow label="Телефон" value={client.phone} />
        <DetailRow label="Логин клиента" value={client.clientLogin} />
        <DetailRow label="Менеджер" value={client.managerName} />
        <DetailRow label="Сопровождение" value={client.supportManagerName} />
        <DetailRow label="Пользователей ЛК" value={client.userCount} />
        <DetailRow label="Статус" value={client.isActive ? 'Активен' : 'Отключен'} />
        <DetailRow label="Создан" value={formatDate(client.createdAt)} />
        <DetailRow label="Обновлен" value={formatDate(client.updatedAt)} />
        <div className={styles.clientDetailNote}>
          <span>Заметка</span>
          <p>{client.note || '—'}</p>
        </div>
      </div>
    );
  })();

  if (loading) {
    return (
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div>
            <p>Клиент</p>
            <h2>Загрузка клиента</h2>
          </div>
          <button className={styles.secondary} type="button" onClick={onBack}>
            Назад к клиентам
          </button>
        </div>
        <p className={styles.mutedText}>Загружаем данные клиента...</p>
      </section>
    );
  }

  if (error || !client) {
    return (
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div>
            <p>Клиент</p>
            <h2>Клиент не найден</h2>
          </div>
          <button className={styles.secondary} type="button" onClick={onBack}>
            Назад к клиентам
          </button>
        </div>
        <p className={styles.mutedText}>{error || 'Клиент не найден'}</p>
      </section>
    );
  }

  const activeTabInfo = tabs.find((tab) => tab.value === activeTab) ?? tabs[0];

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <p>{client.isActive ? 'Активный клиент' : 'Отключенный клиент'}</p>
          <h2>{client.title || 'Без названия'}</h2>
        </div>
        <button className={styles.secondary} type="button" onClick={onBack}>
          Назад к клиентам
        </button>
      </div>

      <div className={styles.clientDetailSummary}>
        <DetailRow label="Email" value={client.email} />
        <DetailRow label="Телефон" value={client.phone} />
        <DetailRow label="Менеджер" value={client.managerName} />
        <DetailRow label="Сопровождение" value={client.supportManagerName} />
      </div>

      <div className={styles.analyticsDashboardLayout}>
        <aside className={styles.analyticsSidebar} aria-label="Разделы клиента">
          <div className={styles.analyticsSidebarHeader}>
            <span>Клиент</span>
            <strong>Разделы</strong>
          </div>
          <nav className={styles.analyticsSideNav}>
            {tabs.map((tab) => (
              <button
                className={activeTab === tab.value ? styles.analyticsSideNavActive : styles.analyticsSideNavItem}
                key={tab.value}
                type="button"
                onClick={() => selectTab(tab.value)}
              >
                <span>
                  {tab.label}
                  {tab.value === 'chat' && chatUnreadCount > 0 ? (
                    <span className={styles.clientChatBadge}>{chatUnreadCount}</span>
                  ) : null}
                </span>
                <small>{tab.description}</small>
              </button>
            ))}
          </nav>
        </aside>

        <section className={styles.analyticsContent}>
          <div className={styles.analyticsContentHeader}>
            <div>
              <span>Раздел</span>
              <h4>{activeTabInfo.label}</h4>
              <p>{activeTabInfo.description}</p>
            </div>
            {activeTab === 'prices' ? <strong>{priceLists.length} прайсов</strong> : null}
            {activeTab === 'requests' ? <strong>{priceRequests.length} заявок</strong> : null}
          </div>
          <div className={styles.analyticsContentBody}>{panel}</div>
        </section>
      </div>
    </section>
  );
}
