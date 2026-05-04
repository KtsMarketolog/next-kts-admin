'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

import styles from './LoginPanel.module.scss';

type LoginMode = 'client' | 'employee';

type LoginPanelProps = {
  defaultMode?: LoginMode;
  employeeRedirect?: string;
  onEmployeeAuthenticated?: (role: 'admin' | 'wholesale_admin') => Promise<void> | void;
};

function extractToken(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';

  try {
    const url = new URL(trimmed);
    const parts = url.pathname.split('/').filter(Boolean);
    return parts[0] === 'price' ? parts[1] ?? '' : parts.at(-1) ?? '';
  } catch {
    return trimmed.replace(/^\/?price\//, '').replace(/^\/+|\/+$/g, '');
  }
}

export function LoginPanel({ defaultMode = 'employee', employeeRedirect = '/admin', onEmployeeAuthenticated }: LoginPanelProps) {
  const router = useRouter();
  const [mode, setMode] = useState<LoginMode>(defaultMode);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [priceToken, setPriceToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const submitEmployee = async () => {
    setBusy(true);
    setStatus('');

    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, password }),
    });

    const data = await res.json().catch(() => ({}));
    setBusy(false);

    if (!res.ok) {
      setStatus(res.status === 429 ? 'Слишком много попыток. Попробуйте позже.' : 'Неверный логин или пароль');
      return;
    }

    if (data.role === 'manager') {
      router.push('/admin/wholesale/manager');
      return;
    }

    if (onEmployeeAuthenticated) {
      await onEmployeeAuthenticated(data.role === 'wholesale_admin' ? 'wholesale_admin' : 'admin');
      return;
    }

    router.push(employeeRedirect);
  };

  const submitClient = () => {
    const token = extractToken(priceToken);
    if (!token) {
      setStatus('Введите ссылку на прайс или токен');
      return;
    }

    router.push(`/price/${encodeURIComponent(token)}`);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === 'client') {
      submitClient();
      return;
    }

    await submitEmployee();
  };

  return (
    <div className={styles.authPage}>
      <section className={styles.panel}>
        <div className={styles.intro}>
          <Link className={styles.backLink} href="/">
            Вернуться на сайт
          </Link>
          <h1>KTS</h1>
          <p>
            Вход для клиентов и сотрудников. Клиент открывает индивидуальный прайс по ссылке или токену, сотрудник
            попадает в панель управления.
          </p>
        </div>

        <form className={styles.form} onSubmit={submit}>
          <div className={styles.tabs} role="tablist" aria-label="Тип входа">
            <button
              className={`${styles.tab} ${mode === 'client' ? styles.tabActive : ''}`}
              type="button"
              onClick={() => {
                setMode('client');
                setStatus('');
              }}
            >
              Клиент
            </button>
            <button
              className={`${styles.tab} ${mode === 'employee' ? styles.tabActive : ''}`}
              type="button"
              onClick={() => {
                setMode('employee');
                setStatus('');
              }}
            >
              Сотрудник
            </button>
          </div>

          {mode === 'client' ? (
            <label className={styles.field}>
              <span>Ссылка на прайс или токен</span>
              <input
                value={priceToken}
                onChange={(event) => setPriceToken(event.target.value)}
                placeholder="Например, https://t-kts.ru/price/..."
              />
            </label>
          ) : (
            <>
              <label className={styles.field}>
                <span>Email или логин</span>
                <input value={login} onChange={(event) => setLogin(event.target.value)} placeholder="Логин сотрудника" />
              </label>
              <label className={styles.field}>
                <span>Пароль</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Пароль"
                />
              </label>
            </>
          )}

          <button className={styles.submit} disabled={busy}>
            {busy ? 'Проверка...' : 'Войти'}
          </button>
          {status ? <p className={styles.status}>{status}</p> : null}
        </form>
      </section>
    </div>
  );
}
