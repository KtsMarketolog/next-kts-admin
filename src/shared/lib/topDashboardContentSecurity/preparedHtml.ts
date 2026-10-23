import { createHash } from 'node:crypto';
import { transformTopDashboardDynamicHandlers } from './dynamicHandlers';

// Cache only the derived document, never author files, snapshots or permissions.
// All callers still authorize each request before preparing an HTML response.
const MAX_ENTRIES = 8;
const MAX_BYTES = 32 * 1024 * 1024;
const TTL_MS = 5 * 60 * 1000;
const prepared = new Map<string, { html: string; bytes: number; expires: number }>();
let retainedBytes = 0;

export function prepareInteractiveDashboardHtml(html: string): string {
  const key = createHash('sha256').update(html).digest('hex');
  const now = Date.now();
  for (const [entryKey, entry] of prepared) {
    if (entry.expires > now) continue;
    retainedBytes -= entry.bytes;
    prepared.delete(entryKey);
  }
  const cached = prepared.get(key);
  if (cached) {
    prepared.delete(key);
    prepared.set(key, cached);
    return cached.html;
  }
  const result = transformTopDashboardDynamicHandlers(html);
  // Account for UTF-16 storage conservatively, not compressed/network size.
  const bytes = result.length * 2;
  if (bytes <= MAX_BYTES) {
    while (prepared.size >= MAX_ENTRIES || retainedBytes + bytes > MAX_BYTES) {
      const oldest = prepared.entries().next().value;
      if (!oldest) break;
      retainedBytes -= oldest[1].bytes;
      prepared.delete(oldest[0]);
    }
    prepared.set(key, { html: result, bytes, expires: now + TTL_MS });
    retainedBytes += bytes;
  }
  return result;
}
