import { createHash } from 'crypto';

import type {
  TopDashboardProfile,
  TopDashboardSnapshotFormat,
} from './db/topDashboardDomain';
import { TOP_DASHBOARD_DATA_MAX_BYTES } from './topDashboardLimits';

const INLINE_SCRIPT_PATTERN = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
const INLINE_EVENT_HANDLER_PATTERN = /\son[a-z][\w:-]*\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const HEAD_OPEN_PATTERN = /<head\b[^>]*>/i;
const DOCTYPE_PATTERN = /<!doctype\b[^>]*>/i;

export const TOP_DASHBOARD_DATA_MESSAGE_MARKER = 'kts-top-dashboard-data-v1';
export { TOP_DASHBOARD_DATA_MAX_BYTES } from './topDashboardLimits';
export const TOP_DASHBOARD_DATA_ADAPTER_ATTRIBUTE = 'data-kts-top-dashboard-data-adapter';

export function detectTopDashboardExpectedProfile(
  htmlContent: string,
): TopDashboardProfile | null {
  if (
    /\bid\s*=\s*(?:"snapInp"|'snapInp')/i.test(htmlContent)
    || /\bgetElementById\(\s*(?:"snapInp"|'snapInp')\s*\)/i.test(htmlContent)
  ) {
    return 'purchases';
  }

  if (
    /\bDASH_NAME\s*=\s*(?:"аналитика_продаж"|'аналитика_продаж')/iu.test(htmlContent)
  ) {
    return 'sales-analytics';
  }

  if (
    /\bDASH_NAME\s*=\s*(?:"оптимизация_ассортимента"|'оптимизация_ассортимента')/iu.test(htmlContent)
  ) {
    return 'assortment-optimization';
  }

  const hasSalesSources = /\bSALES_SOURCES\b/.test(htmlContent);
  const hasAssortmentSources = /\bASSORT_SOURCES\b/.test(htmlContent);
  if (hasSalesSources !== hasAssortmentSources) {
    return hasSalesSources ? 'sales-analytics' : 'assortment-optimization';
  }

  return null;
}

export function detectTopDashboardExpectedSnapshotFormat(
  htmlContent: string,
): TopDashboardSnapshotFormat | null {
  const profile = detectTopDashboardExpectedProfile(htmlContent);
  if (profile === 'purchases') {
    return 'purchases-v1';
  }

  if (
    /\bformat\s*:\s*(?:"kts-bundle"|'kts-bundle')/i.test(htmlContent)
    || /\bformat\s*!==?\s*(?:"kts-bundle"|'kts-bundle')/i.test(htmlContent)
  ) {
    return 'kts-bundle-v1';
  }

  return null;
}

