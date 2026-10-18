export type PriceExportCacheKey = {
  priceListId: number;
  revision: string;
};

export type PriceExportBuildResult =
  | { kind: 'ready'; bytes: Buffer; cacheable?: boolean }
  | { kind: 'missing' | 'too-large' };

export type PriceExportResult =
  | { kind: 'ready'; bytes: Buffer; cache: 'hit' | 'miss' | 'shared' }
  | { kind: 'missing' | 'too-large' | 'busy' };

function cacheKey(key: PriceExportCacheKey) {
  return `${key.priceListId}:${key.revision}`;
}

/** Only derived downloads are cached. No catalogue or saved price data are changed. */
export function createPriceExportMemoryCache(maxEntries: number, maxBytes: number) {
  const entries = new Map<string, Buffer>();
  let bytes = 0;

  return {
    async read(key: PriceExportCacheKey) {
      const id = cacheKey(key);
      const value = entries.get(id);
      if (!value) return null;
      entries.delete(id);
      entries.set(id, value);
      return value;
    },
    async write(key: PriceExportCacheKey, value: Buffer) {
      if (value.byteLength > maxBytes || maxEntries < 1) return;
      const id = cacheKey(key);
      const old = entries.get(id);
      if (old) bytes -= old.byteLength;
      entries.delete(id);
      entries.set(id, value);
      bytes += value.byteLength;
      while (entries.size > maxEntries || bytes > maxBytes) {
        const oldest = entries.entries().next().value;
        if (!oldest) break;
        entries.delete(oldest[0]);
        bytes -= oldest[1].byteLength;
      }
    },
  };
}

/** Admit work before loading products, and share concurrent work for the same revision. */
export function createPriceExportCoordinator(options: {
  maxConcurrent: number;
  read: (key: PriceExportCacheKey) => Promise<Buffer | null>;
  write: (key: PriceExportCacheKey, bytes: Buffer) => Promise<void>;
}) {
  const pending = new Map<string, Promise<PriceExportBuildResult>>();
  let active = 0;

  return async function getExport(
    key: PriceExportCacheKey,
    build: () => Promise<PriceExportBuildResult>,
    measure: <T>(stage: string, work: () => Promise<T>) => Promise<T> = (_stage, work) => work(),
  ): Promise<PriceExportResult> {
    const cached = await measure('cache_read', () => options.read(key));
    if (cached) return { kind: 'ready', bytes: cached, cache: 'hit' };

    const id = cacheKey(key);
    const existing = pending.get(id);
    if (existing) {
      const result = await existing;
      return result.kind === 'ready' ? { ...result, cache: 'shared' } : result;
    }
    if (active >= options.maxConcurrent) return { kind: 'busy' };

    active += 1;
    const work = Promise.resolve().then(async () => {
      // Another request may have populated the cache while the first read was pending.
      const cachedAgain = await measure('cache_recheck', () => options.read(key));
      if (cachedAgain) return { kind: 'ready' as const, bytes: cachedAgain };
      const result = await build();
      if (result.kind === 'ready' && result.cacheable !== false) {
        await measure('cache_write', () => options.write(key, result.bytes));
      }
      return result;
    });
    pending.set(id, work);
    try {
      const result = await work;
      return result.kind === 'ready' ? { ...result, cache: 'miss' } : result;
    } finally {
      pending.delete(id);
      active -= 1;
    }
  };
}
