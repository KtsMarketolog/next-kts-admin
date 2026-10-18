import { createHash, randomUUID } from 'crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises';
import path from 'path';

import type { PriceExportCacheKey } from './priceExportCache';

const CACHE_DIR = path.join('.cache', 'price-pdf');
const CACHE_VERSION = 4;

function cacheDigest(key: PriceExportCacheKey) {
  return createHash('sha256')
    .update(`${CACHE_VERSION}:${key.priceListId}:${key.revision}`)
    .digest('hex');
}

function cacheFilename(key: PriceExportCacheKey) {
  return `${key.priceListId}-${cacheDigest(key)}.pdf`;
}

export async function readPricePdfCache(key: PriceExportCacheKey) {
  try {
    return await readFile(path.join(CACHE_DIR, cacheFilename(key)));
  } catch {
    return null;
  }
}

export async function writePricePdfCache(key: PriceExportCacheKey, pdf: Buffer) {
  const current = cacheFilename(key);
  const temporary = path.join(CACHE_DIR, `${current}.${randomUUID()}.tmp`);
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(temporary, pdf);
    // Other workers must never read a half-written download.
    await rename(temporary, path.join(CACHE_DIR, current));
    await cleanupOldPricePdfCache(key.priceListId, current);
  } catch {
    console.error('Failed to write price PDF cache');
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function cleanupOldPricePdfCache(priceListId: number, currentFilename: string) {
  try {
    const current = await stat(path.join(CACHE_DIR, currentFilename));
    const files = await readdir(CACHE_DIR);
    const candidates = (await Promise.all(
      files
        .filter((file) => file.startsWith(`${priceListId}-`) && file.endsWith('.pdf'))
        .map(async (file) => {
          const info = await stat(path.join(CACHE_DIR, file)).catch(() => null);
          return info ? { file, mtimeMs: info.mtimeMs } : null;
        }),
    )).filter((entry): entry is { file: string; mtimeMs: number } => entry !== null);
    // Two workers can finish different revisions in the opposite order. Keep
    // both recent results, and an older cleanup must never remove newer files.
    const retained = new Set(candidates
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 2)
      .map(({ file }) => file));
    await Promise.all(
      candidates
        .filter(({ file, mtimeMs }) => file !== currentFilename && !retained.has(file) && mtimeMs < current.mtimeMs)
        .map(async ({ file, mtimeMs }) => {
          const filename = path.join(CACHE_DIR, file);
          const latest = await stat(filename).catch(() => null);
          if (latest && latest.mtimeMs === mtimeMs && latest.mtimeMs < current.mtimeMs) {
            await unlink(filename).catch(() => undefined);
          }
        }),
    );
  } catch {
    // Evict only derived PDF cache files, never stored prices or catalogue data.
  }
}