function sha256Source(value: string) {
  return `'sha256-${createHash('sha256').update(value, 'utf8').digest('base64')}'`;
}

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
) {
  const expectedFormatJson = JSON.stringify(expectedFormat);
  const expectedProfileJson = JSON.stringify(expectedProfile);
  const readOnlyJson = JSON.stringify(readOnly);
  return String.raw`(() => {
  'use strict';
  const MARKER = '${TOP_DASHBOARD_DATA_MESSAGE_MARKER}';
  const MAX_BYTES = ${TOP_DASHBOARD_DATA_MAX_BYTES};
  const EXPECTED_FORMAT = ${expectedFormatJson};
  const EXPECTED_PROFILE = ${expectedProfileJson};
  const READ_ONLY = ${readOnlyJson};
  const SNAPSHOT_NAME = /\.json(?:\.gz)?$/i;
  const nativeOpen = window.open.bind(window);
  const popupObjectUrls = new Set();
  let pendingSnapshot = null;
  let inputObserver = null;
  let inputTimeout = 0;

  /*
   * Some dashboards open a blank page with noopener and then fill the returned
   * handle with document.write(). Noopener deliberately returns null, while a
   * sandboxed popup also has a different opaque origin in Safari. Collect that
   * synchronous write into a Blob and open the finished document directly so
   * it keeps noopener and inherits this document's CSP and sandbox.
   */
  window.open = function openSandboxedWindow(url, target, features) {
    const hasNoopener = typeof features === 'string'
      && features.split(',').some((feature) => /^\s*noopener(?:\s*=\s*(?:yes|1|true))?\s*$/i.test(feature));
    const requestedUrl = url == null ? '' : String(url);
    const writableBlank = requestedUrl === '' || requestedUrl.toLowerCase() === 'about:blank';
    if (!hasNoopener || !writableBlank) return nativeOpen(url, target, features);

    let html = '';
    let committed = false;
    const popupDocument = {
      open() {
        html = '';
        committed = false;
        return popupDocument;
      },
      write(...parts) {
        if (!committed) html += parts.map(String).join('');
      },
      writeln(...parts) {
        if (!committed) html += parts.map(String).join('') + '\n';
      },
      close() {
        if (committed) return;
        committed = true;
        const objectUrl = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
        popupObjectUrls.add(objectUrl);
        nativeOpen(objectUrl, target, features);
      },
    };

    return {
      document: popupDocument,
      close() { committed = true; },
      get closed() { return committed; },
    };
  };

  window.addEventListener('pagehide', () => {
    popupObjectUrls.forEach((objectUrl) => URL.revokeObjectURL(objectUrl));
    popupObjectUrls.clear();
  }, { once: true });

  function validName(value) {
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

  function report(code) {
    send('adapter-error', { code });
  }

  function findSnapshotInput() {
    const preferred = document.querySelector('#snapInp') || document.querySelector('#file');
    if (preferred instanceof HTMLInputElement && preferred.type === 'file') return preferred;
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    return inputs.find((input) => /(?:\.json|\.gz|application\/json)/i.test(input.accept || '')) || null;
  }

  function isFileInput(value) {
    return value instanceof HTMLInputElement && value.type === 'file';
  }

  function lockFileInputs() {
    if (!READ_ONLY) return;
    document.querySelectorAll('input[type="file"]').forEach((input) => {
      if (!isFileInput(input)) return;
      if (!input.disabled) input.disabled = true;
      if (input.tabIndex !== -1) input.tabIndex = -1;
      if (input.getAttribute('aria-hidden') !== 'true') input.setAttribute('aria-hidden', 'true');
    });
  }

  function blockOwnerFileInteraction(event) {
    if (!READ_ONLY) return;
    const target = event.target;
    const transfer = event.dataTransfer || event.clipboardData;
    const hasFiles = transfer
      && (transfer.files.length > 0 || Array.from(transfer.types || []).includes('Files'));
    const isBlockedFileEvent = (event.type === 'click' && isFileInput(target))
      || ((event.type === 'drop' || event.type === 'dragenter' || event.type === 'dragover') && hasFiles)
      || (event.type === 'change' && event.isTrusted && isFileInput(target));
    if (!isBlockedFileEvent) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  if (READ_ONLY) {
    const readOnlyStyle = document.createElement('style');
    readOnlyStyle.textContent = 'input[type="file"],label[for="file"],label[for="folder"],label[for="snapInp"],#drop,#btnFiles,#btnDir,#btnSnapLoad,button[onclick*="pickFiles("],button[onclick*="connectFolder("],button[onclick*="refreshFromFolder("]{display:none!important}';
    document.head.appendChild(readOnlyStyle);
    ['click', 'change', 'dragenter', 'dragover', 'drop'].forEach((type) => {
      document.addEventListener(type, blockOwnerFileInteraction, true);
    });
    const fileInputObserver = new MutationObserver(lockFileInputs);
    fileInputObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['disabled', 'type'],
      childList: true,
      subtree: true,
    });
    lockFileInputs();
  }

  function stopWaitingForInput() {
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
    if (!data || typeof data !== 'object' || data.marker !== MARKER) return;
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
    send('adapter-ready', {
      expectedFormat: EXPECTED_FORMAT,
      expectedProfile: EXPECTED_PROFILE,
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready, { once: true });
  } else {
    ready();
  }
})();`;
}

export function injectTopDashboardDataAdapter(
  htmlContent: string,
  options: { readOnly?: boolean } = {},
) {
  const expectedFormat = detectTopDashboardExpectedSnapshotFormat(htmlContent);
  const expectedProfile = detectTopDashboardExpectedProfile(htmlContent);
  const adapter = `<script ${TOP_DASHBOARD_DATA_ADAPTER_ATTRIBUTE}>${getTopDashboardDataAdapterScript(expectedFormat, expectedProfile, options.readOnly === true)}</script>`;
  const head = HEAD_OPEN_PATTERN.exec(htmlContent);
  if (head) {
    const index = head.index + head[0].length;
    return `${htmlContent.slice(0, index)}${adapter}${htmlContent.slice(index)}`;
  }

  const doctype = DOCTYPE_PATTERN.exec(htmlContent);
  if (doctype) {
    const index = doctype.index + doctype[0].length;
    return `${htmlContent.slice(0, index)}${adapter}${htmlContent.slice(index)}`;
  }

  return `${adapter}${htmlContent}`;
}

