import { tryAcquireSessionAdvisoryLock } from './db/client';
declare global { var __ktsKnowledgeBaseUploadSlots: Set<number> | undefined; }
/** Separate from heavy dashboard imports: at most two streamed KB transfers across all workers. */
export async function acquireKnowledgeBaseUploadSlot() {
  const local = globalThis.__ktsKnowledgeBaseUploadSlots ??= new Set<number>();
  for (let slot = 0; slot < 2; slot += 1) {
    if (local.has(slot)) continue;
    local.add(slot);
    try {
      const release = await tryAcquireSessionAdvisoryLock(`kts_knowledge_base_upload_${slot}`);
      if (!release) { local.delete(slot); continue; }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try { await release(); } finally { local.delete(slot); }
      };
    } catch (error) { local.delete(slot); throw error; }
  }
  return null;
}
