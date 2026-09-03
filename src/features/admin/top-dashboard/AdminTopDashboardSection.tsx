'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import styles from '@/app/admin/admin.module.scss';
import {
  TOP_DASHBOARD_DATA_MAX_BYTES,
  TOP_DASHBOARD_DATA_MAX_MEGABYTES,
  TOP_DASHBOARD_DATA_MAX_UNCOMPRESSED_LABEL,
} from '@/shared/lib/topDashboardLimits';

import { useTopDashboardDownloadBridge } from './useTopDashboardDownloadBridge';

type TopDashboardVersionStatus = 'active' | 'draft' | 'archived';

type TopDashboardVersion = {
  id: number;
  originalName: string;
  fileSize: number;
  sha256: string;
  status: TopDashboardVersionStatus;
  uploadedByName: string;
  firstPublishedByName: string;
  firstPublishedAt: string | null;
  createdAt: string;
};

type TopDashboardDataVersionStatus = 'active' | 'previous' | 'archived';
type TopDashboardSnapshotFormat = 'kts-bundle-v1' | 'purchases-v1' | 'multi-file-v1';

type TopDashboardDataVersion = {
  id: number;
  originalName: string;
  fileSize: number;
  uncompressedSize: number;
  sha256: string;
  snapshotFormat: TopDashboardSnapshotFormat;
  boundHtmlVersionId: number | null;
  status: TopDashboardDataVersionStatus;
  uploadedByName: string;
  createdAt: string;
};

type TopDashboardDataOverview = {
  activeVersionId: number | null;
  previousVersionId: number | null;
  updatedAt: string | null;
  versions: TopDashboardDataVersion[];
};

type TopDashboardOverview = {
  block: {
    id: number;
    title: string;
    createdAt: string;
  };
  activeVersionId: number | null;
  previousVersionId: number | null;
  updatedAt: string | null;
  versions: TopDashboardVersion[];
  data: TopDashboardDataOverview;
};

type AdminTopDashboardSectionProps = {
  blockId: number;
  showStatus: (message: string) => void;
};

const MAX_HTML_BYTES = 5 * 1024 * 1024;

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

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(bytes / 1024)} КБ`;
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(bytes / (1024 * 1024))} МБ`;
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

function statusLabel(status: TopDashboardVersionStatus) {
  if (status === 'active') return 'Активная';
  if (status === 'archived') return 'Архивная';
  return 'Черновик';
}

function dataStatusLabel(status: TopDashboardDataVersionStatus) {
  if (status === 'active') return 'Активные данные';
  if (status === 'previous') return 'Предыдущая';
  return 'Архивные';
}

function snapshotFormatLabel(format: TopDashboardSnapshotFormat) {
  if (format === 'purchases-v1') return 'Снимок закупок';
  if (format === 'multi-file-v1') return 'Универсальный набор файлов';
  return 'Снимок КТС';
}

function storedSizeLabel(version: TopDashboardDataVersion) {
  return version.snapshotFormat === 'multi-file-v1'
    ? `Данные в наборе: ${formatFileSize(version.uncompressedSize)}`
    : `После распаковки: ${formatFileSize(version.uncompressedSize)}`;
}

function versionCountLabel(count: number) {
  const normalized = Math.abs(count) % 100;
  const lastDigit = normalized % 10;
  const word = normalized >= 11 && normalized <= 19
    ? 'версий'
    : lastDigit === 1
      ? 'версия'
      : lastDigit >= 2 && lastDigit <= 4
        ? 'версии'
        : 'версий';
  return `${count} ${word}`;
}

async function readError(response: Response, fallback: string) {
  const data = await response.json().catch(() => ({}));
  return typeof data.error === 'string' ? data.error : fallback;
}