export function createTopDashboardFrameBridgeScript(blockId: number) {
  const config = JSON.stringify({
    dataPath: `/api/admin/top-dashboard/blocks/${blockId}/data`,
  });

  return String.raw`(() => {
  'use strict';
  const CONFIG = ${config};
  const MARKER = '${TOP_DASHBOARD_DATA_MESSAGE_MARKER}';
  const MAX_BYTES = ${TOP_DASHBOARD_DATA_MAX_BYTES};
  const SNAPSHOT_NAME = /\.json(?:\.gz)?$/i;
  const iframe = document.querySelector('#dashboard-frame');
  const notice = document.querySelector('#data-notice');
  let initialLoadStarted = false;
  let noticeTimer = 0;
  let probeTimer = 0;
  let probeAttempts = 0;
  let adapterExpectedFormat = '';
  let adapterExpectedProfile = '';

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

  function validName(value) {
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

  function decodeName(value) {
    if (!value) return '';
    try { return decodeURIComponent(value); } catch { return ''; }
  }

  function contentDispositionName(value) {
    if (!value) return '';
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value);
    if (encoded) return decodeName(encoded[1].trim());
    const plain = /filename=(?:"([^"]+)"|([^;]+))/i.exec(value);
    return plain ? (plain[1] || plain[2] || '').trim() : '';
  }

  function responseName(response) {
    const headerName = decodeName(response.headers.get('X-Top-Dashboard-Data-Original-Name') || '');
    if (validName(headerName)) return headerName;
    const dispositionName = contentDispositionName(response.headers.get('Content-Disposition') || '');
    return validName(dispositionName) ? dispositionName : '';
  }

  function responseVersion(response) {
    const value = response.headers.get('X-Top-Dashboard-Data-Version-Id') || '';
    return /^[1-9]\d*$/.test(value) ? value : '';
  }

  function responseFormat(response) {
    const value = response.headers.get('X-Top-Dashboard-Data-Snapshot-Format') || '';
    return value === 'kts-bundle-v1' || value === 'purchases-v1' ? value : '';
  }

  function responseProfile(response) {
    const value = response.headers.get('X-Top-Dashboard-Data-Profile') || '';
    return value === 'sales-analytics'
      || value === 'assortment-optimization'
      || value === 'purchases'
      ? value
      : '';
  }

  function postSnapshot(name, buffer) {
    if (!(iframe instanceof HTMLIFrameElement) || !iframe.contentWindow) return false;
    iframe.contentWindow.postMessage(
      { marker: MARKER, type: 'snapshot-data', name, buffer },
      '*',
      [buffer],
    );
    return true;
  }

  async function responseError(response, fallback) {
    try {
      const payload = await response.json();
      if (payload && typeof payload.error === 'string' && payload.error.length <= 240) {
        return payload.error;
      }
    } catch {}
    return fallback;
  }

  async function loadActiveData(showLoadedNotice) {
    let response;
    try {
      response = await fetch(CONFIG.dataPath, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/octet-stream' },
      });
    } catch {
      showNotice('error', 'Не удалось загрузить сохранённые данные', false);
      return false;
    }

    if (response.status === 404) {
      return true;
    }
    if (!response.ok) {
      showNotice('error', await responseError(response, 'Не удалось загрузить сохранённые данные'), false);
      return false;
    }

    const name = responseName(response);
    const versionId = responseVersion(response);
    const snapshotFormat = responseFormat(response);
    const snapshotProfile = responseProfile(response);
    if (
      (adapterExpectedFormat && snapshotFormat && adapterExpectedFormat !== snapshotFormat)
      || (adapterExpectedProfile && snapshotProfile && adapterExpectedProfile !== snapshotProfile)
    ) {
      showNotice('error', 'Сохранённые данные не подходят для этой HTML-страницы', false);
      return false;
    }
    const buffer = await response.arrayBuffer().catch(() => null);
    if (!name || !versionId || !snapshotFormat || !snapshotProfile || !validBuffer(buffer)) {
      showNotice('error', 'Сохранённый файл данных повреждён или слишком большой', false);
      return false;
    }

    postSnapshot(name, buffer);
    if (showLoadedNotice) showNotice('pending', 'Открываем сохранённые данные…', false);
    return true;
  }

  function stopProbing() {
    if (probeTimer) window.clearInterval(probeTimer);
    probeTimer = 0;
  }

  function probeAdapter() {
    if (!(iframe instanceof HTMLIFrameElement) || !iframe.contentWindow || initialLoadStarted) return;
    iframe.contentWindow.postMessage({ marker: MARKER, type: 'bridge-probe' }, '*');
    probeAttempts += 1;
    if (probeAttempts >= 40) {
      stopProbing();
      showNotice('error', 'Не удалось подключить сохранённые данные к HTML', false);
    }
  }

  const adapterErrors = {
    SNAPSHOT_INPUT_NOT_FOUND: 'В HTML не найдено поле для файла данных',
    SNAPSHOT_INSTALL_FAILED: 'Не удалось подставить сохранённые данные в HTML',
    SNAPSHOT_INVALID: 'Сохранённый файл данных имеет неверный формат',
  };

  window.addEventListener('message', (event) => {
    if (!(iframe instanceof HTMLIFrameElement) || event.source !== iframe.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.marker !== MARKER) return;
    if (data.type === 'adapter-ready') {
      if (!initialLoadStarted) {
        adapterExpectedFormat = data.expectedFormat === 'kts-bundle-v1'
          || data.expectedFormat === 'purchases-v1'
          ? data.expectedFormat
          : '';
        adapterExpectedProfile = data.expectedProfile === 'sales-analytics'
          || data.expectedProfile === 'assortment-optimization'
          || data.expectedProfile === 'purchases'
          ? data.expectedProfile
          : '';
        initialLoadStarted = true;
        stopProbing();
        void loadActiveData(true);
      }
      return;
    }
    if (data.type === 'snapshot-installed') {
      showNotice('success', 'Сохранённые данные переданы в дашборд', true);
      return;
    }
    if (data.type === 'adapter-error') {
      const message = adapterErrors[data.code];
      if (message) showNotice('error', message, false);
      return;
    }
  });

  probeAdapter();
  probeTimer = window.setInterval(probeAdapter, 250);
})();`;
}

