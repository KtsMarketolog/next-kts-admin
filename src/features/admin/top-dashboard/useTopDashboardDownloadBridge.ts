'use client';

import { useEffect, useRef } from 'react';

import {
  getTopDashboardDownloadMimeType,
  readTopDashboardDownloadMessage,
} from '@/shared/lib/topDashboardDownloadBridge';

const DOWNLOAD_URL_LIFETIME_MS = 60_000;
const DOWNLOAD_THROTTLE_MS = 750;

export function useTopDashboardDownloadBridge(showStatus: (message: string) => void) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const showStatusRef = useRef(showStatus);
  const lastDownloadAtRef = useRef(0);

  useEffect(() => {
    showStatusRef.current = showStatus;
  }, [showStatus]);

  useEffect(() => {
    let activeObjectUrl: string | null = null;
    let cleanupTimer = 0;

    const releaseObjectUrl = () => {
      if (cleanupTimer) window.clearTimeout(cleanupTimer);
      cleanupTimer = 0;
      if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
      activeObjectUrl = null;
    };

    const handleMessage = (event: MessageEvent) => {
      const frameWindow = frameRef.current?.contentWindow;
      if (
        !frameWindow
        || event.source !== frameWindow
        || event.origin !== window.location.origin
      ) {
        return;
      }

      const message = readTopDashboardDownloadMessage(event.data);
      if (!message) return;
      if (!navigator.userActivation || !navigator.userActivation.isActive) {
        showStatusRef.current('Скачивание разрешено только после нажатия кнопки');
        return;
      }

      const now = Date.now();
      if (now - lastDownloadAtRef.current < DOWNLOAD_THROTTLE_MS) return;
      lastDownloadAtRef.current = now;

      try {
        releaseObjectUrl();
        const safeBlob = new Blob([message.blob], {
          type: getTopDashboardDownloadMimeType(message.name),
        });
        activeObjectUrl = URL.createObjectURL(safeBlob);

        const anchor = document.createElement('a');
        anchor.href = activeObjectUrl;
        anchor.download = message.name;
        anchor.rel = 'noopener';
        anchor.hidden = true;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        showStatusRef.current(`Скачивание «${message.name}» началось`);

        cleanupTimer = window.setTimeout(releaseObjectUrl, DOWNLOAD_URL_LIFETIME_MS);
      } catch {
        releaseObjectUrl();
        showStatusRef.current('Не удалось скачать файл');
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
      releaseObjectUrl();
    };
  }, []);

  return frameRef;
}
