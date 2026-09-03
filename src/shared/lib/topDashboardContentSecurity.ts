import { createHash } from 'crypto';

import type {
  TopDashboardProfile,
  TopDashboardSnapshotFormat,
} from './db/topDashboardDomain';
import {
  TOP_DASHBOARD_DOWNLOAD_INVALID_NAME_PATTERN_SOURCE,
  TOP_DASHBOARD_DOWNLOAD_MAX_BYTES,
  TOP_DASHBOARD_DOWNLOAD_MAX_NAME_LENGTH,
  TOP_DASHBOARD_DOWNLOAD_MESSAGE_MARKER,
  TOP_DASHBOARD_DOWNLOAD_NAME_PATTERN_SOURCE,
} from './topDashboardDownloadBridge';
import { TOP_DASHBOARD_DATA_MAX_BYTES } from './topDashboardLimits';
import {
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAGIC,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES_PER_TARGET,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_MIME_TYPE_BYTES,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_INPUT_INDEX,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_RELATIVE_PATH_BYTES,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGETS,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_VERSION,
} from './topDashboardMultiFileSnapshot';

const INLINE_SCRIPT_PATTERN = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
const INLINE_EVENT_HANDLER_PATTERN = /\son[a-z][\w:-]*\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const HEAD_OPEN_PATTERN = /<head\b[^>]*>/i;
const DOCTYPE_PATTERN = /<!doctype\b[^>]*>/i;

export const TOP_DASHBOARD_DATA_MESSAGE_MARKER = 'kts-top-dashboard-data-v1';
export const TOP_DASHBOARD_MULTI_FILE_MESSAGE_MARKER =
  'kts-top-dashboard-multi-file-v1';
export { TOP_DASHBOARD_DATA_MAX_BYTES } from './topDashboardLimits';
export const TOP_DASHBOARD_DATA_ADAPTER_ATTRIBUTE = 'data-kts-top-dashboard-data-adapter';

export type TopDashboardDataContract = {
  mode: 'legacy' | 'generic' | 'disabled';
  snapshotFormat: TopDashboardSnapshotFormat | null;
  profile: TopDashboardProfile | null;
};

type TopDashboardLegacyReadyFunction = 'loadState';

function extractClassicFunctionBody(source: string, functionName: string): string | null {
  const declaration = new RegExp(`\\bfunction\\s+${functionName}\\s*\\(`, 'u').exec(source);
  if (!declaration) return null;
  const openingBrace = source.indexOf('{', declaration.index + declaration[0].length);
  if (openingBrace === -1) return null;

  let depth = 1;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openingBrace + 1; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1] ?? '';
    if (lineComment) {
      if (character === '\n' || character === '\r') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openingBrace + 1, index);
    }
  }
  return null;
}

function maskJavaScriptCommentsAndStrings(source: string): string {
  let output = '';
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1] ?? '';
    const masked = character === '\n' || character === '\r' ? character : ' ';
    if (lineComment) {
      output += masked;
      if (character === '\n' || character === '\r') lineComment = false;
      continue;
    }
    if (blockComment) {
      output += masked;
      if (character === '*' && next === '/') {
        output += ' ';
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      output += masked;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '/' && next === '/') {
      output += '  ';
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      output += '  ';
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      output += ' ';
      quote = character;
      continue;
    }
    output += character;
  }
  return output;
}

function hasStandaloneFinalRenderCall(source: string): boolean {
  return /(?:^|[;}])\s*render\s*\(\s*\)\s*;\s*$/u.test(source);
}

