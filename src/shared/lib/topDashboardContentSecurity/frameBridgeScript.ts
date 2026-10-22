import { multiFileCodecScript } from './frame/multiFileCodec';
import { snapshotTransportScript } from './frame/snapshotTransport';
import { managementUploadsScript } from './frame/managementUploads';
import { framePrintScript } from './frame/print';
import { dashboardUsageRelayScript } from '../dashboardUsageBridge';
import { dashboardProfitabilityBridgeScript } from '../dashboardProfitabilityBridge';
import {
  TOP_DASHBOARD_DOWNLOAD_INVALID_NAME_PATTERN_SOURCE,
  TOP_DASHBOARD_DOWNLOAD_MAX_BYTES,
  TOP_DASHBOARD_DOWNLOAD_MAX_NAME_LENGTH,
  TOP_DASHBOARD_DOWNLOAD_MESSAGE_MARKER,
  TOP_DASHBOARD_DOWNLOAD_NAME_PATTERN_SOURCE,
} from '../topDashboardDownloadBridge';

import { TOP_DASHBOARD_DATA_MAX_BYTES } from '../topDashboardLimits';

import {
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAGIC,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_BYTES,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES_PER_TARGET,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_MIME_TYPE_BYTES,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_RELATIVE_PATH_BYTES,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGETS,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_VERSION,
} from '../topDashboardMultiFileSnapshot';

import { TOP_DASHBOARD_DATA_MESSAGE_MARKER, TOP_DASHBOARD_MULTI_FILE_MESSAGE_MARKER } from './protocol';

