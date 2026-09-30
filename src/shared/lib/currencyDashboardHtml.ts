import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Reviewed application asset, never administrator-supplied executable HTML. */
export function renderCurrencyDashboardHtml(nonce: string, parentOrigin: string): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new Error('Invalid currency bridge nonce');
  const origin = new URL(parentOrigin);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.origin !== parentOrigin) {
    throw new Error('Invalid currency bridge origin');
  }
  const html = readFileSync(path.join(process.cwd(), 'assets/currency-dashboard/kursy_valyut_v21.html'), 'utf8');
  const marker = '__KTS_CURRENCY_BOOTSTRAP__';
  if (html.split(marker).length !== 2) throw new Error('Invalid currency dashboard asset');
  const configuration = JSON.stringify({ nonce, parentOrigin }).replace(/</g, '\\u003c');
  return html.replace(marker, () => configuration);
}

export function buildCurrencyDashboardContentSecurityPolicy(html: string): string {
  const scripts = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi), (match) => (
    `'sha256-${createHash('sha256').update(match[1].replace(/\r\n?/g, '\n')).digest('base64')}'`
  ));
  return [
    "default-src 'none'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'self'",
    "form-action 'none'", "connect-src 'none'", "frame-src 'none'",
    `script-src ${scripts.length ? scripts.join(' ') : "'none'"}`,
    "style-src 'unsafe-inline'", 'img-src data: blob:', 'font-src data: blob:',
    'media-src data: blob:', "worker-src 'none'", "manifest-src 'none'",
    // Native submit events require allow-forms even when JS prevents navigation.
    // form-action 'none' still prohibits every actual form submission.
    'sandbox allow-scripts allow-downloads allow-modals allow-forms',
  ].join('; ');
}