export function buildTopDashboardFrameSecurityPolicy(scriptContent: string) {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "frame-src 'self'",
    "child-src 'self'",
    "form-action 'none'",
    "connect-src 'self'",
    `script-src ${sha256Source(scriptContent)}`,
    "style-src 'unsafe-inline'",
  ].join('; ');
}

export function buildTopDashboardContentSecurityPolicy(htmlContent: string) {
  const scriptHashes = Array.from(htmlContent.matchAll(INLINE_SCRIPT_PATTERN), (match) => {
    // HTML tokenization normalizes CRLF before CSP hashes are checked.
    const scriptContent = (match[1] ?? '').replace(/\r\n?/g, '\n');
    return sha256Source(scriptContent);
  });
  const eventHandlerHashes = Array.from(htmlContent.matchAll(INLINE_EVENT_HANDLER_PATTERN), (match) => (
    sha256Source(match[1] ?? match[2] ?? '')
  ));
  const hashes = Array.from(new Set([...scriptHashes, ...eventHandlerHashes]));
  const scriptSource = hashes.length > 0
    ? `${eventHandlerHashes.length > 0 ? "'unsafe-hashes' " : ''}${hashes.join(' ')}`
    : "'none'";

  return [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "form-action 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    `script-src ${scriptSource}`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data: blob:',
    'media-src data: blob:',
    'worker-src blob:',
    "manifest-src 'none'",
    'sandbox allow-scripts allow-popups allow-downloads',
  ].join('; ');
}

export function isTopDashboardBlockFrameRequest(
  request: Request,
  blockId: number,
  versionId: number,
) {
  return isExpectedTopDashboardFrameRequest(
    request,
    `/api/admin/top-dashboard/blocks/${blockId}/versions/${versionId}/frame`,
  );
}

export function getTopDashboardBlockDataFrameVersionId(
  request: Request,
  blockId: number,
): number | null {
  if (request.method !== 'GET') return null;
  if (request.headers.get('sec-fetch-dest') !== 'empty') return null;
  if (request.headers.get('sec-fetch-mode') !== 'cors') return null;
  if (request.headers.get('sec-fetch-site') !== 'same-origin') return null;

  const referer = request.headers.get('referer');
  if (!referer) return null;

  try {
    const refererUrl = new URL(referer);
    const escapedBlockId = String(blockId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expectedPath = new RegExp(
      `^/api/admin/top-dashboard/blocks/${escapedBlockId}/versions/([1-9]\\d*)/frame$`,
    );
    const match = expectedPath.exec(refererUrl.pathname);
    if (!match) return null;
    const versionId = Number(match[1]);
    return Number.isSafeInteger(versionId) ? versionId : null;
  } catch {
    return null;
  }
}

export function isTopDashboardBlockDataFrameRequest(request: Request, blockId: number) {
  return getTopDashboardBlockDataFrameVersionId(request, blockId) !== null;
}

function isExpectedTopDashboardFrameRequest(request: Request, expectedFramePath: string) {
  if (request.headers.get('sec-fetch-dest') !== 'iframe') return false;
  if (request.headers.get('sec-fetch-mode') !== 'navigate') return false;
  if (request.headers.get('sec-fetch-site') !== 'same-origin') return false;

  const referer = request.headers.get('referer');
  if (!referer) return false;

  try {
    const refererUrl = new URL(referer);
    // In production Next.js receives an internal 127.0.0.1 request URL from the
    // reverse proxy, while the browser Referer contains the public origin. The
    // forbidden Sec-Fetch-* headers above prove a same-origin iframe navigation;
    // only the exact trusted shell path needs to be matched here.
    return refererUrl.pathname === expectedFramePath;
  } catch {
    return false;
  }
}