export function detectTopDashboardExpectedProfile(
  htmlContent: string,
): TopDashboardProfile | null {
  const hasPurchasesInput =
    /\bid\s*=\s*(?:"snapInp"|'snapInp')/i.test(htmlContent)
    || /\bgetElementById\(\s*(?:"snapInp"|'snapInp')\s*\)/i.test(htmlContent);
  const hasPurchasesSignature =
    /\bPARSERS\s*\.\s*purchases\b/i.test(htmlContent)
    || /(?:<title\b[^>]*>|Дашборд\s*[«"]?)\s*[^<\n]{0,80}Управление\s+закупками/iu.test(htmlContent);
  if (hasPurchasesInput && hasPurchasesSignature) {
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

export function detectTopDashboardDataContract(
  htmlContent: string,
): TopDashboardDataContract {
  const profile = detectTopDashboardExpectedProfile(htmlContent);
  const snapshotFormat = detectTopDashboardExpectedSnapshotFormat(htmlContent);
  if (profile && snapshotFormat) {
    return { mode: 'legacy', snapshotFormat, profile };
  }
  const hasStaticFileInput = /<input\b(?=[^>]*\btype\s*=\s*(?:"file"|'file'|file\b))[^>]*>/iu
    .test(htmlContent);
  const createsInputAtRuntime = /\b(?:document\s*\.\s*)?createElement\s*\(\s*(?:"input"|'input')\s*\)/iu
    .test(htmlContent);
  const assignsRuntimeFileType = /(?:\.\s*type\s*=\s*(?:"file"|'file')|\.\s*setAttribute\s*\(\s*(?:"type"|'type')\s*,\s*(?:"file"|'file')\s*\)|\btype\s*:\s*(?:"file"|'file'))/iu
    .test(htmlContent);
  const hasFileInput = hasStaticFileInput
    || (createsInputAtRuntime && assignsRuntimeFileType);
  return hasFileInput
    ? { mode: 'generic', snapshotFormat: 'multi-file-v1', profile: 'generic' }
    : { mode: 'disabled', snapshotFormat: null, profile: null };
}

function detectTopDashboardLegacyReadyFunction(
  htmlContent: string,
): TopDashboardLegacyReadyFunction | null {
  const isStrategicOverview = /СТРАТЕГИЧЕСКИЙ\s+ОБЗОР\s+ГРУППЫ/iu.test(htmlContent);
  const loadStateBody = extractClassicFunctionBody(htmlContent, 'loadState');
  const openFileBody = extractClassicFunctionBody(htmlContent, 'openFile');
  const loadStateCode = loadStateBody
    ? maskJavaScriptCommentsAndStrings(loadStateBody).trim()
    : '';
  const openFileCode = openFileBody
    ? maskJavaScriptCommentsAndStrings(openFileBody)
    : '';
  const hasSynchronousLoadState = hasStandaloneFinalRenderCall(loadStateCode);
  const opensThroughLoadState = /\bloadState\s*\(\s*[A-Za-z_$][\w$]*\s*\)\s*;/u.test(openFileCode);
  return isStrategicOverview && hasSynchronousLoadState && opensThroughLoadState
    ? 'loadState'
    : null;
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
  legacyReadyFunction: TopDashboardLegacyReadyFunction | null = null,
) {
  const expectedFormatJson = JSON.stringify(expectedFormat);
  const expectedProfileJson = JSON.stringify(expectedProfile);
  const readOnlyJson = JSON.stringify(readOnly);
  const legacyReadyFunctionJson = JSON.stringify(legacyReadyFunction);
  return String.raw`(() => {
  'use strict';
  const MARKER = '${TOP_DASHBOARD_DATA_MESSAGE_MARKER}';
  const MULTI_FILE_MARKER = '${TOP_DASHBOARD_MULTI_FILE_MESSAGE_MARKER}';
  const MAX_BYTES = ${TOP_DASHBOARD_DATA_MAX_BYTES};
  const EXPECTED_FORMAT = ${expectedFormatJson};
  const EXPECTED_PROFILE = ${expectedProfileJson};
  const MULTI_FILE_MODE = EXPECTED_FORMAT === 'multi-file-v1' && EXPECTED_PROFILE === 'generic';
  const READ_ONLY = ${readOnlyJson};
  const LEGACY_READY_FUNCTION = ${legacyReadyFunctionJson};
  const RESTORE_START_EVENT = 'kts-top-dashboard-restore-start';
  const RESTORE_READY_EVENT = 'kts-top-dashboard-data-ready';
  const RESTORE_DOM_QUIET_MS = 1000;
  const RESTORE_TIMEOUT_MS = 120000;
  const MULTI_INPUT_DISPATCH_GAP_MS = 150;
  const DOWNLOAD_MARKER = '${TOP_DASHBOARD_DOWNLOAD_MESSAGE_MARKER}';
  const DOWNLOAD_MAX_BYTES = ${TOP_DASHBOARD_DOWNLOAD_MAX_BYTES};
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

  URL.createObjectURL = function createTrackedObjectURL(value) {
    const objectUrl = nativeCreateObjectURL(value);
    if (value instanceof Blob) downloadableObjectUrls.set(objectUrl, value);
    return objectUrl;
  };

  URL.revokeObjectURL = function revokeTrackedObjectURL(value) {
    downloadableObjectUrls.delete(String(value));
    return nativeRevokeObjectURL(value);
  };

  window.addEventListener('pagehide', () => {
    popupObjectUrls.forEach((objectUrl) => URL.revokeObjectURL(objectUrl));
    popupObjectUrls.clear();
    downloadableObjectUrls.clear();
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

  function normalizeDownloadName(value) {
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

  const anchorPrototype = window.HTMLAnchorElement && window.HTMLAnchorElement.prototype;
  const nativeAnchorClick = anchorPrototype && anchorPrototype.click;
  if (anchorPrototype && typeof nativeAnchorClick === 'function') {
    anchorPrototype.click = function clickSandboxedDownload() {
      const blob = downloadableObjectUrls.get(this.href);
      if (!blob) return nativeAnchorClick.call(this);
      const name = normalizeDownloadName(this.download);
      if (!name || !validDownloadBlob(blob)) {
        downloadableObjectUrls.delete(this.href);
        nativeRevokeObjectURL(this.href);
        report('DOWNLOAD_INVALID');
        return;
      }
      window.parent.postMessage(
        { marker: DOWNLOAD_MARKER, type: 'download-request', name, blob },
        '*',
      );
      downloadableObjectUrls.delete(this.href);
      nativeRevokeObjectURL(this.href);
    };
  }

  function report(code, extra) {
    send('adapter-error', Object.assign({ code }, extra || {}));
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

  function allFileInputs() {
    return Array.from(document.querySelectorAll('input[type="file"]')).filter(isFileInput);
  }

  function uniqueInputText(inputs, input, property) {
    const value = input[property];
    if (typeof value !== 'string' || !value || value !== value.trim()) return null;
    return inputs.filter((candidate) => candidate[property] === value).length === 1
      ? value
      : null;
  }

  function multiFileTarget(input) {
    const inputs = allFileInputs();
    const index = inputs.indexOf(input);
    if (index < 0 || index > ${TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_INPUT_INDEX}) return null;
    return {
      id: uniqueInputText(inputs, input, 'id'),
      name: uniqueInputText(inputs, input, 'name'),
      index,
    };
  }

  function fileInputForDropTarget(value) {
    if (isFileInput(value)) return value;
    if (!(value instanceof Element)) return null;

    const explicitOwner = value.closest('label[for],[data-file-input],[data-input],[aria-controls]');
    if (explicitOwner) {
      const reference = explicitOwner.getAttribute('for')
        || explicitOwner.getAttribute('data-file-input')
        || explicitOwner.getAttribute('data-input')
        || explicitOwner.getAttribute('aria-controls');
      const referencedInput = reference ? document.getElementById(reference) : null;
      if (isFileInput(referencedInput)) return referencedInput;
    }

    let container = value;
    while (container && container !== document.documentElement) {
      const containedInputs = Array.from(container.querySelectorAll('input[type="file"]'))
        .filter(isFileInput);
      if (containedInputs.length === 1) return containedInputs[0];
      if (containedInputs.length > 1) break;
      container = container.parentElement;
    }

    const inputs = allFileInputs();
    return inputs.length === 1 ? inputs[0] : null;
  }

  function captureMultiFiles(input, sourceFiles) {
    const target = multiFileTarget(input);
    const files = Array.from(sourceFiles || []);
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    if (
      !target
      || files.length === 0
      || files.length > ${TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES_PER_TARGET}
      || totalBytes <= 0
      || totalBytes > MAX_BYTES
    ) {
      report('MULTI_FILE_SELECTION_INVALID');
      return;
    }
    window.parent.postMessage(
      {
        marker: MULTI_FILE_MARKER,
        type: 'files-selected',
        target,
        merge: input.multiple || input.hasAttribute('webkitdirectory'),
        files: files.map((file) => ({
          name: file.name,
          type: file.type || '',
          lastModified: file.lastModified,
          webkitRelativePath: typeof file.webkitRelativePath === 'string'
            ? file.webkitRelativePath
            : '',
          blob: file,
        })),
      },
      '*',
    );
  }

  function captureMultiFileSelection(event) {
    if (!MULTI_FILE_MODE || READ_ONLY || !event.isTrusted || !isFileInput(event.target)) return;
    captureMultiFiles(event.target, event.target.files);
  }

  function captureMultiFileDrop(event) {
    if (!MULTI_FILE_MODE || READ_ONLY || !event.isTrusted) return;
    const transfer = event.dataTransfer;
    if (!transfer || transfer.files.length === 0) return;
    const input = fileInputForDropTarget(event.target);
    if (!input) {
      report('MULTI_FILE_DROP_TARGET_NOT_FOUND');
      return;
    }
    // Observe the trusted drop without cancelling it. The dashboard's own
    // capture/bubble handlers still receive the original DataTransfer.
    captureMultiFiles(input, transfer.files);
  }

  function matchesMultiFileTarget(input, target) {
    const inputs = allFileInputs();
    if (target.id && uniqueInputText(inputs, input, 'id') === target.id) return true;
    if (target.name && uniqueInputText(inputs, input, 'name') === target.name) return true;
    return inputs[target.index] === input;
  }

  async function waitForMultiFileInput(target) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const input = allFileInputs().find((candidate) => matchesMultiFileTarget(candidate, target));
      if (input) return input;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    return null;
  }

  function restoreRelativePath(file, value) {
    if (!value) return;
    try {
      Object.defineProperty(file, 'webkitRelativePath', {
        configurable: true,
        enumerable: true,
        value,
      });
    } catch {}
  }

  function validRestoreId(value) {
    return Number.isSafeInteger(value) && value > 0;
  }

  function waitForDashboardPaint() {
    return new Promise((resolve) => {
      let completed = false;
      const finish = () => {
        if (completed) return;
        completed = true;
        window.clearTimeout(fallbackTimer);
        resolve();
      };
      const fallbackTimer = window.setTimeout(finish, 500);
      try {
        window.requestAnimationFrame(() => window.requestAnimationFrame(finish));
      } catch {
        finish();
      }
    });
  }

  function waitForDashboardProcessing(trigger, restoreId, fileCount, onDomQuiet) {
    return new Promise((resolve, reject) => {
      const root = document.body || document.documentElement;
      let completed = false;
      let triggerCompleted = false;
      let explicitReady = false;
      let domQuiet = false;
      let domQuietReported = false;
      let quietTimer = 0;

      const cleanup = () => {
        observer.disconnect();
        window.removeEventListener(RESTORE_READY_EVENT, handleExplicitReady);
        if (quietTimer) window.clearTimeout(quietTimer);
        window.clearTimeout(timeoutTimer);
      };
      const complete = (confirmation) => {
        if (completed) return;
        completed = true;
        cleanup();
        resolve(confirmation);
      };
      const confirmAfterPaint = () => {
        void waitForDashboardPaint().then(() => {
          if (completed) return;
          complete('event');
        });
      };
      const reportDomQuietIfReady = () => {
        if (!triggerCompleted || !domQuiet || domQuietReported || completed) return;
        domQuietReported = true;
        try { onDomQuiet(); } catch {}
      };
      const confirmIfReady = () => {
        if (!triggerCompleted || completed) return;
        if (explicitReady) {
          confirmAfterPaint();
        }
      };
      const handleExplicitReady = (event) => {
        const detail = event && event.detail;
        if (!detail || detail.restoreId !== restoreId) return;
        explicitReady = true;
        confirmIfReady();
      };
      const observer = new MutationObserver(() => {
        domQuiet = false;
        if (quietTimer) window.clearTimeout(quietTimer);
        quietTimer = window.setTimeout(() => {
          domQuiet = true;
          reportDomQuietIfReady();
        }, RESTORE_DOM_QUIET_MS);
      });
      const timeoutTimer = window.setTimeout(() => complete(null), RESTORE_TIMEOUT_MS);

      window.addEventListener(RESTORE_READY_EVENT, handleExplicitReady);
      observer.observe(root, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });

      try {
        window.dispatchEvent(new CustomEvent(RESTORE_START_EVENT, {
          detail: { restoreId, fileCount },
        }));
        installLegacyReadyHook(restoreId);
        Promise.resolve(trigger()).then(() => {
          triggerCompleted = true;
          confirmIfReady();
          reportDomQuietIfReady();
        }).catch((error) => {
          if (!completed) {
            completed = true;
            cleanup();
          }
          reject(error);
        });
      } catch (error) {
        if (!completed) {
          completed = true;
          cleanup();
        }
        reject(error);
      }
    });
  }

  async function installMultiFileSnapshot(targets, restoreId) {
    if (multiFileRestorePending) return;
    multiFileRestorePending = true;
    let installedFiles = 0;
    try {
      if (
        !validRestoreId(restoreId)
        || !Array.isArray(targets)
        || targets.length === 0
        || targets.length > ${TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGETS}
      ) {
        throw new Error('invalid targets');
      }
      const restoredInputs = [];
      for (const entry of targets) {
        if (!entry || typeof entry !== 'object' || !entry.target || !Array.isArray(entry.files)) {
          throw new Error('invalid target');
        }
        const input = await waitForMultiFileInput(entry.target);
        if (!input) throw new Error('missing input');
        const transfer = new DataTransfer();
        for (const candidate of entry.files) {
          const name = candidate && typeof candidate.name === 'string' ? candidate.name : '';
          const blob = candidate && candidate.blob;
          if (!name || !(blob instanceof Blob) || blob.size <= 0 || blob.size > MAX_BYTES) {
            throw new Error('invalid file');
          }
          const type = candidate && typeof candidate.type === 'string' ? candidate.type : '';
          const lastModified = candidate && Number.isSafeInteger(candidate.lastModified)
            && candidate.lastModified >= 0
            ? candidate.lastModified
            : 0;
          const relativePath = candidate && typeof candidate.webkitRelativePath === 'string'
            ? candidate.webkitRelativePath
            : '';
          const restoredFile = new File([blob], name, { type, lastModified });
          restoreRelativePath(restoredFile, relativePath);
          transfer.items.add(restoredFile);
          installedFiles += 1;
        }
        input.files = transfer.files;
        entry.files.forEach((candidate, index) => {
          const installedFile = input.files && input.files[index];
          if (installedFile && candidate && typeof candidate.webkitRelativePath === 'string') {
            restoreRelativePath(installedFile, candidate.webkitRelativePath);
          }
        });
        restoredInputs.push(input);
      }
      window.parent.postMessage(
        {
          marker: MULTI_FILE_MARKER,
          type: 'files-processing',
          restoreId,
          fileCount: installedFiles,
        },
        '*',
      );
      const confirmation = await waitForDashboardProcessing(() => {
        return restoredInputs.reduce((chain, input, index) => chain.then(async () => {
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          if (index + 1 < restoredInputs.length) {
            await new Promise((resolve) => {
              window.setTimeout(resolve, MULTI_INPUT_DISPATCH_GAP_MS);
            });
          }
        }), Promise.resolve());
      }, restoreId, installedFiles, () => {
        window.parent.postMessage(
          {
            marker: MULTI_FILE_MARKER,
            type: 'files-processing-unconfirmed',
            restoreId,
            fileCount: installedFiles,
          },
          '*',
        );
      });
      lockFileInputs();
      window.parent.postMessage(
        {
          marker: MULTI_FILE_MARKER,
          type: confirmation ? 'files-installed' : 'files-delivered-unconfirmed',
          restoreId,
          fileCount: installedFiles,
          confirmation,
        },
        '*',
      );
    } catch {
      report('MULTI_FILE_INSTALL_FAILED', { restoreId });
    } finally {
      multiFileRestorePending = false;
    }
  }

  if (MULTI_FILE_MODE && !READ_ONLY) {
    document.addEventListener('change', captureMultiFileSelection, true);
    document.addEventListener('drop', captureMultiFileDrop, true);
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
    if (!data || typeof data !== 'object') return;
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
    send('adapter-ready', {
      expectedFormat: EXPECTED_FORMAT,
      expectedProfile: EXPECTED_PROFILE,
      multiFileMode: MULTI_FILE_MODE,
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
  const contract = detectTopDashboardDataContract(htmlContent);
  const expectedFormat = contract.snapshotFormat;
  const expectedProfile = contract.profile;
  const legacyReadyFunction = detectTopDashboardLegacyReadyFunction(htmlContent);
  const adapter = `<script ${TOP_DASHBOARD_DATA_ADAPTER_ATTRIBUTE}>${getTopDashboardDataAdapterScript(expectedFormat, expectedProfile, options.readOnly === true, legacyReadyFunction)}</script>`;
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

export function createTopDashboardFrameBridgeScript(
  blockId: number,
  htmlVersionId: number,
  canManage: boolean,
) {
  const config = JSON.stringify({
    dataPath: `/api/admin/top-dashboard/blocks/${blockId}/data`,
    htmlVersionId,
    canManage,
  });

  return String.raw`(() => {
  'use strict';
  const CONFIG = ${config};
  const MARKER = '${TOP_DASHBOARD_DATA_MESSAGE_MARKER}';
  const MULTI_FILE_MARKER = '${TOP_DASHBOARD_MULTI_FILE_MESSAGE_MARKER}';
  const MAX_BYTES = ${TOP_DASHBOARD_DATA_MAX_BYTES};
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

  function hideNotice() {
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

  function validBuffer(value) {
    return value instanceof ArrayBuffer
      && value.byteLength > 0
      && value.byteLength <= MAX_BYTES;
  }

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder('utf-8', { fatal: true });
  const unsafeFileName = /[\/\\\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
  const unsafeTargetText = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
  const unsafeRelativePath = /[\\\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
  const mimeTypePattern = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u;

  function safeFileName(value) {
    if (typeof value !== 'string') return '';
    let name;
    try { name = value.normalize('NFC').trim(); } catch { return ''; }
    if (!name || name === '.' || name === '..' || unsafeFileName.test(name)) return '';
    return textEncoder.encode(name).byteLength <= 255 ? name : '';
  }

  function safeTargetText(value) {
    if (value == null || value === '') return null;
    if (typeof value !== 'string') return undefined;
    let normalized;
    try { normalized = value.normalize('NFC'); } catch { return undefined; }
    if (
      !normalized
      || normalized !== normalized.trim()
      || unsafeTargetText.test(normalized)
      || textEncoder.encode(normalized).byteLength > 512
    ) return undefined;
    return normalized;
  }

  function safeMimeType(value) {
    if (value == null || value === '') return '';
    if (
      typeof value !== 'string'
      || value !== value.trim()
      || !mimeTypePattern.test(value)
      || textEncoder.encode(value).byteLength > MULTI_FILE_MAX_MIME_BYTES
    ) return undefined;
    return value;
  }

  function safeRelativePath(value, fileName) {
    if (value == null || value === '') return '';
    if (typeof value !== 'string') return undefined;
    let normalized;
    try { normalized = value.normalize('NFC'); } catch { return undefined; }
    const segments = normalized.split('/');
    if (
      normalized !== normalized.trim()
      || normalized.startsWith('/')
      || normalized.endsWith('/')
      || unsafeRelativePath.test(normalized)
      || segments.some((segment) => !segment || segment === '.' || segment === '..')
      || segments[segments.length - 1] !== fileName
      || textEncoder.encode(normalized).byteLength > MULTI_FILE_MAX_PATH_BYTES
    ) return undefined;
    return normalized;
  }

  function normalizedMultiFileTarget(value) {
    if (!value || typeof value !== 'object') return null;
    const index = value.index;
    const id = safeTargetText(value.id);
    const name = safeTargetText(value.name);
    if (
      !Number.isInteger(index)
      || index < 0
      || index > ${TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_INPUT_INDEX}
      || id === undefined
      || name === undefined
    ) return null;
    return { id, name, index };
  }

  function multiFileTargetKey(target) {
    if (target.id) return 'id:' + target.id;
    if (target.name) return 'name:' + target.name;
    return 'index:' + target.index;
  }

  function normalizeSelectedFiles(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > MULTI_FILE_MAX_FILES_PER_TARGET) {
      return null;
    }
    const identities = new Set();
    const files = [];
    let total = 0;
    for (const candidate of value) {
      const blob = candidate instanceof Blob ? candidate : candidate && candidate.blob;
      const name = safeFileName(candidate && candidate.name);
      const type = safeMimeType(candidate && candidate.type);
      const relativePath = safeRelativePath(candidate && candidate.webkitRelativePath, name);
      const lastModified = candidate && Number.isSafeInteger(candidate.lastModified)
        && candidate.lastModified >= 0
        ? candidate.lastModified
        : 0;
      const identity = relativePath || name;
      if (
        !name
        || type === undefined
        || relativePath === undefined
        || identities.has(identity)
        || !(blob instanceof Blob)
        || blob.size <= 0
      ) return null;
      identities.add(identity);
      total += blob.size;
      if (total > MAX_BYTES) return null;
      files.push({ name, type, lastModified, webkitRelativePath: relativePath, blob });
    }
    return files;
  }

  function encodeMultiFileSnapshot(sourceTargets) {
    const targets = Array.from((sourceTargets || multiFileTargets).values())
      .sort((a, b) => a.target.index - b.target.index);
    if (targets.length === 0 || targets.length > MULTI_FILE_MAX_TARGETS) throw new Error('invalid targets');
    const prepared = [];
    let totalLength = 24;
    let totalFiles = 0;
    for (const entry of targets) {
      const target = normalizedMultiFileTarget(entry.target);
      const files = normalizeSelectedFiles(entry.files);
      if (!target || !files) throw new Error('invalid target');
      const idBytes = target.id ? textEncoder.encode(target.id) : new Uint8Array(0);
      const targetNameBytes = target.name ? textEncoder.encode(target.name) : new Uint8Array(0);
      totalFiles += files.length;
      if (totalFiles > MULTI_FILE_MAX_FILES) throw new Error('too many files');
      totalLength += 12 + idBytes.byteLength + targetNameBytes.byteLength;
      const preparedFiles = [];
      for (const file of files) {
        const fileNameBytes = textEncoder.encode(file.name);
        const mimeTypeBytes = textEncoder.encode(file.type);
        const relativePathBytes = textEncoder.encode(file.webkitRelativePath);
        totalLength += 20
          + fileNameBytes.byteLength
          + mimeTypeBytes.byteLength
          + relativePathBytes.byteLength
          + file.blob.size;
        if (totalLength > MAX_BYTES) throw new Error('too large');
        preparedFiles.push({ ...file, fileNameBytes, mimeTypeBytes, relativePathBytes });
      }
      prepared.push({ target, idBytes, targetNameBytes, files: preparedFiles });
    }

    const header = new Uint8Array(24);
    header.set(textEncoder.encode(MULTI_FILE_MAGIC), 0);
    const headerView = new DataView(header.buffer);
    headerView.setUint16(8, MULTI_FILE_VERSION, false);
    headerView.setUint32(12, totalLength, false);
    headerView.setUint16(16, prepared.length, false);
    headerView.setUint32(20, totalFiles, false);
    const parts = [header];
    for (const entry of prepared) {
      const targetHeader = new Uint8Array(12);
      const targetView = new DataView(targetHeader.buffer);
      targetView.setUint32(0, entry.target.index, false);
      targetView.setUint16(4, entry.idBytes.byteLength, false);
      targetView.setUint16(6, entry.targetNameBytes.byteLength, false);
      targetView.setUint16(8, entry.files.length, false);
      parts.push(targetHeader, entry.idBytes, entry.targetNameBytes);
      for (const file of entry.files) {
        const fileHeader = new Uint8Array(20);
        const fileView = new DataView(fileHeader.buffer);
        fileView.setUint16(0, file.fileNameBytes.byteLength, false);
        fileView.setUint16(2, file.mimeTypeBytes.byteLength, false);
        fileView.setUint16(4, file.relativePathBytes.byteLength, false);
        fileView.setUint32(8, file.blob.size, false);
        fileView.setUint32(12, Math.floor(file.lastModified / 0x100000000), false);
        fileView.setUint32(16, file.lastModified % 0x100000000, false);
        parts.push(
          fileHeader,
          file.fileNameBytes,
          file.mimeTypeBytes,
          file.relativePathBytes,
          file.blob,
        );
      }
    }
    const blob = new Blob(parts, { type: 'application/octet-stream' });
    if (blob.size !== totalLength) throw new Error('invalid length');
    return blob;
  }

  function decodeMultiFileSnapshot(buffer) {
    if (!validBuffer(buffer) || buffer.byteLength < 24) throw new Error('invalid buffer');
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    if (textDecoder.decode(bytes.subarray(0, 8)) !== MULTI_FILE_MAGIC) throw new Error('invalid magic');
    if (
      view.getUint16(8, false) !== MULTI_FILE_VERSION
      || view.getUint16(10, false) !== 0
      || view.getUint32(12, false) !== buffer.byteLength
      || view.getUint16(18, false) !== 0
    ) throw new Error('invalid header');
    const targetCount = view.getUint16(16, false);
    const declaredFileCount = view.getUint32(20, false);
    if (
      targetCount <= 0
      || targetCount > MULTI_FILE_MAX_TARGETS
      || declaredFileCount <= 0
      || declaredFileCount > MULTI_FILE_MAX_FILES
    ) throw new Error('invalid count');

    let offset = 24;
    let fileCount = 0;
    const targets = [];
    const indexes = new Set();
    const ids = new Set();
    const readText = (length) => {
      if (length < 0 || offset + length > bytes.byteLength) throw new Error('truncated');
      const value = textDecoder.decode(bytes.subarray(offset, offset + length));
      offset += length;
      return value;
    };
    for (let targetNumber = 0; targetNumber < targetCount; targetNumber += 1) {
      if (offset + 12 > bytes.byteLength) throw new Error('truncated');
      const index = view.getUint32(offset, false);
      const idLength = view.getUint16(offset + 4, false);
      const nameLength = view.getUint16(offset + 6, false);
      const perTargetFiles = view.getUint16(offset + 8, false);
      const reserved = view.getUint16(offset + 10, false);
      offset += 12;
      if (
        reserved !== 0
        || index > ${TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_INPUT_INDEX}
        || indexes.has(index)
        || idLength > 512
        || nameLength > 512
        || perTargetFiles <= 0
        || perTargetFiles > MULTI_FILE_MAX_FILES_PER_TARGET
      ) throw new Error('invalid target');
      indexes.add(index);
      const id = idLength ? safeTargetText(readText(idLength)) : null;
      const name = nameLength ? safeTargetText(readText(nameLength)) : null;
      if (id === undefined || name === undefined || (id && ids.has(id))) throw new Error('invalid target');
      if (id) ids.add(id);
      const files = [];
      const fileIdentities = new Set();
      for (let fileNumber = 0; fileNumber < perTargetFiles; fileNumber += 1) {
        if (offset + 20 > bytes.byteLength) throw new Error('truncated');
        const fileNameLength = view.getUint16(offset, false);
        const mimeTypeLength = view.getUint16(offset + 2, false);
        const relativePathLength = view.getUint16(offset + 4, false);
        const fileReserved = view.getUint16(offset + 6, false);
        const contentLength = view.getUint32(offset + 8, false);
        const lastModified = view.getUint32(offset + 12, false) * 0x100000000
          + view.getUint32(offset + 16, false);
        offset += 20;
        if (
          fileReserved !== 0
          || fileNameLength <= 0
          || fileNameLength > 255
          || mimeTypeLength > MULTI_FILE_MAX_MIME_BYTES
          || relativePathLength > MULTI_FILE_MAX_PATH_BYTES
          || contentLength <= 0
          || !Number.isSafeInteger(lastModified)
        ) {
          throw new Error('invalid file');
        }
        const fileName = safeFileName(readText(fileNameLength));
        const type = safeMimeType(mimeTypeLength ? readText(mimeTypeLength) : '');
        const relativePath = safeRelativePath(
          relativePathLength ? readText(relativePathLength) : '',
          fileName,
        );
        const identity = relativePath || fileName;
        if (
          !fileName
          || type === undefined
          || relativePath === undefined
          || fileIdentities.has(identity)
          || offset + contentLength > bytes.byteLength
        ) {
          throw new Error('invalid file');
        }
        fileIdentities.add(identity);
        const blob = new Blob([bytes.subarray(offset, offset + contentLength)], { type });
        offset += contentLength;
        files.push({
          name: fileName,
          type,
          lastModified,
          webkitRelativePath: relativePath,
          blob,
        });
        fileCount += 1;
      }
      targets.push({ target: { id, name, index }, files });
    }
    if (fileCount !== declaredFileCount || offset !== bytes.byteLength) throw new Error('invalid length');
    return targets;
  }

  function normalizeDownloadName(value) {
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
    return value === 'kts-bundle-v1' || value === 'purchases-v1' || value === 'multi-file-v1'
      ? value
      : '';
  }

  function responseProfile(response) {
    const value = response.headers.get('X-Top-Dashboard-Data-Profile') || '';
    return value === 'sales-analytics'
      || value === 'assortment-optimization'
      || value === 'purchases'
      || value === 'generic'
      ? value
      : '';
  }

  function responseBoundHtmlVersion(response) {
    const value = response.headers.get('X-Top-Dashboard-Data-Bound-Html-Version-Id') || '';
    return /^[1-9]\d*$/.test(value) ? Number(value) : null;
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

  function postMultiFileSnapshot(targets, restoreId) {
    if (!(iframe instanceof HTMLIFrameElement) || !iframe.contentWindow) return false;
    iframe.contentWindow.postMessage(
      { marker: MULTI_FILE_MARKER, type: 'restore-files', restoreId, targets },
      '*',
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

  async function prefetchActiveData() {
    showNotice('pending', 'Загружаем сохранённые данные…', false);
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
      hideNotice();
      return { kind: 'empty' };
    }
    if (!response.ok) {
      showNotice('error', await responseError(response, 'Не удалось загрузить сохранённые данные'), false);
      return { kind: 'error' };
    }

    const versionId = responseVersion(response);
    const snapshotFormat = responseFormat(response);
    const snapshotProfile = responseProfile(response);
    const buffer = await response.arrayBuffer().catch(() => null);
    if (!versionId || !snapshotFormat || !snapshotProfile || !validBuffer(buffer)) {
      showNotice('error', 'Сохранённый файл данных повреждён или слишком большой', false);
      return { kind: 'error' };
    }

    if (snapshotFormat === 'multi-file-v1' && snapshotProfile === 'generic') {
      if (responseBoundHtmlVersion(response) !== CONFIG.htmlVersionId) {
        showNotice('error', 'Сохранённые файлы относятся к другой версии HTML', false);
        return { kind: 'error' };
      }
      showNotice('pending', 'Распаковываем сохранённые данные…', false);
      await waitForNoticePaint();
      let targets;
      try {
        targets = decodeMultiFileSnapshot(buffer);
      } catch {
        showNotice('error', 'Сохранённый набор файлов повреждён или слишком большой', false);
        return { kind: 'error' };
      }
      return {
        kind: 'generic',
        versionId: Number(versionId),
        snapshotFormat,
        snapshotProfile,
        targets,
      };
    }

    const name = responseName(response);
    if (!name) {
      showNotice('error', 'Сохранённый файл данных повреждён или слишком большой', false);
      return { kind: 'error' };
    }
    return {
      kind: 'legacy',
      versionId: Number(versionId),
      snapshotFormat,
      snapshotProfile,
      name,
      buffer,
    };
  }

  async function installPrefetchedData(prefetched) {
    if (!prefetched || prefetched.kind === 'error') return false;
    if (prefetched.kind === 'empty') {
      activeDataVersionId = null;
      multiFileTargets = new Map();
      return true;
    }
    if (
      (adapterExpectedFormat && adapterExpectedFormat !== prefetched.snapshotFormat)
      || (adapterExpectedProfile && adapterExpectedProfile !== prefetched.snapshotProfile)
    ) {
      showNotice('error', 'Сохранённые данные не подходят для этой HTML-страницы', false);
      return false;
    }

    activeDataVersionId = prefetched.versionId;
    if (prefetched.kind === 'generic') {
      multiFileTargets = new Map(
        prefetched.targets.map((entry) => [multiFileTargetKey(entry.target), entry]),
      );
      restoreSequence += 1;
      activeRestoreId = restoreSequence;
      showNotice('pending', 'Строим отчёт…', false);
      if (!postMultiFileSnapshot(prefetched.targets, activeRestoreId)) {
        showNotice('error', 'Не удалось передать сохранённые файлы в HTML', false);
        return false;
      }
      return true;
    }

    showNotice('pending', 'Открываем сохранённые данные…', false);
    if (!postSnapshot(prefetched.name, prefetched.buffer)) {
      showNotice('error', 'Не удалось передать сохранённые данные в HTML', false);
      return false;
    }
    return true;
  }

  async function saveCurrentMultiFileData() {
    let blob;
    try {
      blob = encodeMultiFileSnapshot();
    } catch {
      showNotice('error', 'Выбранные файлы превышают допустимый размер или количество', false);
      return false;
    }

    let response;
    try {
      response = await fetch(CONFIG.dataPath, {
        method: 'PUT',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'X-KTS-Top-Dashboard-Multi-File': '1',
          'X-KTS-TOP-Data-Upload': '1',
          'X-KTS-Top-Data-Protocol': 'stream-v1',
          'X-KTS-Top-Data-Expected-Version': activeDataVersionId === null
            ? 'none'
            : String(activeDataVersionId),
          'X-KTS-Top-HTML-Version': String(CONFIG.htmlVersionId),
        },
        body: blob,
      });
    } catch {
      showNotice('error', 'Файлы открыты, но не сохранены на сервере', false);
      return false;
    }

    if (!response.ok) {
      showNotice(
        'error',
        await responseError(response, 'Файлы открыты, но не сохранены на сервере'),
        false,
      );
      return false;
    }
    let payload;
    try { payload = await response.json(); } catch { payload = null; }
    const nextVersionId = payload && payload.state && payload.state.activeVersionId;
    if (!Number.isSafeInteger(nextVersionId) || nextVersionId <= 0) {
      showNotice('error', 'Сервер сохранил файлы, но вернул некорректный ответ', false);
      return false;
    }
    activeDataVersionId = nextVersionId;
    return true;
  }

  async function runMultiFileSaveLoop() {
    if (saveLoopRunning) return;
    saveLoopRunning = true;
    try {
      while (saveCompleted < saveRequested) {
        const requestedRevision = saveRequested;
        showNotice('pending', 'Сохраняем выбранные файлы…', false);
        const saved = await saveCurrentMultiFileData();
        if (!saved) {
          saveCompleted = saveRequested;
          return;
        }
        saveCompleted = requestedRevision;
      }
      const fileCount = Array.from(multiFileTargets.values())
        .reduce((total, entry) => total + entry.files.length, 0);
      showNotice('success', fileCount + ' файл(ов) сохранено для всех пользователей', true);
    } finally {
      saveLoopRunning = false;
      if (saveCompleted < saveRequested) void runMultiFileSaveLoop();
    }
  }

  async function acceptMultiFileSelection(data) {
    if (!CONFIG.canManage || adapterExpectedFormat !== 'multi-file-v1' || adapterExpectedProfile !== 'generic') {
      return;
    }
    if (loadPromise && !(await loadPromise)) {
      showNotice('error', 'Не удалось проверить текущую версию сохранённых файлов', false);
      return;
    }
    const target = normalizedMultiFileTarget(data.target);
    const files = normalizeSelectedFiles(data.files);
    if (!target || !files) {
      showNotice('error', 'HTML передал недопустимый набор файлов', false);
      return;
    }
    const key = multiFileTargetKey(target);
    const current = multiFileTargets.get(key);
    const merge = data.merge === true;
    if (data.merge !== true && data.merge !== false) {
      showNotice('error', 'HTML передал некорректный режим выбора файлов', false);
      return;
    }
    const mergedByIdentity = new Map();
    const fileIdentity = (file) => file.webkitRelativePath || file.name;
    if (merge) {
      for (const file of current ? current.files : []) {
        mergedByIdentity.set(fileIdentity(file), file);
      }
    }
    // Single-file inputs replace their previous snapshot. Multiple/folder
    // inputs merge sequential selections; a newer identical path replaces it.
    for (const file of files) mergedByIdentity.set(fileIdentity(file), file);
    const mergedFiles = normalizeSelectedFiles(Array.from(mergedByIdentity.values()));
    if (!mergedFiles) {
      showNotice('error', 'Для одного поля выбрано слишком много файлов', false);
      return;
    }
    const nextTargets = new Map(multiFileTargets);
    nextTargets.set(key, { target, files: mergedFiles });
    try {
      encodeMultiFileSnapshot(nextTargets);
    } catch {
      showNotice('error', 'Выбранные файлы превышают допустимый размер или количество', false);
      return;
    }
    multiFileTargets = nextTargets;
    saveRequested += 1;
    void runMultiFileSaveLoop();
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
    if (data.marker === MULTI_FILE_MARKER) {
      if (data.type === 'files-selected') {
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

  prefetchPromise = prefetchActiveData();
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
    'sandbox allow-scripts allow-popups',
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
  return getTopDashboardBlockDataRequestFrameVersionId(request, blockId);
}

export function isTopDashboardBlockDataMutationFrameRequest(
  request: Request,
  blockId: number,
  htmlVersionId: number,
) {
  if (request.method !== 'PUT') return false;
  return getTopDashboardBlockDataRequestFrameVersionId(request, blockId) === htmlVersionId;
}

function getTopDashboardBlockDataRequestFrameVersionId(
  request: Request,
  blockId: number,
): number | null {
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
