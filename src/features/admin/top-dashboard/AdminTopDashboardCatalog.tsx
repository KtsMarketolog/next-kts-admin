'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import styles from '@/app/admin/admin.module.scss';

type TopDashboardBlock = {
  id: number;
  title: string;
  activeVersionId: number | null;
  activeOriginalName: string | null;
  versionCount: number;
  updatedAt: string | null;
  createdAt: string;
};

type AdminTopDashboardCatalogProps = {
  showStatus: (message: string) => void;
};

function formatDate(value: string | null) {
  if (!value) return 'Ещё не обновлялась';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Ещё не обновлялась';
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

async function readError(response: Response, fallback: string) {
  const data = await response.json().catch(() => ({}));
  return typeof data.error === 'string' ? data.error : fallback;
}

function pluralize(count: number, one: string, few: string, many: string) {
  const normalized = Math.abs(count) % 100;
  const lastDigit = normalized % 10;
  if (normalized >= 11 && normalized <= 19) return many;
  if (lastDigit === 1) return one;
  if (lastDigit >= 2 && lastDigit <= 4) return few;
  return many;
}

function blockDescription(block: TopDashboardBlock) {
  if (block.activeOriginalName) return block.activeOriginalName;
  if (block.versionCount > 0) return 'Есть неопубликованные версии';
  return 'HTML ещё не загружен';
}

export function AdminTopDashboardCatalog({ showStatus }: AdminTopDashboardCatalogProps) {
  const router = useRouter();
  const [blocks, setBlocks] = useState<TopDashboardBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [title, setTitle] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);
  const showStatusRef = useRef(showStatus);

  useEffect(() => {
    showStatusRef.current = showStatus;
  }, [showStatus]);

  const loadBlocks = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/admin/top-dashboard/blocks', {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const message = await readError(response, 'Не удалось загрузить HTML-страницы');
        setLoadError(message);
        showStatusRef.current(message);
        return;
      }

      const data = await response.json().catch(() => ({}));
      setBlocks(Array.isArray(data.blocks) ? data.blocks : []);
      setLoadError(null);
    } catch {
      const message = 'Не удалось загрузить HTML-страницы';
      setLoadError(message);
      showStatusRef.current(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBlocks();
  }, [loadBlocks]);

  useEffect(() => {
    if (creating) titleInputRef.current?.focus();
  }, [creating]);

  const createBlock = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      showStatusRef.current('Введите название блока');
      titleInputRef.current?.focus();
      return;
    }

    setCreateBusy(true);
    try {
      const response = await fetch('/api/admin/top-dashboard/blocks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ title: normalizedTitle }),
      });
      if (!response.ok) {
        showStatusRef.current(await readError(response, 'Не удалось создать блок'));
        return;
      }

      const data = await response.json().catch(() => ({}));
      const blockId = Number(data.block?.id);
      if (!Number.isSafeInteger(blockId) || blockId <= 0) {
        showStatusRef.current('Блок создан, но не удалось открыть его автоматически');
        await loadBlocks();
        return;
      }

      setTitle('');
      setCreating(false);
      showStatusRef.current('Новый блок создан');
      router.push(`/admin/top/${blockId}`, { scroll: false });
    } catch {
      showStatusRef.current('Не удалось создать блок');
    } finally {
      setCreateBusy(false);
    }
  };

  return (
    <section className={`${styles.section} ${styles.topDashboardCatalogSection}`}>
      <div className={styles.sectionHeader}>
        <div>
          <p>HTML-страницы</p>
          <h2>HTML-страницы и отчёты</h2>
        </div>
        <span className={styles.headingMeta}>
          {loadError && blocks.length === 0
            ? 'Список недоступен'
            : `${blocks.length} ${pluralize(blocks.length, 'блок', 'блока', 'блоков')}`}
        </span>
      </div>

      <p className={styles.topDashboardCatalogIntro}>
        Каждый блок хранит собственную HTML-страницу и отдельную историю до 50 версий и 100 МБ. Количество блоков не ограничено.
      </p>

      <div className={styles.topDashboardCatalogGrid} aria-busy={loading}>
        {blocks.map((block) => (
          <button
            className={styles.topDashboardCatalogCard}
            type="button"
            key={block.id}
            onClick={() => router.push(`/admin/top/${block.id}`, { scroll: false })}
          >
            <span className={styles.topDashboardCatalogEyebrow}>HTML-дашборд</span>
            <strong>{block.title}</strong>
            <span className={styles.topDashboardCatalogDescription}>
              {blockDescription(block)}
            </span>
            <span className={styles.topDashboardCatalogMeta}>
              {block.versionCount} {pluralize(block.versionCount, 'версия', 'версии', 'версий')} · {formatDate(block.updatedAt ?? block.createdAt)}
            </span>
            <span className={styles.topDashboardCatalogOpen}>Открыть <span aria-hidden>→</span></span>
          </button>
        ))}

        {loadError && blocks.length === 0 ? (
          <div className={styles.topDashboardCatalogError} role="alert">
            <strong>Не удалось открыть список блоков</strong>
            <span>{loadError}</span>
            <button type="button" disabled={loading} onClick={() => void loadBlocks()}>
              {loading ? 'Проверяем…' : 'Повторить'}
            </button>
          </div>
        ) : creating ? (
          <form className={styles.topDashboardCatalogCreate} onSubmit={createBlock}>
            <label htmlFor="top-dashboard-block-title">Название нового блока</label>
            <input
              ref={titleInputRef}
              id="top-dashboard-block-title"
              type="text"
              value={title}
              maxLength={120}
              disabled={createBusy}
              placeholder="Например, Аналитика продаж"
              onChange={(event) => setTitle(event.target.value)}
            />
            <div className={styles.topDashboardCatalogCreateActions}>
              <button type="submit" disabled={createBusy || !title.trim()}>
                {createBusy ? 'Создаём…' : 'Создать'}
              </button>
              <button
                className={styles.secondary}
                type="button"
                disabled={createBusy}
                onClick={() => {
                  setTitle('');
                  setCreating(false);
                }}
              >
                Отмена
              </button>
            </div>
          </form>
        ) : (
          <button
            className={styles.topDashboardCatalogAdd}
            type="button"
            onClick={() => setCreating(true)}
          >
            <span className={styles.topDashboardCatalogPlus} aria-hidden>+</span>
            <strong>Создать новый блок</strong>
            <span>Добавить отдельную HTML-страницу</span>
          </button>
        )}
      </div>

      {loading && blocks.length === 0 ? (
        <p className={styles.topDashboardCatalogLoading}>Загружаем блоки…</p>
      ) : null}
    </section>
  );
}
