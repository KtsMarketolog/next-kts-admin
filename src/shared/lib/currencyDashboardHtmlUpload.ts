import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { adaptCurrencyAuthorHtml, inspectCurrencyAuthorHtml } from './currencyDashboardAuthorAdapter';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_CACHED_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 8;
const BOOTSTRAP = '__KTS_CURRENCY_BOOTSTRAP__';
type Prepared = { sourceVersion: string; htmlContent: string; bytes: number };
const cache = new Map<string, Prepared>();
let cachedBytes = 0;
let builtins: ReturnType<typeof readBuiltins> | undefined;

function readBuiltins() {
  const directory = path.join(process.cwd(), 'assets/currency-dashboard');
  const previous = { htmlContent: readFileSync(path.join(directory, 'kursy_valyut_v21.html'), 'utf8'),
    originalName: 'kursy_valyut_v21.html', sourceVersion: 'V21' };
  const current = { htmlContent: readFileSync(path.join(directory, 'kursy_valyut_v25.html'), 'utf8'),
    originalName: 'kursy_valyut_v25.html', sourceVersion: 'V25' };
  return { current, previous };
}

/** Seed immutable originals once. Subsequent deployments never replace a published upload. */
export function getBuiltinCurrencyDashboardHtmlSeed() {
  builtins ??= readBuiltins();
  return { current: { ...builtins.current }, previous: { ...builtins.previous } };
}

function prepare(html: string): Prepared {
  if (typeof html !== 'string' || !html.trim() || html.includes('\0') || Buffer.byteLength(html, 'utf8') > MAX_SOURCE_BYTES) {
    throw new Error('Нужен непустой HTML-файл до 2 МБ без нулевых символов.');
  }
  const hash = createHash('sha256').update(html, 'utf8').digest('hex');
  const hit = cache.get(hash);
  if (hit) {
    cache.delete(hash);
    cache.set(hash, hit);
    return hit;
  }
  const legacy = getBuiltinCurrencyDashboardHtmlSeed().previous;
  // Only our exact reviewed legacy artifact bypasses author adaptation. A marker,
  // version label or filename in an uploaded file is not a trust boundary.
  const sourceVersion = html === legacy.htmlContent ? legacy.sourceVersion : inspectCurrencyAuthorHtml(html).sourceVersion;
  const htmlContent = html === legacy.htmlContent ? html : adaptCurrencyAuthorHtml(html, sourceVersion);
  if (htmlContent.split(BOOTSTRAP).length !== 2) throw new Error('HTML не содержит единственного подключения к данным сайта.');
  const result = { sourceVersion, htmlContent, bytes: Buffer.byteLength(htmlContent, 'utf8') };
  if (result.bytes <= MAX_CACHED_BYTES) {
    while (cache.size >= MAX_CACHE_ENTRIES || cachedBytes + result.bytes > MAX_CACHED_BYTES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cachedBytes -= cache.get(oldest)!.bytes;
      cache.delete(oldest);
    }
    cache.set(hash, result);
    cachedBytes += result.bytes;
  }
  return result;
}

/** Validate the complete integration, not only its version label, before accepting a draft. */
export function inspectCurrencyDashboardUpload(html: string): { sourceVersion: string } {
  return { sourceVersion: prepare(html).sourceVersion };
}

export function prepareCurrencyDashboardHtml(html: string): string {
  return prepare(html).htmlContent;
}
