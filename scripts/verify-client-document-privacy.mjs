import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLIENT_DOCUMENT_PROBE_ORIGINS = [
  'https://kts-impex.ru',
  'https://www.kts-impex.ru',
  'http://kts-impex.ru',
  'http://www.kts-impex.ru',
];

// These files never need to exist. A dedicated 403 distinguishes the guard
// from a coincidental 404 and does not read any real customer document.
export const CLIENT_DOCUMENT_PROBE_PATHS = [
  '/uploads/client-documents',
  '/uploads/client-documents/',
  '/uploads/client-documents/__kts_private_document_probe__.pdf',
  '/%75ploads/client-documents/__kts_private_document_probe__.pdf',
  '/uploads/client%2Ddocuments/__kts_private_document_probe__.pdf',
  '/uploads%2fclient-documents%2f__kts_private_document_probe__.pdf',
  '//uploads//client-documents///__kts_private_document_probe__.pdf',
  '/uploads/unused/../client-documents/__kts_private_document_probe__.pdf',
  '/uploads/unused/%2e%2e/client-documents/__kts_private_document_probe__.pdf',
  '/uploads/client-documents/__kts_private_document_probe__.pdf?download=1',
];

export function resolvePrivacyRedirect(origin, pathname, location) {
  const target = new URL(location, origin);
  const allowed = new Set([...CLIENT_DOCUMENT_PROBE_ORIGINS, origin]);
  if (!allowed.has(target.origin) || target.username || target.password
    || (origin.startsWith('https:') && target.protocol !== 'https:')) throw new Error('Unexpected privacy probe redirect origin');
  const normalize = (value) => new URL(decodeURIComponent(value).replace(/\/+/g, '/'), 'https://kts.invalid').pathname.replace(/\/$/, '');
  if (normalize(target.pathname) !== normalize(pathname.split('?')[0])) throw new Error('Privacy probe redirected to a different resource');
  return { origin: target.origin, pathname: `${target.pathname}${target.search}` };
}

async function requestHeaders(origin, pathname, method) {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error('Expected a plain HTTP(S) origin');
  return new Promise((resolve, reject) => {
    // Pass the raw path separately: URL/fetch would normalize dot segments
    // before the request, leaving the reverse proxy's own handling untested.
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      path: pathname,
      method,
      headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'KTS-private-upload-verification/1' },
    }, (response) => {
      resolve({ status: response.statusCode, location: response.headers.location });
      response.destroy(); // Headers are sufficient; never inspect response data.
    });
    const timer = setTimeout(() => request.destroy(new Error('Privacy probe timed out')), 5000);
    request.once('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end();
  });
}

export async function requestStatus(origin, pathname, method) {
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    const response = await requestHeaders(origin, pathname, method);
    if (![301, 302, 307, 308].includes(response.status)) return response.status;
    if (!response.location) throw new Error('Privacy probe redirect is missing its location');
    ({ origin, pathname } = resolvePrivacyRedirect(origin, pathname, response.location));
  }
  throw new Error('Privacy probe exceeded the redirect limit');
}

export async function verifyClientDocumentPrivacy({
  origins = CLIENT_DOCUMENT_PROBE_ORIGINS,
  request = requestStatus,
} = {}) {
  if (!origins.length) throw new Error('At least one privacy probe origin is required');
  let checked = 0;
  for (const origin of origins) {
    for (const pathname of CLIENT_DOCUMENT_PROBE_PATHS) {
      for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        const status = await request(origin, pathname, method);
        // Nginx's static handler may reject OPTIONS with 405 before opening a
        // file. GET/HEAD must reach the owner-only directory and return 403.
        if (status !== 403 && !(method === 'OPTIONS' && status === 405)) {
          throw new Error(`Private upload guard failed: ${method} ${origin}${pathname} returned ${status}, expected 403${method === 'OPTIONS' ? ' or 405' : ''}`);
        }
        checked += 1;
      }
    }
    // The guard must not deny unrelated uploads or an adjacent prefix.
    for (const pathname of ['/uploads/__kts_public_upload_probe__.svg', '/uploads/client-documents-other/__kts_public_upload_probe__.svg']) {
      const status = await request(origin, pathname, 'HEAD');
      if (!Number.isInteger(status) || status < 200 || status >= 500 || status === 403) {
        throw new Error(`Public upload regression: HEAD ${origin}${pathname} returned ${status}`);
      }
      checked += 1;
    }
  }
  return { checked, origins: origins.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const origins = args.length ? args : CLIENT_DOCUMENT_PROBE_ORIGINS;
  verifyClientDocumentPrivacy({ origins }).then((result) => {
    console.log(`Private upload guard verified: ${result.checked} anonymous requests across ${result.origins} origins.`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : 'Private upload verification failed');
    process.exitCode = 1;
  });
}
