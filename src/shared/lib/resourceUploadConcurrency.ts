import { tryAcquireSessionAdvisoryLock } from './db/client';

export type ResourceUploadKind = 'image' | 'document' | 'catalog' | 'stock';

declare global {
  var __ktsResourceUploadSlots: Set<string> | undefined;
}

/**
 * Reject excess work before buffering its body. The session-owned PostgreSQL
 * locks coordinate both application processes (and the stock-import CLI), not
 * just requests in one process. No expiring lease can overlap a slow parser.
 * Hold the slot until the worker has exited and file cleanup has completed.
 */
export async function acquireResourceUploadSlot(kind: ResourceUploadKind) {
  const heavy = kind === 'catalog' || kind === 'stock';
  const group = heavy ? 'excel' : 'files';
  const count = heavy ? 1 : 2;
  const local = globalThis.__ktsResourceUploadSlots ??= new Set<string>();

  for (let index = 0; index < count; index += 1) {
    const key = `kts_resource_upload_${group}_${index}`;
    if (local.has(key)) continue;
    local.add(key);
    try {
      const cancellation = new AbortController();
      const releaseDatabase = await tryAcquireSessionAdvisoryLock(key, {
        onDisconnect: () => cancellation.abort(new Error('Upload admission connection was lost')),
      });
      if (!releaseDatabase) {
        local.delete(key);
        continue;
      }
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        try {
          await releaseDatabase();
        } finally {
          local.delete(key);
        }
      };
      return Object.assign(release, { signal: cancellation.signal });
    } catch (error) {
      local.delete(key);
      throw error;
    }
  }
  return null;
}
