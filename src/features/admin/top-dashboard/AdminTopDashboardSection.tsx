'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import styles from '@/app/admin/admin.module.scss';

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

type TopDashboardOverview = {
  activeVersionId: number | null;
  previousVersionId: number | null;
  updatedAt: string | null;
  versions: TopDashboardVersion[];
};

type AdminTopDashboardSectionProps = {
  showStatus: (message: string) => void;
};

const MAX_HTML_BYTES = 5 * 1024 * 1024;

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

async function readError(response: Response, fallback: string) {
  const data = await response.json().catch(() => ({}));
  return typeof data.error === 'string' ? data.error : fallback;
}

export function AdminTopDashboardSection({ showStatus }: AdminTopDashboardSectionProps) {
  const [overview, setOverview] = useState<TopDashboardOverview | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const showStatusRef = useRef(showStatus);

  useEffect(() => {
    showStatusRef.current = showStatus;
  }, [showStatus]);

  const loadOverview = useCallback(async (preferredVersionId?: number | null) => {
    setLoading(true);
    try {
      const response = await fetch('/api/admin/top-dashboard', {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        showStatusRef.current(await readError(response, 'Не удалось загрузить версии стратегического обзора'));
        return null;
      }

      const data = (await response.json()) as TopDashboardOverview;
      const versions = Array.isArray(data.versions) ? data.versions : [];
      const normalized: TopDashboardOverview = {
        activeVersionId: Number.isInteger(data.activeVersionId) ? data.activeVersionId : null,
        previousVersionId: Number.isInteger(data.previousVersionId) ? data.previousVersionId : null,
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : null,
        versions,
      };
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
      showStatusRef.current('Не удалось загрузить версии стратегического обзора');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const activeVersion = useMemo(
    () => overview?.versions.find((version) => version.id === overview.activeVersionId) ?? null,
    [overview],
  );
  const selectedVersion = useMemo(
    () => overview?.versions.find((version) => version.id === selectedVersionId) ?? null,
    [overview, selectedVersionId],
  );

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

  const uploadVersion = async () => {
    if (!selectedFile) {
      showStatusRef.current('Сначала выберите HTML-файл');
      return;
    }

    setBusyAction('upload');
    try {
      const body = new FormData();
      body.set('file', selectedFile);
      const response = await fetch('/api/admin/top-dashboard/versions', {
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

  const activateVersion = async (version: TopDashboardVersion) => {
    if (!overview || version.status === 'active') return;
    if (
      version.status === 'archived'
      && !window.confirm(`Откатить опубликованный обзор на версию «${version.originalName}»?`)
    ) {
      return;
    }

    setBusyAction(`activate:${version.id}`);
    try {
      const response = await fetch('/api/admin/top-dashboard/active', {
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

  return (
    <div className={styles.topDashboardLayout}>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div>
            <p>HTML-дашборд</p>
            <h2>Публикация стратегического обзора</h2>
          </div>
          <span className={styles.headingMeta}>{overview?.versions.length ?? 0} версий</span>
        </div>

        <div className={styles.topDashboardUploadCard}>
          <div>
            <h3>Загрузить новую версию</h3>
            <p>Самодостаточный HTML до 5 МБ сохранится как черновик. Текущая публикация не изменится до подтверждения; история хранит до 50 версий и 100 МБ.</p>
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

      <section className={styles.topDashboardPreviewCard} aria-busy={loading}>
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
              <button className={styles.secondary} type="button" onClick={() => setPreviewRevision((current) => current + 1)}>
                Обновить просмотр
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
          <div className={styles.topDashboardEmpty}>Загружаем стратегический обзор…</div>
        ) : selectedVersion ? (
          <div className={styles.topDashboardFrameShell}>
            <iframe
              key={`${selectedVersion.id}:${previewRevision}`}
              className={styles.topDashboardFrame}
              src={`/api/admin/top-dashboard/versions/${selectedVersion.id}/frame?revision=${previewRevision}`}
              title={`Предпросмотр ${selectedVersion.originalName}`}
              sandbox="allow-scripts allow-same-origin"
              referrerPolicy="no-referrer"
              allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'"
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
                    <button type="button" disabled={busyAction !== null} onClick={() => activateVersion(version)}>
                      {busyAction === `activate:${version.id}`
                        ? 'Публикуем…'
                        : version.status === 'archived'
                          ? 'Откатить'
                          : 'Опубликовать'}
                    </button>
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
