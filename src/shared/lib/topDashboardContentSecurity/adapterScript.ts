import { multiFileAdapterScript } from './sandbox/multiFileAdapter';
import { sandboxPopupScript, sandboxDownloadScript } from './sandbox/downloads';
import { readOnlyAdapterScript } from './sandbox/readOnly';
import { sandboxPrintScript } from './sandbox/print';
import { dashboardUsageAdapterScript } from '../dashboardUsageBridge';
import type { TopDashboardProfile, TopDashboardSnapshotFormat } from '../db/topDashboardDomain';
import {
  TOP_DASHBOARD_DOWNLOAD_INVALID_NAME_PATTERN_SOURCE,
  TOP_DASHBOARD_DOWNLOAD_MAX_BYTES,
  TOP_DASHBOARD_DOWNLOAD_MAX_NAME_LENGTH,
  TOP_DASHBOARD_DOWNLOAD_MESSAGE_MARKER,
  TOP_DASHBOARD_DOWNLOAD_NAME_PATTERN_SOURCE,
} from '../topDashboardDownloadBridge';

import { TOP_DASHBOARD_DATA_MAX_BYTES } from '../topDashboardLimits';

import type { TopDashboardLegacyReadyFunction } from './legacyReady';
import { TOP_DASHBOARD_DATA_MESSAGE_MARKER, TOP_DASHBOARD_MULTI_FILE_MESSAGE_MARKER } from './protocol';


/**
 * This code runs inside the opaque-origin sandbox that contains an uploaded
 * dashboard. Direct requests and network subresources remain blocked by CSP.
 * User-initiated popups are allowed only when they keep the same sandbox
 * restrictions; the trusted outer frame is the only component allowed to read
 * or persist a snapshot.
 */
