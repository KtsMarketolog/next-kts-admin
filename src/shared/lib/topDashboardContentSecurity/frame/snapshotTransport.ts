/**
 * Reads, hydrates and persists version-bound snapshots through the trusted server endpoint.
 * Uses CONFIG, iframe, snapshotRequest, notices, codec and active-version/save-loop state.
 * Emitted into the enclosing runtime's lexical scope; preserve statement order.
 */
export function snapshotTransportScript() {
  return String.raw`  function decodeName(value) {
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
    const responseMaxBytes = snapshotFormat === 'multi-file-v1'
      ? MULTI_FILE_MAX_BYTES
      : MAX_BYTES;
    if (!versionId || !snapshotFormat || !snapshotProfile || !validBuffer(buffer, responseMaxBytes)) {
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

  async function saveCurrentMultiFileData(externalSignal) {
    let blob;
    try {
      blob = encodeMultiFileSnapshot();
    } catch {
      showNotice('error', 'Выбранные файлы превышают допустимый размер или количество', false);
      return false;
    }

    try {
      return await snapshotRequest(async (signal) => {
      const response = await fetch(CONFIG.dataPath, {
        method: 'PUT',
        signal,
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
    if (signal.aborted) throw new Error('Ожидание прервано.');
    const nextVersionId = payload && payload.state && payload.state.activeVersionId;
    if (!Number.isSafeInteger(nextVersionId) || nextVersionId <= 0) {
      showNotice('error', 'Сервер сохранил файлы, но вернул некорректный ответ', false);
      return false;
    }
    activeDataVersionId = nextVersionId;
    return true;
      }, externalSignal);
    } catch {
      showNotice('error', 'Файлы открыты, но подтверждение сохранения не получено. Проверьте историю перед повторной загрузкой.', false);
      return false;
    }
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
    if (managementUploadPending) {
      showNotice('error', 'Дождитесь завершения загрузки из панели управления', false);
      return;
    }
    if (loadPromise && !(await loadPromise)) {
      showNotice('error', 'Не удалось проверить текущую версию сохранённых файлов', false);
      return;
    }
    if (managementUploadPending) return;
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

`;
}
