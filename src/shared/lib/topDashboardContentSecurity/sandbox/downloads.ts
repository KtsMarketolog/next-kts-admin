/**
 * Constrains popups to one sandboxed Blob navigation and tracks object URLs.
 * Uses nativeOpen/nativeCreateObjectURL/nativeRevokeObjectURL and the adapter's URL registries.
 * Emitted into the enclosing runtime's lexical scope; preserve statement order.
 */
export function sandboxPopupScript() {
  return String.raw`  window.open = function openSandboxedWindow(url, target, features) {
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

`;
}

/** Relays validated Blob downloads to the trusted frame using its download protocol. */
export function sandboxDownloadScript() {
  return String.raw`  function normalizeDownloadName(value) {
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
      if (window.__ktsDashboardUsage && navigator.userActivation && navigator.userActivation.isActive) window.__ktsDashboardUsage.record('export_started');
      downloadableObjectUrls.delete(this.href);
      nativeRevokeObjectURL(this.href);
    };
  }

`;
}
