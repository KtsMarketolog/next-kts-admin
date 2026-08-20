import { createHash } from 'crypto';

const INLINE_SCRIPT_PATTERN = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
const INLINE_EVENT_HANDLER_PATTERN = /\son[a-z][\w:-]*\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

function sha256Source(value: string) {
  return `'sha256-${createHash('sha256').update(value, 'utf8').digest('base64')}'`;
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
    'sandbox allow-scripts',
  ].join('; ');
}

export function isTopDashboardFrameRequest(request: Request, versionId: number) {
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
    return refererUrl.pathname === `/api/admin/top-dashboard/versions/${versionId}/frame`;
  } catch {
    return false;
  }
}