export function getTopDashboardDataAdapterScript(
  expectedFormat: TopDashboardSnapshotFormat | null = null,
  expectedProfile: TopDashboardProfile | null = null,
  readOnly = false,
  legacyReadyFunction: TopDashboardLegacyReadyFunction | null = null,
  localInvoiceMode = false,
  downloadMaxBytes = TOP_DASHBOARD_DOWNLOAD_MAX_BYTES,
) {
  if (!Number.isSafeInteger(downloadMaxBytes) || downloadMaxBytes < 1) throw new RangeError('Invalid download byte limit');
  const expectedFormatJson = JSON.stringify(expectedFormat);
  const expectedProfileJson = JSON.stringify(expectedProfile);
  const readOnlyJson = JSON.stringify(readOnly && !localInvoiceMode);
  const legacyReadyFunctionJson = JSON.stringify(legacyReadyFunction);
  return String.raw`${dashboardUsageAdapterScript()}
(() => {
  'use strict';
  const MARKER = '${TOP_DASHBOARD_DATA_MESSAGE_MARKER}';
  const MULTI_FILE_MARKER = '${TOP_DASHBOARD_MULTI_FILE_MESSAGE_MARKER}';
  const MAX_BYTES = ${TOP_DASHBOARD_DATA_MAX_BYTES};
  const EXPECTED_FORMAT = ${expectedFormatJson};
  const EXPECTED_PROFILE = ${expectedProfileJson};
  const LOCAL_INVOICE_MODE = ${JSON.stringify(localInvoiceMode)};
  const MULTI_FILE_MODE = !LOCAL_INVOICE_MODE && EXPECTED_FORMAT === 'multi-file-v1' && EXPECTED_PROFILE === 'generic';
  const READ_ONLY = ${readOnlyJson};
  const LEGACY_READY_FUNCTION = ${legacyReadyFunctionJson};
  const RESTORE_START_EVENT = 'kts-top-dashboard-restore-start';
  const RESTORE_READY_EVENT = 'kts-top-dashboard-data-ready';
  const RESTORE_DOM_QUIET_MS = 1000;
  const RESTORE_TIMEOUT_MS = 120000;
  const MULTI_INPUT_DISPATCH_GAP_MS = 150;
  const DOWNLOAD_MARKER = '${TOP_DASHBOARD_DOWNLOAD_MESSAGE_MARKER}';
  const DOWNLOAD_MAX_BYTES = ${downloadMaxBytes};
  const DOWNLOAD_MAX_NAME_LENGTH = ${TOP_DASHBOARD_DOWNLOAD_MAX_NAME_LENGTH};
  const DOWNLOAD_NAME = new RegExp(${JSON.stringify(TOP_DASHBOARD_DOWNLOAD_NAME_PATTERN_SOURCE)}, 'i');
  const DOWNLOAD_INVALID_NAME = new RegExp(${JSON.stringify(TOP_DASHBOARD_DOWNLOAD_INVALID_NAME_PATTERN_SOURCE)}, 'i');
  const SNAPSHOT_NAME = /\.json(?:\.gz)?$/i;
  const nativeOpen = window.open.bind(window);
  const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
  const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  const popupObjectUrls = new Set();
  const downloadableObjectUrls = new Map();
  let pendingSnapshot = null;
  let inputObserver = null;
  let inputTimeout = 0;
  let multiFileRestorePending = false;
  let legacyRestoreId = 0;

  function dispatchDashboardReady(restoreId) {
    if (!validRestoreId(restoreId)) return;
    window.dispatchEvent(new CustomEvent(RESTORE_READY_EVENT, {
      detail: { restoreId },
    }));
    if (window.__ktsDashboardUsage) window.__ktsDashboardUsage.record('data_loaded');
  }

  function installLegacyReadyHook(restoreId) {
    legacyRestoreId = restoreId;
    if (!LEGACY_READY_FUNCTION) return;
    const current = window[LEGACY_READY_FUNCTION];
    if (typeof current !== 'function' || current.__ktsDashboardReadyHook === true) return;
    const wrapped = function ktsDashboardReadyHook() {
      const result = current.apply(this, arguments);
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then((value) => {
          dispatchDashboardReady(legacyRestoreId);
          return value;
        });
      }
      dispatchDashboardReady(legacyRestoreId);
      return result;
    };
    Object.defineProperty(wrapped, '__ktsDashboardReadyHook', { value: true });
    window[LEGACY_READY_FUNCTION] = wrapped;
  }

  /*
   * Some dashboards open a blank page with noopener and then fill the returned
   * handle with document.write(). Noopener deliberately returns null, while a
   * sandboxed popup also has a different opaque origin in Safari. Collect that
   * synchronous write into a Blob and open the finished document directly so
   * it keeps noopener and inherits this document's CSP and sandbox.
   */
${sandboxPopupScript()}  function validName(value) {
    return typeof value === 'string'
      && value.length > 0
      && value.length <= 255
      && SNAPSHOT_NAME.test(value);
  }

  function validBuffer(value) {
    return value instanceof ArrayBuffer
      && value.byteLength > 0
      && value.byteLength <= MAX_BYTES;
  }

  function send(type, extra, transfer) {
    const message = Object.assign({ marker: MARKER, type }, extra || {});
    window.parent.postMessage(message, '*', transfer || []);
  }

${sandboxDownloadScript()}${sandboxPrintScript()}  function report(code, extra) {
    send('adapter-error', Object.assign({ code }, extra || {}));
  }

  function findSnapshotInput() {
    const preferred = document.querySelector('#snapInp') || document.querySelector('#file');
    if (preferred instanceof HTMLInputElement && preferred.type === 'file') return preferred;
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    return inputs.find((input) => /(?:\.json|\.gz|application\/json)/i.test(input.accept || '')) || null;
  }

${multiFileAdapterScript()}${readOnlyAdapterScript()}  function stopWaitingForInput() {
    if (inputObserver) inputObserver.disconnect();
    inputObserver = null;
    if (inputTimeout) window.clearTimeout(inputTimeout);
    inputTimeout = 0;
  }

  async function installSnapshot(snapshot) {
    const input = findSnapshotInput();
    if (!input) {
      pendingSnapshot = snapshot;
      if (!inputObserver) {
        inputObserver = new MutationObserver(() => {
          if (pendingSnapshot && findSnapshotInput()) {
            const next = pendingSnapshot;
            pendingSnapshot = null;
            stopWaitingForInput();
            void installSnapshot(next);
          }
        });
        inputObserver.observe(document.documentElement, { childList: true, subtree: true });
        inputTimeout = window.setTimeout(() => {
          pendingSnapshot = null;
          stopWaitingForInput();
          report('SNAPSHOT_INPUT_NOT_FOUND');
        }, 10000);
      }
      return;
    }

    try {
      const type = /\.gz$/i.test(snapshot.name) ? 'application/gzip' : 'application/json';
      const file = new File([snapshot.buffer], snapshot.name, { type });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      const dashboardHandler = typeof window.handleFiles === 'function'
        ? window.handleFiles
        : null;
      if (dashboardHandler) {
        await Promise.race([
          Promise.resolve(dashboardHandler(input.files)),
          new Promise((_, reject) => window.setTimeout(() => reject(new Error('timeout')), 45000)),
        ]);
      } else {
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 750));
      }
      lockFileInputs();
      send('snapshot-installed');
    } catch {
      report('SNAPSHOT_INSTALL_FAILED');
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || LOCAL_INVOICE_MODE) return;
    if (data.marker === MULTI_FILE_MARKER && data.type === 'probe-upload-targets') {
      reportUploadTargets(true, data.requestId);
      return;
    }
    if (
      data.marker === MULTI_FILE_MARKER
      && data.type === 'restore-files'
      && MULTI_FILE_MODE
    ) {
      void installMultiFileSnapshot(data.targets, data.restoreId);
      return;
    }
    if (data.marker !== MARKER) return;
    if (data.type === 'bridge-probe') {
      ready();
      return;
    }
    if (data.type !== 'snapshot-data') return;
    if (!validName(data.name) || !validBuffer(data.buffer)) {
      report('SNAPSHOT_INVALID');
      return;
    }
    void installSnapshot({ name: data.name, buffer: data.buffer });
  });

  function ready() {
    if (LOCAL_INVOICE_MODE) return;
    send('adapter-ready', {
      expectedFormat: EXPECTED_FORMAT,
      expectedProfile: EXPECTED_PROFILE,
      multiFileMode: MULTI_FILE_MODE,
    });
    reportUploadTargets(true);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready, { once: true });
  } else {
    ready();
  }
})();`;
}
