'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import styles from '@/app/admin/admin.module.scss';

type TopDashboardPublishedOverview = {
  block: {
    id: number;
    title: string;
    createdAt: string;
  };
  activeVersionId: number;
  updatedAt: string;
};

type TopDashboardViewerProps = {
  blockId: number;
  showStatus: (message: string) => void;
};

type WebkitFullscreenDocument = Document & {
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenElement?: Element | null;
};

type WebkitFullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

function currentFullscreenElement() {
  const fullscreenDocument = document as WebkitFullscreenDocument;
  return document.fullscreenElement ?? fullscreenDocument.webkitFullscreenElement ?? null;
}

async function requestElementFullscreen(element: HTMLElement) {
  if (element.requestFullscreen) {
    await element.requestFullscreen();
    return;
  }

  const webkitRequestFullscreen = (element as WebkitFullscreenElement).webkitRequestFullscreen;
  if (webkitRequestFullscreen) {
    await webkitRequestFullscreen.call(element);
    return;
  }

  throw new Error('Fullscreen API is unavailable');
}

async function exitDocumentFullscreen() {
  if (document.exitFullscreen) {
    await document.exitFullscreen();
    return;
  }

  const webkitExitFullscreen = (document as WebkitFullscreenDocument).webkitExitFullscreen;
  if (webkitExitFullscreen) {
    await webkitExitFullscreen.call(document);
    return;
  }

  throw new Error('Fullscreen API is unavailable');
}

function formatDate(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

async function readError(response: Response, fallback: string) {
  const data = await response.json().catch(() => ({}));
  return typeof data.error === 'string' ? data.error : fallback;
}

export function TopDashboardViewer({ blockId, showStatus }: TopDashboardViewerProps) {
  const router = useRouter();
  const [overview, setOverview] = useState<TopDashboardPublishedOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false);
  const previewCardRef = useRef<HTMLElement>(null);
  const showStatusRef = useRef(showStatus);
  const requestIdRef = useRef(0);
  const apiBasePath = `/api/admin/top-dashboard/blocks/${blockId}`;

  useEffect(() => {
    showStatusRef.current = showStatus;
  }, [showStatus]);

  const loadOverview = useCallback(async (notifyOnError = true) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);

    try {
      const response = await fetch(apiBasePath, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const message = await readError(response, 'Не удалось открыть отчёт');
        if (requestId !== requestIdRef.current) return;
        setOverview(null);
        setLoadError(message);
        if (notifyOnError) showStatusRef.current(message);
        return;
      }

      const data = (await response.json()) as TopDashboardPublishedOverview;
      if (requestId !== requestIdRef.current) return;
      setOverview(data);
      setLoadError(null);
    } catch {
      if (requestId !== requestIdRef.current) return;
      const message = 'Не удалось открыть отчёт';
      setOverview(null);
      setLoadError(message);
      if (notifyOnError) showStatusRef.current(message);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [apiBasePath]);

  useEffect(() => {
    void loadOverview();
    return () => {
      requestIdRef.current += 1;
    };
  }, [loadOverview]);

  useEffect(() => {
    const refreshVisibleOverview = () => {
      if (document.visibilityState === 'visible') void loadOverview(false);
    };

    window.addEventListener('focus', refreshVisibleOverview);
    document.addEventListener('visibilitychange', refreshVisibleOverview);
    return () => {
      window.removeEventListener('focus', refreshVisibleOverview);
      document.removeEventListener('visibilitychange', refreshVisibleOverview);
    };
  }, [loadOverview]);

  useEffect(() => {
    const previewCard = previewCardRef.current;
    const syncFullscreenState = () => {
      setIsPreviewFullscreen(currentFullscreenElement() === previewCardRef.current);
    };

    syncFullscreenState();
    document.addEventListener('fullscreenchange', syncFullscreenState);
    document.addEventListener('webkitfullscreenchange', syncFullscreenState);
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreenState);
      document.removeEventListener('webkitfullscreenchange', syncFullscreenState);
      if (previewCard && currentFullscreenElement() === previewCard) {
        void exitDocumentFullscreen().catch(() => undefined);
      }
    };
  }, []);

  const togglePreviewFullscreen = async () => {
    const previewCard = previewCardRef.current;
    if (!previewCard) return;

    try {
      if (currentFullscreenElement() === previewCard) {
        await exitDocumentFullscreen();
      } else {
        await requestElementFullscreen(previewCard);
      }
    } catch {
      showStatusRef.current('Браузер не разрешил открыть полноэкранный режим');
    }
  };

  if (loadError && !overview) {
    return (
      <section className={`${styles.section} ${styles.topDashboardLoadError}`} role="alert">
        <span className={styles.topDashboardEyebrow}>Готовый отчёт</span>
        <h2>Отчёт не открылся</h2>
        <p>{loadError}</p>
        <button type="button" onClick={() => router.push('/admin/top', { scroll: false })}>
          Вернуться к списку отчётов
        </button>
      </section>
    );
  }

  return (
    <div className={styles.topDashboardLayout}>
      <section
        ref={previewCardRef}
        className={`${styles.topDashboardPreviewCard}${isPreviewFullscreen ? ` ${styles.topDashboardPreviewFullscreen}` : ''}`}
        aria-busy={loading}
      >
        <div className={styles.topDashboardPreviewHeader}>
          <div>
            <span className={styles.topDashboardEyebrow}>Опубликованный отчёт</span>
            <h2>{overview?.block.title ?? 'Загружаем отчёт…'}</h2>
            {overview ? (
              <div className={styles.topDashboardMeta}>
                <span>Данные загружаются автоматически</span>
                <span>Обновлён: {formatDate(overview.updatedAt)}</span>
              </div>
            ) : null}
          </div>
          {overview ? (
            <div className={styles.topDashboardPreviewActions}>
              <button
                className={styles.secondary}
                type="button"
                onClick={() => {
                  void loadOverview();
                  setPreviewRevision((current) => current + 1);
                }}
              >
                Обновить
              </button>
              <button
                className={styles.secondary}
                type="button"
                aria-pressed={isPreviewFullscreen}
                onClick={() => void togglePreviewFullscreen()}
              >
                {isPreviewFullscreen ? 'Выйти из полноэкранного режима' : 'На весь экран'}
              </button>
            </div>
          ) : null}
        </div>

        {loading && !overview ? (
          <div className={styles.topDashboardEmpty}>Загружаем готовый отчёт…</div>
        ) : overview ? (
          <div className={styles.topDashboardFrameShell}>
            <iframe
              key={`${blockId}:${overview.activeVersionId}:${previewRevision}`}
              className={styles.topDashboardFrame}
              src={`${apiBasePath}/versions/${overview.activeVersionId}/frame?revision=${previewRevision}`}
              title={`Отчёт ${overview.block.title}`}
              sandbox="allow-scripts allow-same-origin allow-popups allow-downloads"
              referrerPolicy="no-referrer"
              allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'; fullscreen *"
              allowFullScreen
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}
