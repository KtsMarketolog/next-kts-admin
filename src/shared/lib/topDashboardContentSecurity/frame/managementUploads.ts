import { TOP_DASHBOARD_UPLOAD_MAX_DISCOVERED_TARGETS } from '../../topDashboardLimits';

/**
 * Binds management messages to the exact parent and coordinates target discovery and uploads.
 * Uses CONFIG, iframe, snapshot transport, target state and abortable upload state.
 * Emitted into the enclosing runtime's lexical scope; preserve statement order.
 */
export function managementUploadsScript() {
  return String.raw`  function stopProbing() {
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

  function sendManagement(type, extra) {
    if (!CONFIG.canManage) return;
    window.parent.postMessage(Object.assign({
      marker: MANAGEMENT_MARKER, type,
      blockId: CONFIG.blockId, htmlVersionId: CONFIG.htmlVersionId,
    }, extra || {}), window.location.origin);
  }

  function acceptUploadTargets(values, requestId) {
    if (!CONFIG.canManage || !Array.isArray(values) || values.length > ${TOP_DASHBOARD_UPLOAD_MAX_DISCOVERED_TARGETS}) return;
    const indexes = new Set();
    const targets = [];
    for (const entry of values) {
      const target = entry && normalizedMultiFileTarget(entry.target);
      if (!target || indexes.has(target.index)
        || typeof entry.multiple !== 'boolean' || typeof entry.directory !== 'boolean'
        || typeof entry.accept !== 'string' || entry.accept.length > 512
        || typeof entry.label !== 'string' || entry.label.length > 160) return;
      indexes.add(target.index);
      targets.push({ target, multiple: entry.multiple, directory: entry.directory,
        accept: entry.accept, label: entry.label });
    }
    discoveredUploadTargets = targets;
    uploadTargetsKnown = true;
    sendManagement('upload-targets', { targets });
    if (pendingTargetProbe && pendingTargetProbe.requestId === requestId) {
      pendingTargetProbe.resolve();
    }
  }

  function refreshUploadTargets(requestId, signal) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        window.clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (pendingTargetProbe === probe) pendingTargetProbe = null;
      };
      const abort = () => { cleanup(); reject(new Error('Проверка поля загрузки прервана.')); };
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error('Не удалось проверить поле загрузки. Перезагрузите предпросмотр.'));
      }, 5000);
      const probe = { requestId, resolve: () => {
        cleanup();
        resolve();
      } };
      pendingTargetProbe = probe;
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      iframe.contentWindow.postMessage({ marker: MULTI_FILE_MARKER, type: 'probe-upload-targets', requestId }, '*');
    });
  }

  async function uploadManagementFiles(data) {
    const respond = (ok, error, warnings) => sendManagement('upload-result', {
      requestId: data.requestId, ok, ...(error ? { error } : {}),
      ...(warnings && warnings.length ? { warnings } : {}),
    });
    if (typeof data.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(data.requestId)) return;
    if (managementUploadPending || saveLoopRunning) {
      respond(false, 'Уже выполняется загрузка. Дождитесь её завершения.');
      return;
    }
    managementUploadPending = true;
    const controller = new AbortController();
    managementUploadController = controller;
    managementUploadRequestId = data.requestId;
    let previousTargets = null;
    try {
      await snapshotRequest(async (signal) => {
      if (!initialLoadStarted || adapterExpectedFormat !== 'multi-file-v1'
        || adapterExpectedProfile !== 'generic' || !loadPromise || !(await loadPromise)) {
        throw new Error('Предпросмотр ещё не готов к загрузке. Повторите после его открытия.');
      }
      if (data.expectedActiveDataVersionId !== activeDataVersionId) {
        throw new Error('Данные изменились. Обновите страницу перед загрузкой.');
      }
      await refreshUploadTargets(data.requestId, signal);
      if (signal.aborted) throw new Error('Ожидание прервано.');
      previousTargets = multiFileTargets;
      if (!Array.isArray(data.targets) || !data.targets.length
        || data.targets.length > MULTI_FILE_MAX_TARGETS) throw new Error('Не выбраны файлы данных.');
      const replacement = new Map();
      for (const entry of data.targets) {
        const target = entry && normalizedMultiFileTarget(entry.target);
        const files = entry && normalizeSelectedFiles(entry.files);
        const descriptor = target && discoveredUploadTargets.find((candidate) =>
          candidate.target.index === target.index && candidate.target.id === target.id
          && candidate.target.name === target.name);
        if (!target || !files || !descriptor || replacement.has(multiFileTargetKey(target))
          || (!descriptor.multiple && !descriptor.directory && files.length !== 1)
          || (descriptor.directory && files.some((file) => !file.webkitRelativePath))) {
          throw new Error('Поле загрузки изменилось или выбран неверный набор файлов. Выберите файлы заново.');
        }
        replacement.set(multiFileTargetKey(target), { target, files });
      }
      multiFileTargets = replacement;
      showNotice('pending', 'Сохраняем выбранные файлы…', false);
      const saved = await saveCurrentMultiFileData(signal);
      if (!saved) {
        throw new Error('Не удалось подтвердить сохранение. Обновите страницу и проверьте журнал перед повторной загрузкой.');
      }
      showNotice('success', ['Данные сохранены для всех пользователей', ...saved.warnings].join(' '), saved.warnings.length === 0);
      respond(true, null, saved.warnings);
      }, controller.signal);
    } catch (error) {
      if (previousTargets) multiFileTargets = previousTargets;
      respond(false, error instanceof Error ? error.message : 'Не удалось сохранить файлы.');
    } finally {
      managementUploadPending = false;
      managementUploadController = null;
      managementUploadRequestId = null;
    }
  }

  // Only the same-origin management page may request an upper-panel upload.
  // The sandboxed report cannot impersonate its parent or choose an endpoint.
  window.addEventListener('message', (event) => {
    if (CONFIG.localInvoiceMode || !CONFIG.canManage || event.source !== window.parent || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.marker !== MANAGEMENT_MARKER || data.blockId !== CONFIG.blockId
      || data.htmlVersionId !== CONFIG.htmlVersionId) return;
    if (data.type === 'probe-upload-targets') {
      if (uploadTargetsKnown) sendManagement('upload-targets', { targets: discoveredUploadTargets });
      if (iframe instanceof HTMLIFrameElement && iframe.contentWindow) {
        iframe.contentWindow.postMessage({ marker: MULTI_FILE_MARKER, type: 'probe-upload-targets' }, '*');
      }
    } else if (data.type === 'upload-files') {
      void uploadManagementFiles(data);
    } else if (data.type === 'cancel-upload' && data.requestId === managementUploadRequestId) {
      managementUploadController?.abort();
    }
  });

`;
}
