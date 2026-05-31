'use client';

import { ChangeEvent, FormEvent, useCallback, useEffect, useState } from 'react';
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

export function AdminClientDetailSection({ clientId, onBack }: AdminClientDetailSectionProps) {
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

  const loadUnreadCount = useCallback(async () => {
    const response = await fetch(`/api/admin/clients/${clientId}/chat/unread`, { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    setChatUnreadCount(Number(data.unreadCount ?? 0));
  }, [clientId]);

  const loadDocuments = useCallback(async () => {
    const response = await fetch(`/api/admin/clients/${clientId}/documents`, { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    setDocuments(Array.isArray(data.documents) ? data.documents : []);
  }, [clientId]);

  useEffect(() => {
    if (activeTab === 'chat') return undefined;

    void loadUnreadCount();
    if (activeTab === 'documents') void loadDocuments();

    const events = new EventSource(`/api/admin/clients/${clientId}/events`);
    events.addEventListener('chat.updated', () => {
      void loadUnreadCount();
    });
    events.addEventListener('documents.updated', () => {
      if (activeTab === 'documents') void loadDocuments();
    });
    events.addEventListener('client.updated', (event) => {
      let payload: { companyId?: number } = {};
      try {
        payload = JSON.parse((event as MessageEvent).data || '{}') as { companyId?: number };
      } catch {
        return;
      }
      if (Number(payload.companyId) !== clientId) return;
      void fetch('/api/admin/clients', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          const companies = Array.isArray(data?.companies) ? (data.companies as ClientCompany[]) : [];
          const nextClient = companies.find((company) => company.id === clientId) ?? null;
          if (nextClient) setClient(nextClient);
        })
        .catch(() => {});
    });

    return () => {
      events.close();
    };
  }, [activeTab, clientId, loadDocuments, loadUnreadCount]);

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

    const loadClient = async () => {
      setLoading(true);
      setError('');
      const [clientResponse, priceListResponse, priceRequestResponse, documentsResponse] = await Promise.all([
        fetch('/api/admin/clients', { cache: 'no-store' }),
        fetch(`/api/admin/clients/${clientId}/price-lists`, { cache: 'no-store' }),
        fetch(`/api/admin/clients/${clientId}/price-requests`, { cache: 'no-store' }),
        fetch(`/api/admin/clients/${clientId}/documents`, { cache: 'no-store' }),
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
    };
  }, [clientId]);

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

    setDocumentBusy(true);
    const formData = new FormData();
    formData.append('file', documentFile);
    formData.append('title', documentTitle);
    formData.append('isVisible', documentVisible ? 'true' : 'false');

    const response = await fetch(`/api/admin/clients/${clientId}/documents`, {
      method: 'POST',
      body: formData,
    });
    const data = await response.json().catch(() => ({}));
    setDocumentBusy(false);

    if (!response.ok) {
      setDocumentStatus(typeof data.error === 'string' ? data.error : 'Не удалось прикрепить документ');
      return;
    }

    if (data.document) {
      setDocuments((current) => [data.document as ClientDocument, ...current]);
    }
    setDocumentTitle('');
    setDocumentFile(null);
    setDocumentVisible(true);
    setDocumentFileInputKey((current) => current + 1);
    setDocumentStatus('Документ прикреплен');
  };

  const toggleDocumentVisibility = async (document: ClientDocument, isVisible: boolean) => {
    setDocumentStatus('');
    const response = await fetch(`/api/admin/clients/${clientId}/documents/${document.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isVisible }),
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      setDocumentStatus(typeof data.error === 'string' ? data.error : 'Не удалось обновить документ');
      return;
    }

    if (data.document) {
      setDocuments((current) =>
        current.map((currentDocument) =>
          currentDocument.id === document.id ? (data.document as ClientDocument) : currentDocument,
        ),
      );
    }
  };

  const deleteDocument = async (document: ClientDocument) => {
    if (!window.confirm(`Удалить документ "${document.title || document.originalName}"?`)) return;

    setDocumentStatus('');
    const response = await fetch(`/api/admin/clients/${clientId}/documents/${document.id}`, {
      method: 'DELETE',
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      setDocumentStatus(typeof data.error === 'string' ? data.error : 'Не удалось удалить документ');
      return;
    }

    setDocuments((current) => current.filter((currentDocument) => currentDocument.id !== document.id));
    setDocumentStatus('Документ удален');
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
        />
      );
    }

    if (activeTab === 'chat') {
      return (
        <ClientChatPanel
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
