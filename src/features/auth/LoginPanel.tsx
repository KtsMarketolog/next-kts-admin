'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

import { EMPLOYEE_HOME_PATH } from '@/shared/lib/adminNavigation';

import styles from './LoginPanel.module.scss';

type LoginMode = 'client' | 'employee';

type LoginPanelProps = {
  defaultMode?: LoginMode;
  clientRedirect?: string;
  employeeRedirect?: string;
  onEmployeeAuthenticated?: (role: 'admin' | 'wholesale_admin' | 'top') => Promise<void> | void;
};

export function LoginPanel({
  defaultMode = 'employee',
  clientRedirect = '/cabinet',
  employeeRedirect = EMPLOYEE_HOME_PATH,
  onEmployeeAuthenticated,
}: LoginPanelProps) {
  const router = useRouter();
  const [mode, setMode] = useState<LoginMode>(defaultMode);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [twoFactorChallengeId, setTwoFactorChallengeId] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [twoFactorEmail, setTwoFactorEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const submitEmployee = async () => {
    setBusy(true);
    setStatus('');

    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(twoFactorChallengeId ? { twoFactorChallengeId, twoFactorCode } : { login, password }),
    });

    const data = await res.json().catch(() => ({}));
    setBusy(false);

    if (data.twoFactorRequired && data.challengeId) {
      setTwoFactorChallengeId(data.challengeId);
      setTwoFactorEmail(typeof data.email === 'string' ? data.email : '');
      setPassword('');
      setStatus('');
      return;
    }

    if (!res.ok) {
      setStatus(
        res.status === 429
          ? 'Слишком много попыток. Попробуйте позже.'
          : twoFactorChallengeId
            ? 'Неверный код подтверждения'
            : 'Неверный логин или пароль',
      );
      return;
    }

    if (data.role === 'manager' || data.role === 'support_manager') {
      router.push(employeeRedirect);
      return;
    }

    if (onEmployeeAuthenticated) {
      if (data.role !== 'admin' && data.role !== 'wholesale_admin' && data.role !== 'top') {
        setStatus('Не удалось определить права сотрудника');
        return;
      }
      await onEmployeeAuthenticated(data.role);
      return;
    }

    router.push(employeeRedirect);
  };

  const submitClient = async () => {
    setBusy(true);
    setStatus('');

    const res = await fetch('/api/client/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(twoFactorChallengeId ? { twoFactorChallengeId, twoFactorCode } : { login, password }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);

    if (data.twoFactorRequired && data.challengeId) {
      setTwoFactorChallengeId(data.challengeId);
      setTwoFactorEmail(typeof data.email === 'string' ? data.email : '');
      setPassword('');
      setStatus('');
      return;
    }

    if (!res.ok) {
      setStatus(
        res.status === 429
          ? 'Слишком много попыток. Попробуйте позже.'
          : twoFactorChallengeId
            ? 'Неверный код подтверждения'
            : 'Неверный логин или пароль',
      );
      return;
    }

    router.push(clientRedirect);
    router.refresh();
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
            Единый вход для клиентов и сотрудников. Клиент попадает в личный кабинет, сотрудник - в панель управления.
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
                setTwoFactorChallengeId('');
                setTwoFactorCode('');
                setTwoFactorEmail('');
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
                setTwoFactorChallengeId('');
                setTwoFactorCode('');
                setTwoFactorEmail('');
              }}
            >
              Сотрудник
            </button>
          </div>

          {twoFactorChallengeId ? (
            <>
              <label className={styles.field}>
                <span>Код подтверждения</span>
                <input
                  value={twoFactorCode}
                  onChange={(event) => setTwoFactorCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="6 цифр"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                />
              </label>
              {twoFactorEmail ? <p className={styles.status}>Код отправлен на {twoFactorEmail}</p> : null}
              <button
                type="button"
                className={styles.tab}
                onClick={() => {
                  setTwoFactorChallengeId('');
                  setTwoFactorCode('');
                  setTwoFactorEmail('');
                  setStatus('');
                }}
              >
                Ввести пароль заново
              </button>
            </>
          ) : mode === 'client' ? (
            <>
              <label className={styles.field}>
                <span>Email</span>
                <input
                  value={login}
                  onChange={(event) => setLogin(event.target.value)}
                  placeholder="client@example.ru"
                  autoComplete="username"
                />
              </label>
              <label className={styles.field}>
                <span>Пароль</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Пароль"
                  autoComplete="current-password"
                />
              </label>
            </>
          ) : (
            <>
              <label className={styles.field}>
                <span>Email или логин</span>
                <input
                  value={login}
                  onChange={(event) => setLogin(event.target.value)}
                  placeholder="Логин сотрудника"
                  autoComplete="username"
                />
              </label>
              <label className={styles.field}>
                <span>Пароль</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Пароль"
                  autoComplete="current-password"
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
