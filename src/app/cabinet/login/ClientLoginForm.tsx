'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

import styles from './ClientLoginForm.module.scss';

export function ClientLoginForm() {
  const router = useRouter();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setStatus('');

    const response = await fetch('/api/client/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, password }),
    });
    setBusy(false);

    if (!response.ok) {
      setStatus(response.status === 429 ? 'Слишком много попыток. Попробуйте позже.' : 'Неверный логин или пароль');
      return;
    }

    router.push('/cabinet');
    router.refresh();
  };

  return (
    <main className={styles.authPage}>
      <section className={styles.authPanel}>
        <div className={styles.intro}>
          <Link className={styles.backLink} href="/">
            Вернуться на сайт
          </Link>
          <h1>Личный кабинет клиента</h1>
          <p>Вход по email и паролю, который выдал менеджер.</p>
        </div>

        <form className={styles.form} onSubmit={submit}>
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
          <button className={styles.submit} disabled={busy}>
            {busy ? 'Проверка...' : 'Войти'}
          </button>
          {status ? <p className={styles.status}>{status}</p> : null}
        </form>
      </section>
    </main>
  );
}
