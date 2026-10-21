type Entry<T> = { value: T; bytes: number; expiresAt: number };

/** Derived read results only. Eviction never touches a database row or source file. */
export function createPriceReadCache<T>(options: {
  maxEntries: number; maxBytes: number; ttlMs: number;
  /** Worker-computed size avoids a second synchronous serialization on the server. */
  sizeOf?: (value: T) => number;
  shouldCache?: (value: T, key: string) => boolean;
  maxPending?: number;
  overloadError?: () => Error;
}) {
  const entries = new Map<string, Entry<T>>();
  const pending = new Map<string, Promise<T>>();
  let bytes = 0;
  function remove(key: string) {
    const entry = entries.get(key);
    if (entry) { bytes -= entry.bytes; entries.delete(key); }
  }
  return {
    async read(key: string, load: () => Promise<T>, onState?: (state: 'hit' | 'miss' | 'coalesced') => void): Promise<T> {
      const existing = entries.get(key);
      if (existing && existing.expiresAt > Date.now()) {
        entries.delete(key);
        entries.set(key, existing);
        onState?.('hit');
        return existing.value;
      }
      if (existing) remove(key);
      const inFlight = pending.get(key);
      if (inFlight) { onState?.('coalesced'); return inFlight; }
      if (pending.size >= (options.maxPending ?? Infinity)) {
        throw options.overloadError?.() ?? new Error('Price build capacity reached');
      }
      onState?.('miss');
      const work = Promise.resolve().then(load).then((value) => {
        if (value === null || value === undefined) return value;
        if (options.shouldCache && !options.shouldCache(value, key)) return value;
        const size = options.sizeOf ? options.sizeOf(value) : Buffer.byteLength(JSON.stringify(value), 'utf8');
        if (!Number.isFinite(size) || size < 0 || size > options.maxBytes) return value;
        for (const [oldKey, entry] of entries) if (entry.expiresAt <= Date.now()) remove(oldKey);
        remove(key);
        while (entries.size >= options.maxEntries || bytes + size > options.maxBytes) {
          const oldest = entries.keys().next().value;
          if (oldest === undefined) break;
          remove(oldest);
        }
        entries.set(key, { value, bytes: size, expiresAt: Date.now() + options.ttlMs });
        bytes += size;
        return value;
      }).finally(() => { pending.delete(key); });
      pending.set(key, work);
      return work;
    },
  };
}
