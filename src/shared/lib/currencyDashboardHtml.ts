import { createHash } from 'node:crypto';
import { dashboardUsageAdapterScript } from './dashboardUsageBridge';
import { getBuiltinCurrencyDashboardHtmlSeed, prepareCurrencyDashboardHtml } from './currencyDashboardHtmlUpload';

/** Author code executes only in the isolated frame; the trusted parent owns data and permissions. */
export function renderCurrencyDashboardHtml(nonce: string, parentOrigin: string, canManage = false,
  rawHtml?: string, options: { trackUsage?: boolean } = {}): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) throw new Error('Invalid currency bridge nonce');
  const origin = new URL(parentOrigin);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.origin !== parentOrigin) {
    throw new Error('Invalid currency bridge origin');
  }
  const html = prepareCurrencyDashboardHtml(rawHtml ?? getBuiltinCurrencyDashboardHtmlSeed().current.htmlContent);
  const marker = '__KTS_CURRENCY_BOOTSTRAP__';
  if (html.split(marker).length !== 2) throw new Error('Invalid currency dashboard asset');
  const configuration = JSON.stringify({ nonce, parentOrigin, canManage }).replace(/</g, '\\u003c');
  const rendered = html.replace(marker, () => configuration);
  return options.trackUsage === false ? rendered
    : rendered.replace(/<\/script\s*>/i, (tag) => `\n${dashboardUsageAdapterScript()}\n${tag}`);
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