export function AdminTopDashboardSection({ blockId, showStatus }: AdminTopDashboardSectionProps) {
  const router = useRouter();
  const previewFrameRef = useTopDashboardDownloadBridge(showStatus);
  const [overview, setOverview] = useState<TopDashboardOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedDataFile, setSelectedDataFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [isPreviewFullscreen, setIsPreviewFullscreen] = useState(false);
  const [isEditingBlockTitle, setIsEditingBlockTitle] = useState(false);
  const [blockTitleDraft, setBlockTitleDraft] = useState('');
  const [blockMutationError, setBlockMutationError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dataFileInputRef = useRef<HTMLInputElement>(null);
  const blockTitleInputRef = useRef<HTMLInputElement>(null);
  const previewCardRef = useRef<HTMLElement>(null);
  const showStatusRef = useRef(showStatus);
  const overviewRequestIdRef = useRef(0);
  const apiBasePath = `/api/admin/top-dashboard/blocks/${blockId}`;

  useEffect(() => {
    showStatusRef.current = showStatus;
  }, [showStatus]);

  useEffect(() => {
    if (isEditingBlockTitle) {
      blockTitleInputRef.current?.focus();
      blockTitleInputRef.current?.select();
    }
  }, [isEditingBlockTitle]);

  const loadOverview = useCallback(async (preferredVersionId?: number | null) => {
    const requestId = overviewRequestIdRef.current + 1;
    overviewRequestIdRef.current = requestId;
    setLoading(true);
    try {
      const response = await fetch(apiBasePath, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const message = await readError(response, 'Не удалось загрузить версии HTML-страницы');
        if (requestId !== overviewRequestIdRef.current) return null;
        setLoadError(message);
        showStatusRef.current(message);
        return null;
      }

      const data = (await response.json()) as TopDashboardOverview;
      if (requestId !== overviewRequestIdRef.current) return null;
      const versions = Array.isArray(data.versions) ? data.versions : [];
      const normalized: TopDashboardOverview = {
        block: data.block,
        activeVersionId: Number.isInteger(data.activeVersionId) ? data.activeVersionId : null,
        previousVersionId: Number.isInteger(data.previousVersionId) ? data.previousVersionId : null,
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
        versions,
        data: {
          activeVersionId: Number.isInteger(data.data?.activeVersionId) ? data.data.activeVersionId : null,
          previousVersionId: Number.isInteger(data.data?.previousVersionId) ? data.data.previousVersionId : null,
          updatedAt: typeof data.data?.updatedAt === 'string' ? data.data.updatedAt : null,
          versions: Array.isArray(data.data?.versions) ? data.data.versions : [],
        },
      };
      setLoadError(null);
      setOverview(normalized);
      setSelectedVersionId((current) => {
        const requested = preferredVersionId ?? current;
        if (requested && versions.some((version) => version.id === requested)) return requested;
        if (normalized.activeVersionId && versions.some((version) => version.id === normalized.activeVersionId)) {
          return normalized.activeVersionId;
        }
        return versions[0]?.id ?? null;
      });
      return normalized;
    } catch {
      if (requestId !== overviewRequestIdRef.current) return null;
      const message = 'Не удалось загрузить версии HTML-страницы';
      setLoadError(message);
      showStatusRef.current(message);
      return null;
    } finally {
      if (requestId === overviewRequestIdRef.current) setLoading(false);
    }
  }, [apiBasePath]);

  useEffect(() => {
    void loadOverview();
    return () => {
      overviewRequestIdRef.current += 1;
    };
  }, [loadOverview]);

  useEffect(() => {
    const refreshVisibleOverview = () => {
      if (document.visibilityState === 'visible') void loadOverview();
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

  const activeVersion = useMemo(
    () => overview?.versions.find((version) => version.id === overview.activeVersionId) ?? null,
    [overview],
  );
  const selectedVersion = useMemo(
    () => overview?.versions.find((version) => version.id === selectedVersionId) ?? null,
    [overview, selectedVersionId],
  );
  const activeDataVersion = useMemo(
    () => overview?.data.versions.find((version) => version.id === overview.data.activeVersionId) ?? null,
    [overview],
  );
  const hasActiveHtml = Boolean(overview?.activeVersionId);

  const chooseFile = (file: File | null) => {
    if (!file) {
      setSelectedFile(null);
      return;
    }
    if (!/\.html?$/i.test(file.name)) {
      setSelectedFile(null);
      showStatusRef.current('Выберите файл с расширением .html или .htm');
      return;
    }
    if (file.size <= 0 || file.size > MAX_HTML_BYTES) {
      setSelectedFile(null);
      showStatusRef.current('HTML-файл должен быть непустым и не больше 5 МБ');
      return;
    }
    setSelectedFile(file);
  };

  const chooseDataFile = (file: File | null) => {
    if (!file) {
      setSelectedDataFile(null);
      return;
    }
    if (!/\.json(?:\.gz)?$/i.test(file.name)) {
      setSelectedDataFile(null);
      showStatusRef.current('Выберите файл с расширением .json или .json.gz');
      return;
    }
    if (file.size <= 0 || file.size > TOP_DASHBOARD_DATA_MAX_BYTES) {
      setSelectedDataFile(null);
      showStatusRef.current(
        `Файл данных должен быть непустым и не больше ${TOP_DASHBOARD_DATA_MAX_MEGABYTES} МБ`,
      );
      return;
    }
    setSelectedDataFile(file);
  };

  const uploadVersion = async () => {
    if (!selectedFile) {
      showStatusRef.current('Сначала выберите HTML-файл');
      return;
    }

    setBusyAction('upload');
    try {
      const body = new FormData();
      body.set('file', selectedFile);
      const response = await fetch(`${apiBasePath}/versions`, {
        method: 'POST',
        body,
        credentials: 'same-origin',
      });
      if (!response.ok) {
        showStatusRef.current(await readError(response, 'Не удалось загрузить HTML-файл'));
        return;
      }

      const data = await response.json().catch(() => ({}));
      const versionId = Number(data.version?.id);
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await loadOverview(Number.isInteger(versionId) ? versionId : null);
      setPreviewRevision((current) => current + 1);
      showStatusRef.current('Новая версия загружена как черновик');
    } catch {
      showStatusRef.current('Не удалось загрузить HTML-файл');
    } finally {
      setBusyAction(null);
    }
  };

  const uploadDataVersion = async () => {
    if (!overview || !selectedDataFile) {
      showStatusRef.current('Сначала выберите файл данных');
      return;
    }
    if (!overview.activeVersionId) {
      showStatusRef.current('Сначала опубликуйте HTML-страницу');
      return;
    }

    setBusyAction('upload-data');
    try {
      const response = await fetch(`${apiBasePath}/data`, {
        method: 'PUT',
        headers: {
          'X-KTS-TOP-Data-Upload': '1',
          'X-KTS-Top-Data-Protocol': 'stream-v1',
          'X-KTS-Top-Data-Name': encodeURIComponent(selectedDataFile.name),
          'X-KTS-Top-Data-Expected-Version': overview.data.activeVersionId === null
            ? 'none'
            : String(overview.data.activeVersionId),
        },
        body: selectedDataFile,
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const message = await readError(response, 'Не удалось сохранить данные дашборда');
        if (response.status === 409) await loadOverview(selectedVersionId);
        showStatusRef.current(message);
        return;
      }

      setSelectedDataFile(null);
      if (dataFileInputRef.current) dataFileInputRef.current.value = '';
      await loadOverview(selectedVersionId);
      setPreviewRevision((current) => current + 1);
      showStatusRef.current(activeDataVersion ? 'Данные обновлены для всех пользователей' : 'Данные сохранены для всех пользователей');
    } catch {
      showStatusRef.current('Не удалось сохранить данные дашборда');
    } finally {
      setBusyAction(null);
    }
  };

  const activateDataVersion = async (version: TopDashboardDataVersion) => {
    if (!overview || version.status === 'active') return;
    if (!overview.activeVersionId) {
      showStatusRef.current('Сначала опубликуйте HTML-страницу');
      return;
    }
    if (!window.confirm(`Вернуть данные из файла «${version.originalName}»?`)) return;

    setBusyAction(`activate-data:${version.id}`);
    try {
      const response = await fetch(`${apiBasePath}/data/active`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          versionId: version.id,
          expectedActiveVersionId: overview.data.activeVersionId,
        }),
      });
      if (!response.ok) {
        const message = await readError(response, 'Не удалось вернуть выбранные данные');
        if (response.status === 409) await loadOverview(selectedVersionId);
        showStatusRef.current(message);
        return;
      }

      await loadOverview(selectedVersionId);
      setPreviewRevision((current) => current + 1);
      showStatusRef.current('Выбранная версия данных восстановлена для всех пользователей');
    } catch {
      showStatusRef.current('Не удалось вернуть выбранные данные');
    } finally {
      setBusyAction(null);
    }
  };

  const activateVersion = async (version: TopDashboardVersion) => {
    if (!overview || version.status === 'active') return;
    if (
      version.status === 'archived'
      && !window.confirm(`Откатить опубликованную HTML-страницу на версию «${version.originalName}»?`)
    ) {
      return;
    }

    setBusyAction(`activate:${version.id}`);
    try {
      const response = await fetch(`${apiBasePath}/active`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          versionId: version.id,
          expectedActiveVersionId: overview.activeVersionId,
        }),
      });
      if (!response.ok) {
        const message = await readError(response, 'Не удалось опубликовать версию HTML');
        if (response.status === 409) await loadOverview(version.id);
        showStatusRef.current(message);
        return;
      }

      const data = await response.json().catch(() => ({}));
      await loadOverview(version.id);
      setPreviewRevision((current) => current + 1);
      showStatusRef.current(data.state?.change === 'rolled_back' ? 'Выполнен откат на выбранную версию' : 'Версия опубликована');
    } catch {
      showStatusRef.current('Не удалось опубликовать версию HTML');
    } finally {
      setBusyAction(null);
    }
  };

  const deleteVersion = async (version: TopDashboardVersion) => {
    if (!overview || version.status === 'active') return;
    if (
      !window.confirm(
        `Удалить файл «${version.originalName}», версия #${version.id}?\n\nЭто действие необратимо: восстановить удалённую версию будет нельзя.`,
      )
    ) {
      return;
    }

    const remainingVersions = overview.versions.filter((item) => item.id !== version.id);
    const preferredVersionId = selectedVersionId === version.id
      ? remainingVersions.find((item) => item.id === overview.activeVersionId)?.id
        ?? remainingVersions[0]?.id
        ?? null
      : selectedVersionId;

    setBusyAction(`delete:${version.id}`);
    try {
      const response = await fetch(`${apiBasePath}/versions/${version.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const message = await readError(response, 'Не удалось удалить версию HTML');
        if (response.status === 404 || response.status === 409) {
          await loadOverview(preferredVersionId);
        }
        showStatusRef.current(message);
        return;
      }

      await loadOverview(preferredVersionId);
      setPreviewRevision((current) => current + 1);
      showStatusRef.current(`Версия #${version.id} удалена`);
    } catch {
      showStatusRef.current('Не удалось удалить версию HTML');
    } finally {
      setBusyAction(null);
    }
  };

  const beginBlockTitleEdit = () => {
    if (!overview || busyAction !== null) return;
    setBlockTitleDraft(overview.block.title);
    setBlockMutationError(null);
    setIsEditingBlockTitle(true);
  };

  const cancelBlockTitleEdit = () => {
    setBlockTitleDraft('');
    setBlockMutationError(null);
    setIsEditingBlockTitle(false);
  };

  const renameBlock = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!overview || busyAction !== null) return;

    const title = blockTitleDraft.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    if (!title || Array.from(title).length > 120) {
      setBlockMutationError('Название блока должно содержать от 1 до 120 символов');
      blockTitleInputRef.current?.focus();
      return;
    }
    if (title === overview.block.title) {
      cancelBlockTitleEdit();
      return;
    }

    setBusyAction('rename-block');
    setBlockMutationError(null);
    try {
      const response = await fetch(apiBasePath, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ title }),
      });
      if (!response.ok) {
        if (response.status === 404) {
          showStatusRef.current('Блок уже удалён');
          router.replace('/admin/top', { scroll: false });
          return;
        }
        const message = await readError(response, 'Не удалось изменить название блока');
        setBlockMutationError(message);
        showStatusRef.current(message);
        return;
      }

      const data = await response.json().catch(() => ({}));
      const updatedTitle = typeof data.block?.title === 'string' ? data.block.title : title;
      setOverview((current) => current
        ? { ...current, block: { ...current.block, title: updatedTitle } }
        : current);
      setBlockTitleDraft('');
      setIsEditingBlockTitle(false);
      showStatusRef.current('Название блока изменено');
    } catch {
      const message = 'Не удалось изменить название блока';
      setBlockMutationError(message);
      showStatusRef.current(message);
    } finally {
      setBusyAction(null);
    }
  };

  const deleteBlock = async () => {
    if (!overview || busyAction !== null) return;

    const title = overview.block.title;
    const versions = versionCountLabel(overview.versions.length);
    if (
      !window.confirm(
        `Удалить блок «${title}» и все его версии (${versions})?\n\nЭто действие необратимо: блок и загруженные HTML-файлы будут удалены полностью.`,
      )
    ) {
      return;
    }

    setBusyAction('delete-block');
    setBlockMutationError(null);
    try {
      const response = await fetch(apiBasePath, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        if (response.status === 404) {
          showStatusRef.current('Блок уже удалён');
          router.replace('/admin/top', { scroll: false });
          return;
        }
        const message = await readError(response, 'Не удалось удалить блок');
        setBlockMutationError(message);
        showStatusRef.current(message);
        return;
      }

      showStatusRef.current(`Блок «${title}» удалён`);
      router.replace('/admin/top', { scroll: false });
    } catch {
      const message = 'Не удалось удалить блок';
      setBlockMutationError(message);
      showStatusRef.current(message);
    } finally {
      setBusyAction(null);
    }
  };

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
        <span className={styles.topDashboardEyebrow}>HTML-дашборд</span>
        <h2>Страница не открылась</h2>
        <p>{loadError}</p>
        <button type="button" onClick={() => router.push('/admin/top', { scroll: false })}>
          Вернуться к списку HTML-страниц
        </button>
      </section>
    );
  }

  return (
    <div className={styles.topDashboardLayout}>
      <section className={styles.section}>
        <div className={styles.sectionHeader} aria-busy={busyAction === 'rename-block' || busyAction === 'delete-block'}>
          <div className={styles.topDashboardBlockHeading}>
            <p>HTML-дашборд</p>
            {isEditingBlockTitle ? (
              <form className={styles.topDashboardTitleForm} onSubmit={renameBlock}>
                <label htmlFor="top-dashboard-block-title-edit">Название блока</label>
                <div>
                  <input
                    ref={blockTitleInputRef}
                    id="top-dashboard-block-title-edit"
                    type="text"
                    value={blockTitleDraft}
                    maxLength={120}
                    disabled={busyAction !== null}
                    aria-describedby={blockMutationError ? 'top-dashboard-block-mutation-error' : undefined}
                    onChange={(event) => setBlockTitleDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        cancelBlockTitleEdit();
                      }
                    }}
                  />
                  <button type="submit" disabled={busyAction !== null || !blockTitleDraft.trim()}>
                    {busyAction === 'rename-block' ? 'Сохраняем…' : 'Сохранить'}
                  </button>
                  <button
                    className={styles.secondary}
                    type="button"
                    disabled={busyAction !== null}
                    onClick={cancelBlockTitleEdit}
                  >
                    Отмена
                  </button>
                </div>
              </form>
            ) : (
              <div className={styles.topDashboardBlockTitleRow}>
                <h2>{overview?.block.title ?? 'HTML-страница'}</h2>
                {overview ? (
                  <button
                    className={styles.secondary}
                    type="button"
                    disabled={busyAction !== null}
                    onClick={beginBlockTitleEdit}
                  >
                    Изменить название
                  </button>
                ) : null}
              </div>
            )}
          </div>
          <div className={styles.topDashboardBlockHeaderActions}>
            <span className={styles.headingMeta}>{versionCountLabel(overview?.versions.length ?? 0)}</span>
            {overview ? (
              <button
                className={styles.danger}
                type="button"
                disabled={busyAction !== null || isEditingBlockTitle}
                onClick={() => void deleteBlock()}
              >
                {busyAction === 'delete-block' ? 'Удаляем…' : 'Удалить блок'}
              </button>
            ) : null}
          </div>
        </div>

        {blockMutationError ? (
          <p id="top-dashboard-block-mutation-error" className={styles.topDashboardMutationError} role="alert">
            {blockMutationError}
          </p>
        ) : null}

        <div className={styles.topDashboardUploadCard}>
          <div>
            <h3>Загрузить новую версию</h3>
            <p>Самодостаточный HTML до 5 МБ сохранится как черновик. Текущая публикация не изменится до подтверждения; в этом блоке хранится до 50 версий общим объёмом до 100 МБ.</p>
          </div>
          <div className={styles.topDashboardUploadControls}>
            <label className={styles.topDashboardFilePicker}>
              <span>Выбрать HTML</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".html,.htm,text/html"
                disabled={busyAction !== null}
                onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
              />
            </label>
            <div className={styles.topDashboardSelectedFile}>
              {selectedFile ? (
                <>
                  <strong>{selectedFile.name}</strong>
                  <span>{formatFileSize(selectedFile.size)}</span>
                </>
              ) : (
                <span>Файл не выбран</span>
              )}
            </div>
            <button type="button" disabled={!selectedFile || busyAction !== null} onClick={uploadVersion}>
              {busyAction === 'upload' ? 'Загружаем…' : 'Загрузить как черновик'}
            </button>
          </div>
        </div>
      </section>

      <section
        className={`${styles.section} ${styles.topDashboardDataSection}`}
        aria-busy={busyAction === 'upload-data' || busyAction?.startsWith('activate-data:')}
      >
        <div className={styles.sectionHeader}>
          <div>
            <p>Общие данные</p>
            <h2>Данные дашборда</h2>
          </div>
          <span className={styles.headingMeta}>{versionCountLabel(overview?.data.versions.length ?? 0)}</span>
        </div>

        <p className={styles.topDashboardDataIntro}>
          {hasActiveHtml
            ? 'Сохранённый файл автоматически откроется в дашборде у всех пользователей с доступом. Новый файл сразу заменит текущие данные, а предыдущая версия останется доступна для отката.'
            : 'Сначала опубликуйте HTML-страницу. После этого здесь можно будет сохранить подходящий файл данных для всех пользователей.'}
        </p>

        <div className={`${styles.topDashboardUploadCard} ${styles.topDashboardDataUploadCard}`}>
          <div>
            <h3>{activeDataVersion ? 'Обновить данные' : 'Загрузить данные'}</h3>
            <p>
              Поддерживаются снимки .json и .json.gz размером до{' '}
              {TOP_DASHBOARD_DATA_MAX_MEGABYTES} МБ. Для .json.gz размер после распаковки — до{' '}
              {TOP_DASHBOARD_DATA_MAX_UNCOMPRESSED_LABEL}. HTML-страницу повторно загружать не нужно.
            </p>
          </div>
          <div className={styles.topDashboardUploadControls}>
            <label className={styles.topDashboardFilePicker}>
              <span>Выбрать данные</span>
              <input
                ref={dataFileInputRef}
                type="file"
                accept=".json,.json.gz,application/json,application/gzip"
                disabled={busyAction !== null || !overview || !hasActiveHtml}
                onChange={(event) => chooseDataFile(event.target.files?.[0] ?? null)}
              />
            </label>
            <div className={styles.topDashboardSelectedFile}>
              {selectedDataFile ? (
                <>
                  <strong>{selectedDataFile.name}</strong>
                  <span>{formatFileSize(selectedDataFile.size)}</span>
                </>
              ) : (
                <span>Файл не выбран</span>
              )}
            </div>
            <button
              type="button"
              disabled={!selectedDataFile || busyAction !== null || !overview || !hasActiveHtml}
              onClick={() => void uploadDataVersion()}
            >
              {busyAction === 'upload-data'
                ? 'Сохраняем…'
                : activeDataVersion
                  ? 'Заменить для всех'
                  : 'Сохранить для всех'}
            </button>
          </div>
        </div>

        {activeDataVersion ? (
          <article className={styles.topDashboardActiveDataCard}>
            <div>
              <span className={styles.topDashboardDataCardEyebrow}>Сейчас используется</span>
              <div className={styles.topDashboardVersionTitle}>
                <strong>{activeDataVersion.originalName}</strong>
                <span className={`${styles.topDashboardStatus} ${styles.topDashboardStatusactive}`}>
                  Активные данные
                </span>
              </div>
              <div className={styles.topDashboardMeta}>
                <span>{snapshotFormatLabel(activeDataVersion.snapshotFormat)}</span>
                <span>Файл: {formatFileSize(activeDataVersion.fileSize)}</span>
                <span>{storedSizeLabel(activeDataVersion)}</span>
                <span>Загрузил: {activeDataVersion.uploadedByName || 'Администратор'}</span>
                <span>{formatDate(activeDataVersion.createdAt)}</span>
                <span>SHA-256: {activeDataVersion.sha256.slice(0, 12)}…</span>
              </div>
            </div>
          </article>
        ) : (
          <div className={styles.topDashboardDataEmpty}>
            <strong>Данные ещё не загружены</strong>
            <span>Выберите снимок выше. После сохранения другим пользователям не придётся выбирать его заново.</span>
          </div>
        )}

        {overview?.data.versions.length ? (
          <div className={styles.topDashboardDataHistory}>
            <div className={styles.topDashboardDataHistoryHeader}>
              <h3>История данных</h3>
              {overview.data.previousVersionId ? (
                <span>Предыдущая версия #{overview.data.previousVersionId}</span>
              ) : null}
            </div>
            <div className={styles.topDashboardVersionList}>
              {overview.data.versions.map((version) => (
                <article className={styles.topDashboardVersionRow} key={version.id}>
                  <div>
                    <div className={styles.topDashboardVersionTitle}>
                      <strong>{version.originalName}</strong>
                      <span className={`${styles.topDashboardStatus} ${styles[`topDashboardStatus${version.status}`]}`}>
                        {dataStatusLabel(version.status)}
                      </span>
                    </div>
                    <div className={styles.topDashboardMeta}>
                      <span>Версия данных #{version.id}</span>
                      <span>{snapshotFormatLabel(version.snapshotFormat)}</span>
                      <span>Файл: {formatFileSize(version.fileSize)}</span>
                      <span>{storedSizeLabel(version)}</span>
                      <span>Загрузил: {version.uploadedByName || 'Администратор'}</span>
                      <span>{formatDate(version.createdAt)}</span>
                    </div>
                  </div>
                  {version.status !== 'active' ? (
                    <div className={styles.topDashboardVersionActions}>
                      <button
                        type="button"
                        disabled={busyAction !== null || !hasActiveHtml}
                        onClick={() => void activateDataVersion(version)}
                      >
                        {busyAction === `activate-data:${version.id}` ? 'Возвращаем…' : 'Откатить данные'}
                      </button>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <section
        ref={previewCardRef}
        className={`${styles.topDashboardPreviewCard}${isPreviewFullscreen ? ` ${styles.topDashboardPreviewFullscreen}` : ''}`}
        aria-busy={loading}
      >
        <div className={styles.topDashboardPreviewHeader}>
          <div>
            <span className={styles.topDashboardEyebrow}>Предпросмотр в изолированном режиме</span>
            <h2>{selectedVersion?.originalName ?? 'HTML ещё не загружен'}</h2>
            {selectedVersion ? (
              <div className={styles.topDashboardMeta}>
                <span>Версия #{selectedVersion.id}</span>
                <span>{formatFileSize(selectedVersion.fileSize)}</span>
                <span>{formatDate(selectedVersion.createdAt)}</span>
                <span>SHA-256: {selectedVersion.sha256.slice(0, 12)}…</span>
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
                onClick={() => {
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
            <span>Выберите HTML выше — после загрузки здесь сразу откроется безопасный предпросмотр.</span>
          </div>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div>
            <p>История</p>
            <h2>Версии и откат</h2>
          </div>
          {activeVersion ? <span className={styles.headingMeta}>Активна #{activeVersion.id}</span> : null}
        </div>

        {overview?.versions.length ? (
          <div className={styles.topDashboardVersionList}>
            {overview.versions.map((version) => (
              <article
                className={`${styles.topDashboardVersionRow} ${version.id === selectedVersionId ? styles.topDashboardVersionSelected : ''}`}
                key={version.id}
              >
                <div>
                  <div className={styles.topDashboardVersionTitle}>
                    <strong>{version.originalName}</strong>
                    <span className={`${styles.topDashboardStatus} ${styles[`topDashboardStatus${version.status}`]}`}>
                      {statusLabel(version.status)}
                    </span>
                  </div>
                  <div className={styles.topDashboardMeta}>
                    <span>Версия #{version.id}</span>
                    <span>{formatFileSize(version.fileSize)}</span>
                    <span>Загрузил: {version.uploadedByName || 'Администратор'}</span>
                    <span>{formatDate(version.createdAt)}</span>
                    {version.firstPublishedAt ? <span>Первая публикация: {formatDate(version.firstPublishedAt)}</span> : null}
                  </div>
                </div>
                <div className={styles.topDashboardVersionActions}>
                  <button
                    className={styles.secondary}
                    type="button"
                    onClick={() => {
                      setSelectedVersionId(version.id);
                      setPreviewRevision((current) => current + 1);
                    }}
                  >
                    Предпросмотр
                  </button>
                  {version.status !== 'active' ? (
                    <>
                      <button type="button" disabled={busyAction !== null} onClick={() => activateVersion(version)}>
                        {busyAction === `activate:${version.id}`
                          ? 'Публикуем…'
                          : version.status === 'archived'
                            ? 'Откатить'
                            : 'Опубликовать'}
                      </button>
                      <button
                        className={styles.danger}
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => deleteVersion(version)}
                      >
                        {busyAction === `delete:${version.id}` ? 'Удаляем…' : 'Удалить'}
                      </button>
                    </>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className={styles.mutedText}>История появится после первой загрузки HTML.</p>
        )}
      </section>
    </div>
  );
}
