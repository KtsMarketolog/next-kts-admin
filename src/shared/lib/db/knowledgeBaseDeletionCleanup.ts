import { removeDeletedKnowledgeBaseFile } from '../knowledgeBaseStorage';
import { withDashboardBackupLock } from '../dashboardFileCleanup';
import { ensureSiteSchema } from './schema';
import { query, withTransaction } from './client';
import { KNOWLEDGE_BASE_LOCK } from './knowledgeBaseRepo.shared';

const MAX_ATTEMPTS = 8;
type CleanupJob = { node_id: string; storage_path: string; file_size: string; sha256: string; attempts: number };
export type KnowledgeBaseDeletionCleanupResult = {
  processed: number; completed: number; failed: number; pending: boolean; exhausted: number; error: boolean;
};

/** Only confirmed outbox jobs, never an orphan scan or archive-age policy. Safe across processes/restarts. */
export async function processKnowledgeBaseDeletionCleanup(input: { deletionId?: string; limit?: number; budgetMs?: number } = {}): Promise<KnowledgeBaseDeletionCleanupResult> {
  const result: KnowledgeBaseDeletionCleanupResult = { processed: 0, completed: 0, failed: 0, pending: false, exhausted: 0, error: false };
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 25)));
  const deadline = Date.now() + Math.max(100, Math.min(20_000, input.budgetMs ?? 5_000));
  if (input.deletionId !== undefined && !/^[1-9][0-9]{0,18}$/.test(input.deletionId)) throw new Error('Invalid cleanup operation');
  try {
    await ensureSiteSchema();
    while (result.processed < limit && Date.now() < deadline) {
      // The same shared nonblocking lock protects all private-file cleanup from
      // racing the installed backup runner's DB snapshot and file capture.
      const outcome = await withDashboardBackupLock(() => withTransaction(async client => {
        await client.query("set local statement_timeout='3s'; set local lock_timeout='500ms'");
        const selected = await client.query<CleanupJob>(`select node_id::text,storage_path,file_size::text,sha256,attempts
          from knowledge_base_file_deletions where completed_at is null and failed_at is null and next_attempt_at<=clock_timestamp()
          and ($1::bigint is null or deletion_id=$1) order by next_attempt_at,node_id for update skip locked limit 1`, [input.deletionId ?? null]);
        const job = selected.rows[0];
        if (!job) return null;
        await client.query('select pg_advisory_xact_lock_shared(hashtext($1))', [KNOWLEDGE_BASE_LOCK]);
        let failure = false;
        try {
          const safe = await client.query(`select n.id from knowledge_base_nodes n where n.id=$1 and n.deleted_at is not null
            and n.storage_path=$2 and n.file_size=$3::bigint and n.sha256=$4
            and not exists(select 1 from knowledge_base_nodes live where live.storage_path=$2 and live.deleted_at is null)`,
          [job.node_id, job.storage_path, job.file_size, job.sha256]);
          if (!safe.rowCount) throw new Error('Cleanup reference mismatch');
          // Keep the job row locked until unlink+ack. Every file is <=25 MiB; reads use 64 KiB buffers.
          await removeDeletedKnowledgeBaseFile(job.storage_path, Number(job.file_size), job.sha256);
        } catch { failure = true; }
        await client.query(`update knowledge_base_file_deletions set attempts=attempts+1,
          completed_at=case when $2 then null else clock_timestamp() end,
          failed_at=case when $2 and attempts+1 >= $3 then clock_timestamp() else null end,
          next_attempt_at=clock_timestamp()+make_interval(secs=>least(3600,60*power(2,least(attempts,6)))::int),
          last_error=case when $2 then 'PRIVATE_FILE_CLEANUP_FAILED' else null end where node_id=$1`, [job.node_id, failure, MAX_ATTEMPTS]);
        return failure ? 'failed' : 'completed';
      }, { profile: 'interactive', trackCommitOutcome: true }));
      // Busy backups leave the durable job untouched, including its retry count.
      if (outcome === null) break;
      result.processed++; result[outcome]++;
    }
    const state = await query<{ pending: boolean; exhausted: string }>(`select count(*)>0 as pending,
      count(*) filter(where failed_at is not null)::text as exhausted from knowledge_base_file_deletions
      where completed_at is null and ($1::bigint is null or deletion_id=$1)`, [input.deletionId ?? null]);
    result.pending = state.rows[0].pending; result.exhausted = Number(state.rows[0].exhausted);
  } catch {
    // A committed user deletion must never be reported as failed because background cleanup failed.
    result.error = true; result.pending = true;
  }
  if (result.error || result.failed || result.exhausted) {
    console.error(JSON.stringify({ event: 'knowledge_base_deletion_cleanup_pending', processed: result.processed,
      failed: result.failed, exhausted: result.exhausted, error: result.error }));
  }
  return result;
}
