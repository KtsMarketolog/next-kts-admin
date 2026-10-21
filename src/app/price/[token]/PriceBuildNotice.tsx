'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

import styles from './PriceBuildNotice.module.scss';

export function PriceBuildNotice() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <main className={styles.page}>
      <section className={styles.notice} aria-labelledby="price-build-title" aria-busy={isPending}>
        <p className={styles.eyebrow}>Индивидуальный прайс</p>
        <h1 id="price-build-title">Прайс готовится</h1>
        <p>Сейчас сервер временно занят. Данные прайса сохранены. Повторите открытие через несколько секунд.</p>
        <button type="button" disabled={isPending} onClick={() => startTransition(() => router.refresh())}>
          {isPending ? 'Открываем прайс…' : 'Повторить'}
        </button>
        <p className={styles.status} role="status">{isPending ? 'Проверяем готовность прайса…' : ''}</p>
      </section>
    </main>
  );
}
