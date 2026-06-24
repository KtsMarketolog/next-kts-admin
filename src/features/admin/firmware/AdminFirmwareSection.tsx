'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';

import styles from '@/app/admin/admin.module.scss';

type FirmwareFile = {
  id: string;
  fileName: string;
  url: string;
  accept: string;
  size: number | null;
  updatedAt: string | null;
  exists: boolean;
};

type AdminFirmwareSectionProps = {
  showStatus: (message: string) => void;
};

async function readError(response: Response, fallback: string) {
  const data = await response.json().catch(() => ({}));
  return typeof data.error === 'string' ? data.error : fallback;
}

function formatFileSize(bytes: number | null) {
  if (!bytes || bytes <= 0) return '0 Б';
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${Math.ceil(kilobytes)} КБ`;
  return `${(kilobytes / 1024).toFixed(1).replace('.', ',')} МБ`;
}

function formatDate(value: string | null) {
  if (!value) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function AdminFirmwareSection({ showStatus }: AdminFirmwareSectionProps) {
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [files, setFiles] = useState<FirmwareFile[]>([]);
  const [selectedNames, setSelectedNames] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  const loadFirmware = useCallback(async () => {
    const response = await fetch('/api/admin/firmware', { cache: 'no-store' });
    if (!response.ok) {
      showStatus(await readError(response, 'Не удалось загрузить список прошивок'));
      return;
    }
    const data = await response.json().catch(() => ({}));
    setFiles(Array.isArray(data.files) ? data.files : []);
  }, [showStatus]);

  useEffect(() => {
    void loadFirmware();
  }, [loadFirmware]);

  const markSaved = (id: string) => {
    setSavedId(id);
    window.setTimeout(() => {
      setSavedId((current) => (current === id ? null : current));
    }, 1800);
  };

  const replaceFirmware = async (event: FormEvent, targetId: string) => {
    event.preventDefault();
    const file = inputRefs.current[targetId]?.files?.[0];
    if (!file) {
      showStatus('Выберите файл прошивки');
      return;
    }

    const formData = new FormData();
    formData.append('target', targetId);
    formData.append('file', file);

    setBusyId(targetId);
    const response = await fetch('/api/admin/firmware', { method: 'POST', body: formData });
    setBusyId(null);

    if (!response.ok) {
      showStatus(await readError(response, 'Не удалось заменить файл прошивки'));
      return;
    }

    setSelectedNames((current) => ({ ...current, [targetId]: '' }));
    if (inputRefs.current[targetId]) inputRefs.current[targetId]!.value = '';
    await loadFirmware();
    markSaved(targetId);
    showStatus('Файл прошивки заменен');
  };

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <p>Прошивки</p>
          <h2>Файлы обновлений</h2>
        </div>
        <span className={styles.headingMeta}>{files.length} файла</span>
      </div>

      {files.map((item) => (
        <form className={styles.catalogImportCard} key={item.id} onSubmit={(event) => replaceFirmware(event, item.id)}>
          <div>
            <h3>{item.fileName}</h3>
            <p>
              <a className={styles.firmwareFileUrl} href={item.url} target="_blank" rel="noreferrer">
                {item.url}
              </a>
            </p>
            <span>
              {item.exists
                ? `Размер: ${formatFileSize(item.size)}${item.updatedAt ? `; обновлен: ${formatDate(item.updatedAt)}` : ''}`
                : 'Файл еще не загружен'}
            </span>
          </div>
          <label className={styles.fileInput}>
            {selectedNames[item.id] || 'Выбрать файл'}
            <input
              ref={(node) => {
                inputRefs.current[item.id] = node;
              }}
              type="file"
              accept={item.accept}
              onChange={(event) => setSelectedNames((current) => ({ ...current, [item.id]: event.target.files?.[0]?.name ?? '' }))}
            />
          </label>
          <button className={savedId === item.id ? styles.savedButton : undefined} disabled={busyId === item.id}>
            {busyId === item.id ? 'Замена...' : savedId === item.id ? 'Заменено' : 'Заменить файл'}
          </button>
        </form>
      ))}
    </section>
  );
}
