const STORAGE_PATH = '/uploads/client-documents';

function isWithin(pathname: string, root: string) {
  return pathname === root || pathname.startsWith(`${root}/`);
}

function normalizePath(pathname: string) {
  const segments: string[] = [];
  for (const segment of pathname.replace(/\\/g, '/').split('/')) {
    if (segment === '..') segments.pop();
    else if (segment && segment !== '.') segments.push(segment);
  }
  return `/${segments.join('/')}`.toLowerCase();
}

export function matchesDecodedPath(value: string, predicate: (pathname: string) => boolean) {
  let decoded = value;
  // Check each decoding layer, including ASCII escapes beside malformed UTF-8.
  // Both proxy/static lookup and the image optimizer can normalize these paths.
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const candidate = decoded.replace(/\\/g, '/');
      let pathname: string;
      // Match the optimizer's WHATWG URL parsing, including trimmed C0/space
      // and embedded TAB/CR/LF in an absolute URL's scheme. A regex before
      // parsing would miss aliases of an already-cached private image.
      try { pathname = new URL(candidate).pathname; }
      catch { pathname = candidate.split(/[?#]/, 1)[0]; }
      if (predicate(normalizePath(pathname))) return true;
    } catch { /* Invalid URLs cannot resolve to a file at this decoding layer. */ }
    const next = decoded.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === decoded) return false;
    decoded = next;
  }
  return true; // Excessively nested encodings are not valid public document URLs.
}

export function isClientDocumentStoragePath(pathname: string) {
  return matchesDecodedPath(pathname, (value) => isWithin(value, STORAGE_PATH));
}

export function isPrivateClientDocumentImageSource(source: string) {
  return matchesDecodedPath(source, (value) => isWithin(value, STORAGE_PATH)
    || /^\/api\/client\/documents(?:\/|$)/.test(value)
    || /^\/api\/admin\/clients\/[^/]+\/documents(?:\/|$)/.test(value));
}

export function blocksPublicClientDocumentRequest(url: Pick<URL, 'pathname' | 'searchParams'>) {
  if (isClientDocumentStoragePath(url.pathname)) return true;
  if (!matchesDecodedPath(url.pathname, (value) => isWithin(value, '/_next/image'))) return false;
  // Run before Next's image cache: denying the source fetch alone would leave
  // any previously optimized copy publicly retrievable. Never optimize an
  // authenticated download either, even when this request carries a cookie.
  return url.searchParams.getAll('url').some(isPrivateClientDocumentImageSource);
}
