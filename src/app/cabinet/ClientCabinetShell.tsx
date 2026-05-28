'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

import { ClientChatPanel } from '@/features/client-chat/ClientChatPanel';
import type { ClientPortalProfile } from '@/shared/lib/db';
import styles from './Cabinet.module.scss';

type Tab = 'prices' | 'documents' | 'chat' | 'data';

const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'prices', label: 'Прайсы' },
  { value: 'documents', label: 'Документы' },
  { value: 'chat', label: 'Чат' },
  { value: 'data', label: 'Данные клиента' },
];

type ClientCabinetShellProps = {
  profile: ClientPortalProfile;
};

export function ClientCabinetShell({ profile }: ClientCabinetShellProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<Tab>('prices');
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [repeatPassword, setRepeatPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [passwordStatus, setPasswordStatus] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');

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

        <nav className={styles.tabs} aria-label="Разделы личного кабинета">
          {TABS.map((tab) => (
            <button
              key={tab.value}
              className={`${styles.tab} ${activeTab === tab.value ? styles.tabActive : ''}`}
              type="button"
              aria-pressed={activeTab === tab.value}
              onClick={() => setActiveTab(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {activeTab === 'prices' && (
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2>Прайсы</h2>
              <p>Здесь будут отображаться индивидуальные прайсы, назначенные менеджером.</p>
            </div>
            <div className={styles.placeholderGrid}>
              <article className={styles.placeholderCard}>
                <strong>Актуальные прайсы</strong>
                <span>Появятся после привязки прайса к компании клиента.</span>
              </article>
              <article className={styles.placeholderCard}>
                <strong>История заявок</strong>
                <span>Будет собираться из отправленных заявок по прайсам.</span>
              </article>
              <article className={styles.placeholderCard}>
                <strong>Архив</strong>
                <span>Старые прайсы можно будет оставить для истории.</span>
              </article>
            </div>
          </section>
        )}

        {activeTab === 'documents' && (
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2>Документы</h2>
              <p>Раздел подготовлен под файлы, которые менеджер прикрепит для клиента.</p>
            </div>
            <article className={styles.placeholderCard}>
              <strong>Документов пока нет</strong>
              <span>Загрузка документов будет добавлена следующим этапом.</span>
            </article>
          </section>
        )}

        {activeTab === 'chat' && (
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2>Чат</h2>
              <p>Переписка с менеджером по вашей компании.</p>
            </div>
            <ClientChatPanel endpoint="/api/client/chat" currentAuthorType="client" />
          </section>
        )}

        {activeTab === 'data' && (
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2>Данные клиента</h2>
              <p>Контакты и доступ к личному кабинету.</p>
            </div>
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
                    <strong>{profile.company.managerName || 'Не назначен'}</strong>
                  </div>
                  <div>
                    <span>Сопровождение</span>
                    <strong>{profile.company.supportManagerName || 'Не назначено'}</strong>
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
          </section>
        )}
      </div>
    </main>
  );
}
