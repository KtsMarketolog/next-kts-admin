'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import styles from '@/app/admin/admin.module.scss';
import { ClientChatPanel } from '@/features/client-chat/ClientChatPanel';

type ClientCompany = {
  id: number;
  title: string;
  email: string;
  phone: string;
  note: string;
  managerId: number | null;
  managerName: string;
  supportManagerId: number | null;
  supportManagerName: string;
  userCount: number;
  clientLogin: string;
  clientUserId: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

type ClientTab = 'prices' | 'documents' | 'chat' | 'data';

type AdminClientDetailSectionProps = {
  clientId: number;
  onBack: () => void;
};

const tabs: Array<{ value: ClientTab; label: string }> = [
  { value: 'prices', label: 'Прайсы' },
  { value: 'documents', label: 'Документы' },
  { value: 'chat', label: 'Чат' },
  { value: 'data', label: 'Данные клиента' },
];

const CLIENT_TAB_VALUES = new Set<ClientTab>(tabs.map((tab) => tab.value));

function resolveClientTab(value: string | null): ClientTab {
  return value && CLIENT_TAB_VALUES.has(value as ClientTab) ? (value as ClientTab) : 'prices';
}

async function readApiError(response: Response, fallback: string) {
  const data = await response.json().catch(() => null);
  return typeof data?.error === 'string' && data.error ? data.error : fallback;
}

function formatDate(value: string) {
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

function DetailRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  const displayValue = value === null || value === undefined || value === '' ? '—' : value;
  return (
    <div className={styles.clientDetailInfoItem}>
      <span>{label}</span>
      <strong>{displayValue}</strong>
    </div>
  );
}

function EmptyClientTab({ title, text }: { title: string; text: string }) {
  return (
    <div className={styles.clientEmptyState}>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

export function AdminClientDetailSection({ clientId, onBack }: AdminClientDetailSectionProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const [client, setClient] = useState<ClientCompany | null>(null);
  const [activeTab, setActiveTab] = useState<ClientTab>(() => resolveClientTab(tabParam));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setActiveTab(resolveClientTab(tabParam));
  }, [tabParam]);

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
      const response = await fetch('/api/admin/clients', { cache: 'no-store' });
      if (!response.ok) throw new Error(await readApiError(response, 'Не удалось загрузить клиента'));
      const data = await response.json();
      const companies = Array.isArray(data.companies) ? (data.companies as ClientCompany[]) : [];
      const nextClient = companies.find((company) => company.id === clientId) ?? null;
      if (!nextClient) throw new Error('Клиент не найден');
      if (!cancelled) setClient(nextClient);
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

  const panel = useMemo(() => {
    if (!client) return null;

    if (activeTab === 'prices') {
      return <EmptyClientTab title="Прайсы пока не привязаны" text="Действующие прайсы остаются в прежнем разделе." />;
    }

    if (activeTab === 'documents') {
      return <EmptyClientTab title="Документы пока не добавлены" text="Файлов по клиенту нет." />;
    }

    if (activeTab === 'chat') {
      return <ClientChatPanel endpoint={`/api/admin/clients/${client.id}/chat`} currentAuthorType="employee" />;
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
  }, [activeTab, client]);

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

      <div className={styles.clientDetailTabs} role="tablist" aria-label="Разделы клиента">
        {tabs.map((tab) => (
          <button
            key={tab.value}
            className={activeTab === tab.value ? styles.clientDetailTabActive : styles.clientDetailTab}
            type="button"
            aria-pressed={activeTab === tab.value}
            onClick={() => selectTab(tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className={styles.clientDetailPanel}>{panel}</div>
    </section>
  );
}
