'use client';

import { useEffect, useState, type RefObject } from 'react';
import styles from '@/app/admin/admin.module.scss';
import { requestProfitabilityFrameChange } from '@/features/admin/dashboard-usage/useProfitabilityAuditGuard';
import { DashboardDataDates } from './DashboardDataDates';
import { formatFileSize, formatDate, statusLabel } from './topDashboardPresentation';
import type { TopDashboardVersion } from './topDashboardManagementModel';
import type { TopDashboardManagement } from './useTopDashboardManagement';
import type { TopDashboardHtmlVersions } from './useTopDashboardHtmlVersions';
import type { TopDashboardDataVersions } from './useTopDashboardDataVersions';

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

export function TopDashboardManagementPreview({ management, html, data, selectedVersion, previewCardRef }: { management: TopDashboardManagement; html: TopDashboardHtmlVersions; data: TopDashboardDataVersions; selectedVersion: TopDashboardVersion | null; previewCardRef: RefObject<HTMLElement | null> }) {
  const { blockId, overview, loading, busyAction, previewFrameRef, previewRevision, setPreviewRevision, apiBasePath, showStatusRef, loadOverview } = management;
  const { activateVersion } = html;
  const { activeDataVersion, probeRuntimeUploadTargets } = data;
  const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false);

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
  }, [previewCardRef]);

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

  return (
      <section
        ref={previewCardRef}
        className={`${styles.topDashboardPreviewCard}${isPreviewFullscreen ? ` ${styles.topDashboardPreviewFullscreen}` : ''}`}
        aria-busy={loading}
      >
        <div className={styles.topDashboardPreviewHeader}>
          <div>
            <span className={styles.topDashboardEyebrow}>{selectedVersion?.status === 'active' ? 'Опубликованный отчёт' : 'Предпросмотр неопубликованной версии'}</span>
            <h2>{selectedVersion?.originalName ?? 'HTML ещё не загружен'}</h2>
            {selectedVersion ? (
              <div className={styles.topDashboardMeta}>
                {selectedVersion.status === 'active' ? <DashboardDataDates uploadedAt={activeDataVersion?.createdAt} dataAsOf={activeDataVersion?.dataAsOf} /> : <span>Предпросмотр не заменяет действующий отчёт</span>}
                <details><summary>Техническая информация HTML</summary>
                  <span>Версия #{selectedVersion.id} · {formatFileSize(selectedVersion.fileSize)}</span>{' · '}
                  <span>HTML загружен: {formatDate(selectedVersion.createdAt)}</span>{' · '}
                  <span>HTML опубликован: {formatDate(selectedVersion.firstPublishedAt)}</span>{' · '}
                  <span>SHA-256: {selectedVersion.sha256.slice(0, 12)}…</span>
                </details>
              </div>
            ) : null}
          </div>
          {selectedVersion ? (
            <div className={styles.topDashboardPreviewActions}>
              <span className={`${styles.topDashboardStatus} ${styles[`topDashboardStatus${selectedVersion.status}`]}`}>
                {statusLabel(selectedVersion.status)}
              </span>
              <button
                className={styles.secondary}
                type="button"
                disabled={busyAction !== null}
                onClick={() => {
                  if (!requestProfitabilityFrameChange(previewFrameRef.current)) return;
                  void loadOverview(selectedVersion.id);
                  setPreviewRevision((current) => current + 1);
                }}
              >
                Обновить просмотр
              </button>
              <button
                className={styles.secondary}
                type="button"
                aria-pressed={isPreviewFullscreen}
                onClick={() => void togglePreviewFullscreen()}
              >
                {isPreviewFullscreen ? 'Выйти из полноэкранного режима' : 'На весь экран'}
              </button>
              {selectedVersion.status !== 'active' ? (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => activateVersion(selectedVersion)}
                >
                  {busyAction === `activate:${selectedVersion.id}`
                    ? 'Публикуем…'
                    : selectedVersion.status === 'archived'
                      ? 'Откатить на эту версию'
                      : 'Опубликовать'}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        {loading && !overview ? (
          <div className={styles.topDashboardEmpty}>Загружаем HTML-страницу…</div>
        ) : selectedVersion ? (
          <div className={styles.topDashboardFrameShell}>
            <iframe
              ref={previewFrameRef}
              onLoad={probeRuntimeUploadTargets}
              key={`${blockId}:${selectedVersion.id}:${previewRevision}`}
              className={styles.topDashboardFrame}
              src={`${apiBasePath}/versions/${selectedVersion.id}/frame?revision=${previewRevision}`}
              title={`Предпросмотр ${selectedVersion.originalName}`}
              sandbox="allow-scripts allow-same-origin allow-popups"
              referrerPolicy="no-referrer"
              allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'; fullscreen *"
              allowFullScreen
            />
          </div>
        ) : (
          <div className={styles.topDashboardEmpty}>
            <strong>Нет загруженных версий</strong>
            <span>Выберите HTML ниже — после загрузки здесь сразу откроется безопасный предпросмотр.</span>
          </div>
        )}
      </section>
  );
}