export function createTopDashboardFrameBridgeScript(
  blockId: number,
  htmlVersionId: number,
  canManage: boolean,
  profitability?: { preview: boolean; auditEnabled?: boolean },
) {
  const config = JSON.stringify({
    dataPath: `/api/admin/top-dashboard/blocks/${blockId}/data`,
    blockId,
    htmlVersionId,
    canManage,
    localInvoiceMode: Boolean(profitability),
  });

  return String.raw`(() => {
  'use strict';
  const CONFIG = ${config};
  const MANAGEMENT_MARKER = 'kts-top-dashboard-management-v1';
  const MARKER = '${TOP_DASHBOARD_DATA_MESSAGE_MARKER}';
  const MULTI_FILE_MARKER = '${TOP_DASHBOARD_MULTI_FILE_MESSAGE_MARKER}';
  const MAX_BYTES = ${TOP_DASHBOARD_DATA_MAX_BYTES};
  const MULTI_FILE_MAX_BYTES = ${TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_BYTES};
  const MULTI_FILE_MAGIC = ${JSON.stringify(TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAGIC)};
  const MULTI_FILE_VERSION = ${TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_VERSION};
  const MULTI_FILE_MAX_TARGETS = ${TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGETS};
  const MULTI_FILE_MAX_FILES = ${TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES};
  const MULTI_FILE_MAX_FILES_PER_TARGET = ${TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES_PER_TARGET};
  const MULTI_FILE_MAX_MIME_BYTES = ${TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_MIME_TYPE_BYTES};
  const MULTI_FILE_MAX_PATH_BYTES = ${TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_RELATIVE_PATH_BYTES};
  const DOWNLOAD_MARKER = '${TOP_DASHBOARD_DOWNLOAD_MESSAGE_MARKER}';
  const DOWNLOAD_MAX_BYTES = ${TOP_DASHBOARD_DOWNLOAD_MAX_BYTES};
  const DOWNLOAD_MAX_NAME_LENGTH = ${TOP_DASHBOARD_DOWNLOAD_MAX_NAME_LENGTH};
  const DOWNLOAD_NAME = new RegExp(${JSON.stringify(TOP_DASHBOARD_DOWNLOAD_NAME_PATTERN_SOURCE)}, 'i');
  const DOWNLOAD_INVALID_NAME = new RegExp(${JSON.stringify(TOP_DASHBOARD_DOWNLOAD_INVALID_NAME_PATTERN_SOURCE)}, 'i');
  const SNAPSHOT_NAME = /\.json(?:\.gz)?$/i;
  const iframe = document.querySelector('#dashboard-frame');
  ${dashboardUsageRelayScript('iframe')}
  ${profitability && profitability.auditEnabled !== false ? dashboardProfitabilityBridgeScript('iframe', { dashboardKey: `top:${blockId}`, versionId: htmlVersionId, preview: profitability.preview }) : ''}
  const notice = document.querySelector('#data-notice');
  let initialLoadStarted = false;
  let noticeTimer = 0;
  let probeTimer = 0;
  let probeAttempts = 0;
  let adapterExpectedFormat = '';
  let adapterExpectedProfile = '';
  let activeDataVersionId = null;
  let multiFileTargets = new Map();
  let loadPromise = null;
  let prefetchPromise = null;
  let restoreSequence = 0;
  let activeRestoreId = 0;
  let saveRequested = 0;
  let saveCompleted = 0;
  let saveLoopRunning = false;
  let managementUploadPending = false;
  let managementUploadController = null;
  let managementUploadRequestId = null;
  const pendingSnapshotRequests = new Set();
  let discoveredUploadTargets = [];
  let uploadTargetsKnown = false;
  let pendingTargetProbe = null;

  // Includes the response body. A timed-out write has an unknown outcome, so
  // never replay it automatically; let the administrator inspect the history.
  async function snapshotRequest(work, externalSignal) {
    const controller = new AbortController();
    let stop;
    let timer;
    const interrupted = new Promise((_, reject) => {
      stop = () => {
        reject(new Error('Подтверждение сохранения не получено. Проверьте историю перед повторной загрузкой.'));
        controller.abort();
      };
      timer = window.setTimeout(stop, 20 * 60_000);
    });
    pendingSnapshotRequests.add(stop);
    const abort = () => stop();
    externalSignal?.addEventListener('abort', abort, { once: true });
    if (externalSignal?.aborted) abort();
    try {
      if (controller.signal.aborted) return await interrupted;
      return await Promise.race([interrupted, work(controller.signal)]);
    } finally {
      window.clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abort);
      pendingSnapshotRequests.delete(stop);
    }
  }
  window.addEventListener('pagehide', () => {
    managementUploadController?.abort();
    for (const stop of pendingSnapshotRequests) stop();
  });

  function showNotice(kind, message, autoHide) {
    if (!(notice instanceof HTMLElement)) return;
    if (noticeTimer) window.clearTimeout(noticeTimer);
    notice.dataset.kind = kind;
    notice.textContent = message;
    notice.hidden = false;
    if (autoHide) {
      noticeTimer = window.setTimeout(() => { notice.hidden = true; }, 3200);
    }
  }

${framePrintScript()}  function hideNotice() {
    if (!(notice instanceof HTMLElement)) return;
    if (noticeTimer) window.clearTimeout(noticeTimer);
    noticeTimer = 0;
    notice.hidden = true;
  }

  function waitForNoticePaint() {
    return new Promise((resolve) => {
      let completed = false;
      const finish = () => {
        if (completed) return;
        completed = true;
        window.clearTimeout(fallbackTimer);
        resolve();
      };
      const fallbackTimer = window.setTimeout(finish, 250);
      try {
        window.requestAnimationFrame(() => window.requestAnimationFrame(finish));
      } catch {
        finish();
      }
    });
  }

  function validName(value) {
    return typeof value === 'string'
      && value.length > 0
      && value.length <= 255
      && SNAPSHOT_NAME.test(value);
  }

  function validBuffer(value, maxBytes = MAX_BYTES) {
    return value instanceof ArrayBuffer
      && value.byteLength > 0
      && value.byteLength <= maxBytes;
  }

${multiFileCodecScript()}  function normalizeDownloadName(value) {
    if (typeof value !== 'string') return '';
    const name = value.normalize('NFC').trim();
    if (
      !name
      || name.length > DOWNLOAD_MAX_NAME_LENGTH
      || name === '.'
      || name === '..'
      || DOWNLOAD_INVALID_NAME.test(name)
      || !DOWNLOAD_NAME.test(name)
    ) return '';
    return name;
  }

  function validDownloadBlob(value) {
    return value instanceof Blob
      && value.size > 0
      && value.size <= DOWNLOAD_MAX_BYTES;
  }

${snapshotTransportScript()}${managementUploadsScript()}  const adapterErrors = {
    SNAPSHOT_INPUT_NOT_FOUND: 'В HTML не найдено поле для файла данных',
    SNAPSHOT_INSTALL_FAILED: 'Не удалось подставить сохранённые данные в HTML',
    SNAPSHOT_INVALID: 'Сохранённый файл данных имеет неверный формат',
    MULTI_FILE_SELECTION_INVALID: 'Выбранный набор файлов превышает допустимые ограничения',
    MULTI_FILE_DROP_TARGET_NOT_FOUND: 'Не удалось связать область перетаскивания с полем выбора файлов',
    MULTI_FILE_INSTALL_FAILED: 'Не удалось восстановить файлы в HTML-дашборде',
    DOWNLOAD_INVALID: 'HTML подготовил файл недопустимого формата или размера',
  };

  window.addEventListener('message', (event) => {
    if (
      !(iframe instanceof HTMLIFrameElement)
      || event.source !== iframe.contentWindow
      || event.origin !== 'null'
    ) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.marker === DOWNLOAD_MARKER && data.type === 'download-request') {
      if (!navigator.userActivation || !navigator.userActivation.isActive) {
        showNotice('error', 'Скачивание разрешено только после нажатия кнопки', false);
        return;
      }
      const name = normalizeDownloadName(data.name);
      if (!name || !validDownloadBlob(data.blob)) {
        showNotice('error', 'HTML подготовил файл недопустимого формата или размера', false);
        return;
      }
      window.parent.postMessage(
        { marker: DOWNLOAD_MARKER, type: 'download-request', name, blob: data.blob },
        window.location.origin,
      );
      return;
    }
    if (CONFIG.localInvoiceMode) return;
    if (data.marker === MULTI_FILE_MARKER) {
      if (data.type === 'upload-targets') {
        acceptUploadTargets(data.targets, data.requestId);
      } else if (data.type === 'files-selected') {
        void acceptMultiFileSelection(data);
      } else if (
        Number.isSafeInteger(data.restoreId)
        && data.restoreId > 0
        && data.restoreId === activeRestoreId
        && data.type === 'files-processing'
      ) {
        showNotice('pending', 'Строим отчёт…', false);
      } else if (
        Number.isSafeInteger(data.restoreId)
        && data.restoreId > 0
        && data.restoreId === activeRestoreId
        && data.type === 'files-installed'
        && data.confirmation === 'event'
      ) {
        const fileCount = Number.isSafeInteger(data.fileCount) && data.fileCount > 0
          ? data.fileCount
          : 0;
        showNotice(
          'success',
          fileCount > 0
            ? 'Сохранённые файлы восстановлены: ' + fileCount
            : 'Сохранённые файлы восстановлены',
          true,
        );
      } else if (
        Number.isSafeInteger(data.restoreId)
        && data.restoreId > 0
        && data.restoreId === activeRestoreId
        && data.type === 'files-processing-unconfirmed'
      ) {
        showNotice(
          'pending',
          'Данные переданы; дашборд завершает обработку…',
          true,
        );
      } else if (
        Number.isSafeInteger(data.restoreId)
        && data.restoreId > 0
        && data.restoreId === activeRestoreId
        && data.type === 'files-delivered-unconfirmed'
      ) {
        showNotice(
          'pending',
          'Файлы переданы в дашборд, но завершение обработки не подтверждено',
          true,
        );
      }
      return;
    }
    if (data.marker !== MARKER) return;
    if (data.type === 'adapter-ready') {
      if (!initialLoadStarted) {
        adapterExpectedFormat = data.expectedFormat === 'kts-bundle-v1'
          || data.expectedFormat === 'purchases-v1'
          || data.expectedFormat === 'multi-file-v1'
          ? data.expectedFormat
          : '';
        adapterExpectedProfile = data.expectedProfile === 'sales-analytics'
          || data.expectedProfile === 'assortment-optimization'
          || data.expectedProfile === 'purchases'
          || data.expectedProfile === 'generic'
          ? data.expectedProfile
          : '';
        initialLoadStarted = true;
        stopProbing();
        loadPromise = Promise.resolve(prefetchPromise).then(installPrefetchedData);
      }
      return;
    }
    if (data.type === 'snapshot-installed') {
      showNotice('success', 'Сохранённые данные переданы в дашборд', true);
      return;
    }
    if (data.type === 'adapter-error') {
      if (
        Number.isSafeInteger(data.restoreId)
        && data.restoreId > 0
        && data.restoreId !== activeRestoreId
      ) return;
      const message = adapterErrors[data.code];
      if (message) showNotice('error', message, false);
      return;
    }
  });

  if (!CONFIG.localInvoiceMode) {
    prefetchPromise = prefetchActiveData();
    probeAdapter();
    probeTimer = window.setInterval(probeAdapter, 250);
  }
})();`;
}
