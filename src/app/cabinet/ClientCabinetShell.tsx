'use client';

import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { ClientChatPanel } from '@/features/client-chat/ClientChatPanel';
import { ClientPriceRequestList } from '@/features/client-requests/ClientPriceRequestList';
import type { ClientCompanyPriceList, ClientDocument, ClientPortalProfile, ClientPriceRequest } from '@/shared/lib/db';
import { formatFileSize } from '@/shared/lib/formatFileSize';
import dataStyles from './ClientCabinetData.module.scss';
import documentStyles from './ClientCabinetDocuments.module.scss';
import priceStyles from './ClientCabinetPrices.module.scss';
import shellStyles from './ClientCabinetShell.module.scss';

const styles = { ...shellStyles, ...priceStyles, ...dataStyles, ...documentStyles };

type Tab = 'prices' | 'requests' | 'documents' | 'chat' | 'data';

const TABS: Array<{ value: Tab; label: string; description: string }> = [
  { value: 'prices', label: 'Прайсы', description: 'Актуальные индивидуальные прайсы' },
  { value: 'requests', label: 'Заявки', description: 'Отправленные заявки' },
  { value: 'documents', label: 'Документы', description: 'Файлы от менеджера' },
  { value: 'chat', label: 'Чат', description: 'Переписка с менеджером' },
  { value: 'data', label: 'Данные', description: 'Контакты и пароль' },
];

const TAB_VALUES = new Set<Tab>(TABS.map((tab) => tab.value));

