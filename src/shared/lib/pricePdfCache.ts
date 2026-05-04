import { createHash } from 'crypto';
import { mkdir, readdir, readFile, unlink, writeFile } from 'fs/promises';
import path from 'path';

import type { PublicWholesalePriceList } from './db';

const CACHE_DIR = path.join('.cache', 'price-pdf');

function cacheDigest(priceList: PublicWholesalePriceList) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: priceList.id,
        title: priceList.title,
        clientName: priceList.clientName,
        validUntil: priceList.validUntil,
        updatedAt: priceList.updatedAt,
        showRetailPrices: priceList.showRetailPrices,
        categories: priceList.categories,
      }),
    )
    .digest('hex');
}

function cacheFilename(priceList: PublicWholesalePriceList) {
  return `${priceList.id}-${cacheDigest(priceList)}.pdf`;
}

function cachePath(priceList: PublicWholesalePriceList) {
  return path.join(CACHE_DIR, cacheFilename(priceList));
}

export async function readPricePdfCache(priceList: PublicWholesalePriceList) {
  try {
    return await readFile(cachePath(priceList));
  } catch {
    return null;
  }
}

export async function writePricePdfCache(priceList: PublicWholesalePriceList, pdf: Buffer) {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const current = cacheFilename(priceList);
    await writeFile(path.join(CACHE_DIR, current), pdf);
    await cleanupOldPricePdfCache(priceList.id, current);
  } catch (error) {
    console.error('Failed to write price PDF cache', error);
  }
}

async function cleanupOldPricePdfCache(priceListId: number, currentFilename: string) {
  try {
    const files = await readdir(CACHE_DIR);
    await Promise.all(
      files
        .filter((file) => file.startsWith(`${priceListId}-`) && file.endsWith('.pdf') && file !== currentFilename)
        .map((file) => unlink(path.join(CACHE_DIR, file)).catch(() => undefined)),
    );
  } catch {
    // Cache cleanup is best-effort.
  }
}
