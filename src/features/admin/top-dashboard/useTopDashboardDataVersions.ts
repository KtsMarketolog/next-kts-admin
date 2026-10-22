'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ADMIN_SNAPSHOT_TIMEOUT_MS } from '@/features/admin/shared/adminRequest';
import { requestProfitabilityFrameChange } from '@/features/admin/dashboard-usage/useProfitabilityAuditGuard';
import { TOP_DASHBOARD_DATA_MAX_BYTES, TOP_DASHBOARD_DATA_MAX_MEGABYTES } from '@/shared/lib/topDashboardLimits';
import { encodeTopDashboardMultiFileBlobSnapshot } from '@/shared/lib/topDashboardMultiFileSnapshot';
import { normalizeTopDashboardUploadTargets, topDashboardUploadTargetKey, type TopDashboardUploadTarget } from './topDashboardUploadSelection';
import { readError, uploadWarningMessages, type TopDashboardDataVersion, type UploadFeedback } from './topDashboardManagementModel';
import type { TopDashboardManagement } from './useTopDashboardManagement';

/** Data selection and upload protocol, including the trusted preview's runtime-only fields. */
export function useTopDashboardDataVersions(management: TopDashboardManagement) {
  const { blockId, overview, selectedVersionId, busyAction, previewFrameRef, mutationRef, beginMutation, finishMutation, apiBasePath, request, loadOverview, setPreviewRevision, showStatusRef, isActive } = management;
  const [selectedDataFile, setSelectedDataFile] = useState<File | null>(null);
  const [dataUploadFeedback, setDataUploadFeedback] = useState<UploadFeedback | null>(null);
  const [selectedTargetFiles, setSelectedTargetFiles] = useState<Record<string, File[]>>({});
  const [runtimeUploadTargets, setRuntimeUploadTargets] = useState<{
    blockId: number;
    htmlVersionId: number;
    targets: TopDashboardUploadTarget[];
  } | null>(null);
  const [selectedDataHtmlVersionId, setSelectedDataHtmlVersionId] = useState<number | null>(null);
  const dataFileInputRef = useRef<HTMLInputElement>(null);
  const uploadSelectionRevisionRef = useRef('');
  const runtimeUploadRef = useRef<{
    requestId: string;
    htmlVersionId: number;
    resolve: (warnings: string[]) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const reportUploadFeedback = (_target: 'data', message: string, kind: UploadFeedback['kind'] = 'error') => {
    setDataUploadFeedback({ kind, message });
    showStatusRef.current(message);
  };
  useEffect(() => { setDataUploadFeedback(null); }, [loadOverview]);

  const cancelPendingUpload = () => {
    const pending = runtimeUploadRef.current;
    if (!pending) return;
    previewFrameRef.current?.contentWindow?.postMessage({
      marker: 'kts-top-dashboard-management-v1', type: 'cancel-upload', blockId,
      htmlVersionId: pending.htmlVersionId, requestId: pending.requestId,
    }, window.location.origin);
    clearTimeout(pending.timer);
    runtimeUploadRef.current = null;
    pending.reject(new Error('Ожидание прервано. Изменение могло сохраниться; проверьте историю перед повторной отправкой.'));
  };

  const activeDataVersion = useMemo(
    () => overview?.data.versions.find((version) => version.id === overview.data.activeVersionId) ?? null,
    [overview],
  );
  const activeHtmlVersionId = overview?.activeVersionId ?? null;
  const hasActiveHtml = Boolean(activeHtmlVersionId);
  const isProfitabilityReport = overview?.activeDataContract.profile === 'profitability';
  const isStandaloneReport = overview?.activeDataContract.profile === 'standalone';
  const isLocalDataReport = isProfitabilityReport || isStandaloneReport;
  const activeDataContractMatches = overview !== null
    && overview.block.id === blockId
    && overview.activeDataContract.htmlVersionId === overview.activeVersionId;
  const usesUniversalDataUpload = overview?.activeDataContract.mode === 'generic';
  const usesRuntimeUploadTargets = usesUniversalDataUpload
    && runtimeUploadTargets?.blockId === blockId
    && runtimeUploadTargets.htmlVersionId === overview?.activeVersionId
    && selectedVersionId === overview?.activeVersionId;
  const dataUploadTargets = activeDataContractMatches && usesUniversalDataUpload
    ? usesRuntimeUploadTargets
      ? runtimeUploadTargets.targets
      : overview?.activeDataContract.uploadTargets ?? []
    : [];
  const canUploadData = hasActiveHtml
    && activeDataContractMatches
    && (
      overview?.activeDataContract.mode === 'legacy'
      || dataUploadTargets.length > 0
    );
  const uploadSelectionRevision = JSON.stringify([
    blockId, overview?.activeVersionId, usesRuntimeUploadTargets, dataUploadTargets,
  ]);
  const selectedFileCount = Object.values(selectedTargetFiles).reduce((count, files) => count + files.length, 0);
  const selectedFilesSize = Object.values(selectedTargetFiles).flat().reduce((size, file) => size + file.size, 0);

  useEffect(() => {
    if (uploadSelectionRevisionRef.current === uploadSelectionRevision) return;
    uploadSelectionRevisionRef.current = uploadSelectionRevision;
    setSelectedTargetFiles({});
    setSelectedDataFile(null);
    setSelectedDataHtmlVersionId(null);
    if (dataFileInputRef.current) dataFileInputRef.current.value = '';
  }, [uploadSelectionRevision]);

  const probeRuntimeUploadTargets = useCallback(() => {
    if (!activeHtmlVersionId || selectedVersionId !== activeHtmlVersionId) return;
    previewFrameRef.current?.contentWindow?.postMessage({
      marker: 'kts-top-dashboard-management-v1',
      type: 'probe-upload-targets',
      blockId,
      htmlVersionId: activeHtmlVersionId,
    }, window.location.origin);
  }, [blockId, activeHtmlVersionId, previewFrameRef, selectedVersionId]);

  useEffect(() => {
    const receiveMessage = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin
        || event.source !== previewFrameRef.current?.contentWindow
        || !event.data || typeof event.data !== 'object'
      ) return;
      const message = event.data as Record<string, unknown>;
      if (
        message.marker !== 'kts-top-dashboard-management-v1'
        || message.blockId !== blockId
        || message.htmlVersionId !== activeHtmlVersionId
        || selectedVersionId !== activeHtmlVersionId
      ) return;
      if (message.type === 'upload-targets') {
        const targets = normalizeTopDashboardUploadTargets(message.targets);
        if (!Number.isSafeInteger(message.htmlVersionId)) return;
        setRuntimeUploadTargets((current) => {
          const next = { blockId, htmlVersionId: Number(message.htmlVersionId), targets };
          return JSON.stringify(current) === JSON.stringify(next) ? current : next;
        });
      }
      if (message.type === 'upload-result') {
        const pending = runtimeUploadRef.current;
        if (!pending || pending.requestId !== message.requestId || pending.htmlVersionId !== message.htmlVersionId) return;
        clearTimeout(pending.timer);
        runtimeUploadRef.current = null;
        if (message.ok === true) pending.resolve(uploadWarningMessages(message.warnings));
        else pending.reject(new Error(typeof message.error === 'string'
          ? message.error : 'Не удалось сохранить выбранные файлы'));
      }
    };
    window.addEventListener('message', receiveMessage);
    probeRuntimeUploadTargets();
    return () => {
      window.removeEventListener('message', receiveMessage);
      const pending = runtimeUploadRef.current;
      if (pending) {
        clearTimeout(pending.timer);
        runtimeUploadRef.current = null;
        pending.reject(new Error('Просмотр HTML изменился. Проверьте историю данных перед повторной загрузкой.'));
      }
    };
  }, [blockId, activeHtmlVersionId, previewFrameRef, probeRuntimeUploadTargets, selectedVersionId]);

  const getSelectedUploadTargets = (selection: Record<string, File[]>) => dataUploadTargets
    .map((descriptor) => ({
      target: descriptor.target,
      files: (selection[topDashboardUploadTargetKey(descriptor.target)] ?? []).map((file) => ({
        name: file.name,
        type: file.type,
        lastModified: file.lastModified,
        webkitRelativePath: file.webkitRelativePath,
        blob: file,
      })),
    }))
    .filter((entry) => entry.files.length > 0);

  const chooseTargetFiles = (descriptor: TopDashboardUploadTarget, files: File[]) => {
    if (!canUploadData || busyAction !== null) return;
    setDataUploadFeedback(null);
    if (!descriptor.multiple && !descriptor.directory && files.length > 1) {
      reportUploadFeedback('data', 'Для этого поля отчёт принимает один файл. Для других полей выберите данные отдельно.');
      return;
    }
    const next = { ...selectedTargetFiles, [topDashboardUploadTargetKey(descriptor.target)]: files };
    const targets = getSelectedUploadTargets(next);
    try {
      // Building an envelope validates aggregate size/count/paths; payloads stay
      // as Blob parts, without copying large source files into ArrayBuffers.
      if (targets.length) encodeTopDashboardMultiFileBlobSnapshot({ targets });
      setSelectedTargetFiles(next);
      setSelectedDataHtmlVersionId(overview?.activeVersionId ?? null);
    } catch (error) {
      reportUploadFeedback('data', error instanceof Error ? error.message : 'Не удалось подготовить выбранные файлы');
    }
  };

  const chooseDataFile = (file: File | null) => {
    setDataUploadFeedback(null);
    if (!file) {
      setSelectedDataFile(null);
      setSelectedDataHtmlVersionId(null);
      return;
    }
    if (!canUploadData) {
      setSelectedDataFile(null);
      setSelectedDataHtmlVersionId(null);
      reportUploadFeedback('data',
        usesUniversalDataUpload
          ? 'Для этого HTML выберите файлы внутри предпросмотра'
          : 'Для опубликованной HTML-страницы не удалось определить способ загрузки данных',
      );
      return;
    }
    if (!usesUniversalDataUpload && !/\.json(?:\.gz)?$/i.test(file.name)) {
      setSelectedDataFile(null);
      setSelectedDataHtmlVersionId(null);
      reportUploadFeedback('data', 'Выберите файл с расширением .json или .json.gz');
      return;
    }
    if (file.size <= 0 || file.size > TOP_DASHBOARD_DATA_MAX_BYTES) {
      setSelectedDataFile(null);
      setSelectedDataHtmlVersionId(null);
      reportUploadFeedback('data',
        `Файл данных должен быть непустым и не больше ${TOP_DASHBOARD_DATA_MAX_MEGABYTES} МБ`,
      );
      return;
    }
    setSelectedDataFile(file);
    setSelectedDataHtmlVersionId(overview?.activeVersionId ?? null);
  };

  const uploadDataVersion = async () => {
    if (mutationRef.current) return;
    if (!requestProfitabilityFrameChange(previewFrameRef.current)) return;
    setDataUploadFeedback(null);
    if (!overview || (usesUniversalDataUpload ? !selectedFileCount : !selectedDataFile)) {
      reportUploadFeedback('data', 'Сначала выберите файл данных');
      return;
    }
    if (!overview.activeVersionId) {
      reportUploadFeedback('data', 'Сначала опубликуйте HTML-страницу');
      return;
    }
    if (selectedDataHtmlVersionId !== overview.activeVersionId) {
      setSelectedDataFile(null);
      setSelectedTargetFiles({});
      setSelectedDataHtmlVersionId(null);
      if (dataFileInputRef.current) dataFileInputRef.current.value = '';
      reportUploadFeedback('data', 'HTML-страница изменилась. Выберите файл данных заново.');
      return;
    }
    if (overview.activeDataContract.mode === 'disabled') {
      reportUploadFeedback('data', 'Для опубликованной HTML-страницы не удалось определить способ загрузки данных');
      return;
    }
    if (overview.activeDataContract.htmlVersionId !== overview.activeVersionId) {
      reportUploadFeedback('data', 'Активная HTML-страница изменилась. Обновите страницу и повторите.');
      await loadOverview(selectedVersionId);
      return;
    }
    if (overview.activeDataContract.mode === 'generic' && !dataUploadTargets.length) {
      reportUploadFeedback('data', 'Дождитесь определения полей загрузки в опубликованном HTML');
      return;
    }
    if (usesUniversalDataUpload && activeDataVersion) {
      const labels = dataUploadTargets
        .filter((descriptor) => selectedTargetFiles[topDashboardUploadTargetKey(descriptor.target)]?.length)
        .map((descriptor) => descriptor.label)
        .join(', ');
      if (!window.confirm(
        `Заменить данные для всех пользователей?\n\nВыбрано файлов: ${selectedFileCount}. Поля: ${labels}.\n\nВыбранный набор заменит текущие данные целиком. Если отчёту нужны несколько файлов, выберите их все. Предыдущая версия останется для отката.`,
      )) return;
    }

    if (!beginMutation('upload-data')) return;
    try {
      const uploadTargets = getSelectedUploadTargets(selectedTargetFiles);
      if (usesUniversalDataUpload && usesRuntimeUploadTargets) {
        // Runtime-only fields must be checked by the trusted preview wrapper,
        // never submitted as arbitrary target identifiers to the direct API.
        encodeTopDashboardMultiFileBlobSnapshot({ targets: uploadTargets });
        const frameWindow = previewFrameRef.current?.contentWindow;
        if (!frameWindow) throw new Error('Предпросмотр ещё не готов. Повторите после загрузки HTML.');
        const warnings = await new Promise<string[]>((resolve, reject) => {
          const requestId = crypto.randomUUID();
          const timer = setTimeout(() => {
            frameWindow.postMessage({ marker: 'kts-top-dashboard-management-v1', type: 'cancel-upload',
              blockId, htmlVersionId: overview.activeVersionId, requestId }, window.location.origin);
            runtimeUploadRef.current = null;
            reject(new Error('Подтверждение сохранения не получено. Проверьте историю данных перед повторной загрузкой.'));
          }, ADMIN_SNAPSHOT_TIMEOUT_MS);
          runtimeUploadRef.current = { requestId, htmlVersionId: overview.activeVersionId!, resolve, reject, timer };
          try {
            frameWindow.postMessage({
              marker: 'kts-top-dashboard-management-v1',
              type: 'upload-files',
              blockId,
              htmlVersionId: overview.activeVersionId,
              expectedActiveDataVersionId: overview.data.activeVersionId,
              requestId,
              targets: uploadTargets,
            }, window.location.origin);
          } catch (error) {
            clearTimeout(timer);
            runtimeUploadRef.current = null;
            reject(error);
          }
        });
        setSelectedTargetFiles({});
        setSelectedDataHtmlVersionId(null);
        const refreshed = await loadOverview(selectedVersionId).catch(() => null);
        setPreviewRevision((current) => current + 1);
        reportUploadFeedback('data', [`Данные сохранены для всех пользователей.${refreshed ? ` Текущая версия #${refreshed.data.activeVersionId}.` : ' Список версий не обновился — обновите страницу. Повторять загрузку не нужно.'}`, ...warnings].join(' '), 'success');
        return;
      }
      const headers: Record<string, string> = {
        'X-KTS-TOP-Data-Upload': '1',
        'X-KTS-Top-Data-Protocol': 'stream-v1',
        'X-KTS-Top-Data-Expected-Version': overview.data.activeVersionId === null
          ? 'none'
          : String(overview.data.activeVersionId),
      };
      let body: BodyInit = selectedDataFile ?? new Blob();

      if (overview.activeDataContract.mode === 'generic') {
        try {
          body = encodeTopDashboardMultiFileBlobSnapshot({ targets: uploadTargets });
        } catch (error) {
          reportUploadFeedback('data', error instanceof Error ? error.message : 'Не удалось подготовить выбранные файлы');
          return;
        }
        headers['X-KTS-Top-Dashboard-Multi-File'] = '1';
        headers['X-KTS-Top-Dashboard-Direct-Files'] = '1';
        headers['X-KTS-Top-HTML-Version'] = String(overview.activeVersionId);
      } else {
        headers['X-KTS-Top-Data-Name'] = encodeURIComponent(selectedDataFile!.name);
      }

      const response = await request(`${apiBasePath}/data`, {
        method: 'PUT',
        headers,
        body,
        credentials: 'same-origin',
      }, { timeoutMs: ADMIN_SNAPSHOT_TIMEOUT_MS });
      if (!response.ok) {
        const message = await readError(response, 'Не удалось сохранить данные дашборда');
        if (response.status === 409) await loadOverview(selectedVersionId);
        reportUploadFeedback('data', message);
        return;
      }

      const result = await response.json().catch(() => ({}));
      const savedVersionId = Number(result.version?.id);
      if (!Number.isSafeInteger(savedVersionId) || savedVersionId <= 0 || result.state?.activeVersionId !== savedVersionId) {
        reportUploadFeedback('data', 'Сервер не подтвердил новую активную версию данных. Проверьте историю перед повторной загрузкой.');
        return;
      }
      const savedName = typeof result.version?.originalName === 'string' ? result.version.originalName : selectedDataFile?.name;

      setSelectedDataFile(null);
      setSelectedTargetFiles({});
      setSelectedDataHtmlVersionId(null);
      if (dataFileInputRef.current) dataFileInputRef.current.value = '';
      const refreshed = await loadOverview(selectedVersionId).catch(() => null);
      setPreviewRevision((current) => current + 1);
      reportUploadFeedback('data', [`Данные${savedName ? ` «${savedName}»` : ''} сохранены для всех пользователей, версия #${savedVersionId}.${refreshed ? '' : ' Список версий не обновился — обновите страницу. Повторять загрузку не нужно.'}`, ...uploadWarningMessages(result.warnings)].join(' '), 'success');
    } catch (error) {
      if (!isActive()) return;
      if (usesRuntimeUploadTargets) await loadOverview(selectedVersionId);
      reportUploadFeedback('data', `${error instanceof Error ? error.message : 'Не удалось сохранить данные дашборда'}. Подтверждение сохранения не получено; проверьте историю перед повторной загрузкой.`);
    } finally {
      finishMutation();
    }
  };

  const activateDataVersion = async (version: TopDashboardDataVersion) => {
    if (mutationRef.current) return;
    if (!requestProfitabilityFrameChange(previewFrameRef.current)) return;
    if (!overview || version.status === 'active') return;
    if (overview.activeDataContract.mode === 'disabled') {
      showStatusRef.current('В этом отчёте данные загружаются внутри HTML и не сохраняются как общий снимок сайта.');
      return;
    }
    if (!overview.activeVersionId) {
      showStatusRef.current('Сначала опубликуйте HTML-страницу');
      return;
    }
    if (!window.confirm(`Вернуть данные из файла «${version.originalName}»?`)) return;

    if (!beginMutation(`activate-data:${version.id}`)) return;
    try {
      const response = await request(`${apiBasePath}/data/active`, {
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

      const refreshed = await loadOverview(selectedVersionId);
      setPreviewRevision((current) => current + 1);
      showStatusRef.current(`Выбранная версия данных восстановлена для всех пользователей.${refreshed ? '' : ' Список не обновился — обновите страницу, повторять сохранение не нужно.'}`);
    } catch (error) {
      if (isActive()) showStatusRef.current(error instanceof Error ? error.message : 'Не удалось подтвердить восстановление данных. Обновите историю перед повторной попыткой.');
    } finally {
      finishMutation();
    }
  };

  return { activeDataVersion, activeHtmlVersionId, hasActiveHtml, isStandaloneReport, isLocalDataReport, isProfitabilityReport, activeDataContractMatches, usesUniversalDataUpload, dataUploadTargets, canUploadData, uploadSelectionRevision, selectedFileCount, selectedFilesSize, selectedTargetFiles, selectedDataFile, dataUploadFeedback, dataFileInputRef, probeRuntimeUploadTargets, chooseTargetFiles, chooseDataFile, uploadDataVersion, activateDataVersion, cancelPendingUpload };
}

export type TopDashboardDataVersions = ReturnType<typeof useTopDashboardDataVersions>;