function resolveTab(value: string | null): Tab {
  return value && TAB_VALUES.has(value as Tab) ? (value as Tab) : 'prices';
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ManagerContact({
  emptyText,
  email,
  name,
  phone,
}: {
  emptyText: string;
  email: string;
  name: string;
  phone: string;
}) {
  const contact = [email, phone].filter(Boolean).join(' · ');

  return (
    <>
      <strong>{name || emptyText}</strong>
      {contact ? <small className={styles.dataContact}>{contact}</small> : null}
    </>
  );
}

function PriceListGrid({ priceLists }: { priceLists: ClientCompanyPriceList[] }) {
  if (priceLists.length === 0) {
    return (
      <div className={styles.emptyState}>
        <h3>Прайсы пока не привязаны</h3>
        <p>Актуальные прайсы появятся здесь после назначения менеджером.</p>
      </div>
    );
  }

  return (
    <div className={styles.priceListGrid}>
      {priceLists.map((priceList) => (
        <article className={styles.priceListCard} key={priceList.id}>
          <div>
            <h3>{priceList.title}</h3>
          </div>
          <dl>
            <div>
              <dt>Позиций</dt>
              <dd>{priceList.itemCount}</dd>
            </div>
            <div>
              <dt>Действует до</dt>
              <dd>{priceList.validUntil || '—'}</dd>
            </div>
            <div>
              <dt>Обновлен</dt>
              <dd>{formatDate(priceList.updatedAt)}</dd>
            </div>
          </dl>
          <div className={styles.priceListActions}>
            <Link className={styles.primaryLink} href={`/price/${priceList.token}`} target="_blank" rel="noopener noreferrer">
              Открыть прайс
            </Link>
            <Link className={styles.secondaryLink} href={`/price/${priceList.token}/pdf`}>
              Скачать PDF
            </Link>
            <Link className={styles.secondaryLink} href={`/price/${priceList.token}/excel`}>
              Скачать Excel
            </Link>
          </div>
        </article>
      ))}
    </div>
  );
}

function DocumentGrid({ documents }: { documents: ClientDocument[] }) {
  if (documents.length === 0) {
    return (
      <div className={styles.emptyState}>
        <h3>Документов пока нет</h3>
        <p>Файлы появятся здесь после загрузки менеджером.</p>
      </div>
    );
  }

  return (
    <div className={styles.documentGrid}>
      {documents.map((document) => (
        <article className={styles.documentCard} key={document.id}>
          <div>
            <span>Документ</span>
            <h3>{document.title || document.originalName}</h3>
            <p>
              {document.originalName} · {formatFileSize(document.fileSize)} · {formatDate(document.createdAt)}
            </p>
          </div>
          <a
            className={styles.documentDownloadLink}
            href={`/api/client/documents/${document.id}/download`}
            target="_blank"
            rel="noreferrer"
          >
            Скачать
          </a>
        </article>
      ))}
    </div>
  );
}

type ClientCabinetShellProps = {
  documents: ClientDocument[];
  profile: ClientPortalProfile;
  requests: ClientPriceRequest[];
};

export function ClientCabinetShell({ documents, profile, requests }: ClientCabinetShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState<Tab>(() => resolveTab(tabParam));
  const [clientDocuments, setClientDocuments] = useState<ClientDocument[]>(documents);
  const [chatUnreadCount, setChatUnreadCount] = useState(profile.company.chatUnreadCount || 0);
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [repeatPassword, setRepeatPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [passwordStatus, setPasswordStatus] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');

  useEffect(() => {
    setActiveTab(resolveTab(tabParam));
  }, [tabParam]);

  useEffect(() => {
    setClientDocuments(documents);
  }, [documents]);

  const loadUnreadCount = useCallback(async () => {
    const response = await fetch('/api/client/chat/unread', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    setChatUnreadCount(Number(data.unreadCount ?? 0));
  }, []);

  const loadDocuments = useCallback(async () => {
    const response = await fetch('/api/client/documents', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json().catch(() => ({}));
    setClientDocuments(Array.isArray(data.documents) ? data.documents : []);
  }, []);

  useEffect(() => {
    if (activeTab === 'chat') return undefined;

    void loadUnreadCount();
    if (activeTab === 'documents') void loadDocuments();

    const events = new EventSource('/api/client/events');
    events.addEventListener('chat.updated', () => {
      void loadUnreadCount();
    });
    events.addEventListener('documents.updated', () => {
      if (activeTab === 'documents') void loadDocuments();
    });

    return () => {
      events.close();
    };
  }, [activeTab, loadDocuments, loadUnreadCount]);

  const selectTab = (tab: Tab) => {
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

  const logout = async () => {
    await fetch('/api/client/logout', { method: 'POST' });
    router.push('/cabinet/login');
    router.refresh();
  };

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    setPasswordStatus('');
    setPasswordSuccess('');
    if (nextPassword !== repeatPassword) {
      setPasswordStatus('Новый пароль и повтор не совпадают');
      return;
    }

    setBusy(true);
    const response = await fetch('/api/client/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, nextPassword }),
    });
    const data = await response.json().catch(() => ({}));
    setBusy(false);

    if (!response.ok) {
      setPasswordStatus(typeof data.error === 'string' ? data.error : 'Не удалось изменить пароль');
      return;
    }

    setCurrentPassword('');
    setNextPassword('');
    setRepeatPassword('');
    setPasswordSuccess('Пароль изменен');
  };

  const activeTabInfo = TABS.find((tab) => tab.value === activeTab) ?? TABS[0];

  const panel = (() => {
    if (activeTab === 'prices') return <PriceListGrid priceLists={profile.priceLists} />;

    if (activeTab === 'requests') {
      return (
        <ClientPriceRequestList
          emptyText="Заявки появятся здесь после отправки из прайса."
          emptyTitle="Заявок пока нет"
          requests={requests}
        />
      );
    }

    if (activeTab === 'documents') return <DocumentGrid documents={clientDocuments} />;

    if (activeTab === 'chat') {
      return (
        <ClientChatPanel
          endpoint="/api/client/chat"
          eventsEndpoint="/api/client/events"
          currentAuthorType="client"
          onUnreadCountChange={setChatUnreadCount}
        />
      );
    }

    return (
      <div className={styles.dataGrid}>
        <article className={styles.dataCard}>
          <strong>Компания</strong>
          <div className={styles.dataRows}>
            <div>
              <span>Название</span>
              <strong>{profile.company.title}</strong>
            </div>
            <div>
              <span>Email</span>
              <strong>{profile.company.email || profile.email}</strong>
            </div>
            <div>
              <span>Телефон</span>
              <strong>{profile.company.phone || profile.phone || 'Не указан'}</strong>
            </div>
            <div>
              <span>Менеджер</span>
              <ManagerContact
                emptyText="Не назначен"
                email={profile.company.managerEmail}
                name={profile.company.managerName}
                phone={profile.company.managerPhone}
              />
            </div>
            <div>
              <span>Сопровождение</span>
              <ManagerContact
                emptyText="Не назначено"
                email={profile.company.supportManagerEmail}
                name={profile.company.supportManagerName}
                phone={profile.company.supportManagerPhone}
              />
            </div>
          </div>
        </article>

        <article className={styles.dataCard}>
          <strong>Смена пароля</strong>
          <form className={styles.passwordForm} onSubmit={changePassword}>
            <label className={styles.field}>
              <span>Текущий пароль</span>
              <input
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                autoComplete="current-password"
              />
            </label>
            <label className={styles.field}>
              <span>Новый пароль</span>
              <input
                type="password"
                value={nextPassword}
                onChange={(event) => setNextPassword(event.target.value)}
                autoComplete="new-password"
              />
            </label>
            <label className={styles.field}>
              <span>Повторите новый пароль</span>
              <input
                type="password"
                value={repeatPassword}
                onChange={(event) => setRepeatPassword(event.target.value)}
                autoComplete="new-password"
              />
            </label>
            <button className={styles.submit} disabled={busy}>
              {busy ? 'Сохраняем...' : 'Изменить пароль'}
            </button>
            {passwordStatus ? <p className={styles.status}>{passwordStatus}</p> : null}
            {passwordSuccess ? <p className={styles.successStatus}>{passwordSuccess}</p> : null}
          </form>
        </article>
      </div>
    );
  })();

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <section className={styles.topbar}>
          <div>
            <p>Личный кабинет</p>
            <h1>{profile.company.title}</h1>
          </div>
          <button className={styles.logout} onClick={logout}>
            Выйти
          </button>
        </section>

        <div className={styles.dashboardLayout}>
          <aside className={styles.sidebar} aria-label="Разделы личного кабинета">
            <div className={styles.sidebarHeader}>
              <span>Личный кабинет</span>
              <strong>Разделы</strong>
            </div>
            <nav className={styles.sideNav}>
              {TABS.map((tab) => (
                <button
                  className={activeTab === tab.value ? styles.sideNavActive : styles.sideNavItem}
                  key={tab.value}
                  type="button"
                  onClick={() => selectTab(tab.value)}
                >
                  <span>
                    {tab.label}
                    {tab.value === 'chat' && chatUnreadCount > 0 ? <span className={styles.unreadBadge}>{chatUnreadCount}</span> : null}
                  </span>
                  <small>{tab.description}</small>
                </button>
              ))}
            </nav>
          </aside>

          <section className={styles.content}>
            <div className={styles.contentHeader}>
              <div>
                <span>Раздел</span>
                <h2>{activeTabInfo.label}</h2>
                <p>{activeTabInfo.description}</p>
              </div>
              {activeTab === 'prices' ? <strong>{profile.priceLists.length} прайсов</strong> : null}
              {activeTab === 'requests' ? <strong>заявки:{requests.length}</strong> : null}
            </div>
            <div className={styles.contentBody}>{panel}</div>
          </section>
        </div>
      </div>
    </main>
  );
}
