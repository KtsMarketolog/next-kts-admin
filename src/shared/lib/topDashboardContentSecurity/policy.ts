import { createHash } from 'crypto';
import { collectTopDashboardInlineHashes } from './inlineSources';

function sha256Source(value: string) {
  return `'sha256-${createHash('sha256').update(value, 'utf8').digest('base64')}'`;
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
    'img-src data:',
    'font-src data:',
  ].join('; ');
}

export function buildTopDashboardContentSecurityPolicy(htmlContent: string, options: { allowBlobModules?: boolean } = {}) {
  const { scriptHashes, eventHandlerHashes } = collectTopDashboardInlineHashes(htmlContent);
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
    `script-src ${options.allowBlobModules ? 'blob: ' : ''}${scriptSource}`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data: blob:',
    'media-src data: blob:',
    'worker-src blob:',
    "manifest-src 'none'",
    'sandbox allow-scripts allow-popups',
  ].join('; ');
}
