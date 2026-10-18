type Entry<T> = { value: T; bytes: number; expiresAt: number };

/** Derived read results only. Eviction never touches a database row or source file. */
export function createPriceReadCache<T>(options: { maxEntries: number; maxBytes: number; ttlMs: number }) {
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
      onState?.('miss');
      const work = Promise.resolve().then(load).then((value) => {
        if (value === null || value === undefined) return value;
        const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
        if (size > options.maxBytes) return value;
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
