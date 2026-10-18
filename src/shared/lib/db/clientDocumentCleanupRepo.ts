import { removeClientDocumentFile } from '../clientDocumentStorage';
import { query, withTransaction } from './client';

export type ClientDocumentCleanupResult = { pending: boolean; reason?: string };

// Rollback cleanup for a just-uploaded file also checks for a committed reference:
// an interrupted INSERT response does not prove that the INSERT failed.
export async function removeUnreferencedClientDocumentUpload(filePath: string, companyId: number) {
  return withTransaction(async (client) => {
    await client.query('lock table client_documents in share mode');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`client-document:${filePath}`]);
    const result = await client.query<{ referenced: boolean }>(
      'select exists(select 1 from client_documents where file_path = $1) as referenced', [filePath],
    );
    if (result.rows[0]?.referenced) return 'referenced' as const;
    return removeClientDocumentFile(filePath, companyId);
  }, { trackCommitOutcome: true });
}

// Cleanup is deliberately restricted to files recorded by an explicit document
// deletion. There is no directory scan, orphan sweep, or archive expiry policy.
export async function listPendingClientDocumentCleanup() {
  const result = await query<{
    id: string; company_id: string; document_id: string; created_at: string;
    attempts: number; last_error: string | null;
  }>(`select id::text, company_id::text, document_id::text, created_at::text, attempts, last_error
      from client_document_file_cleanup where completed_at is null order by id limit 100`);
  return result.rows;
}

export async function processClientDocumentCleanup(cleanupId: number): Promise<ClientDocumentCleanupResult> {
  if (!Number.isSafeInteger(cleanupId) || cleanupId <= 0) throw new Error('Некорректный номер очистки');
  return withTransaction(async (client) => {
    const result = await client.query<{ company_id: string; file_path: string; completed_at: string | null }>(
      `select company_id::text, file_path, completed_at::text
       from client_document_file_cleanup where id = $1 for update`, [cleanupId],
    );
    const job = result.rows[0];
    if (!job) throw new Error('Задание очистки не найдено');
    if (job.completed_at) return { pending: false };

    // All writes acquire their table lock before the same path lock. Holding
    // SHARE here prevents a new reference between our check and unlink.
    await client.query('lock table client_documents in share mode');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`client-document:${job.file_path}`]);
    const references = await client.query<{ referenced: boolean }>(
      'select exists(select 1 from client_documents where file_path = $1) as referenced', [job.file_path],
    );
    let reason: string | undefined;
    if (references.rows[0]?.referenced) {
      reason = 'FILE_STILL_REFERENCED';
    } else {
      try {
        await removeClientDocumentFile(job.file_path, Number(job.company_id));
      } catch (error) {
        // Only a bounded code is persisted/reported, never a server filesystem path.
        const code = (error as NodeJS.ErrnoException).code;
        reason = typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'UNSAFE_OR_UNAVAILABLE_FILE';
      }
    }
    await client.query(
      `update client_document_file_cleanup set attempts = attempts + 1, last_error = $2,
       completed_at = case when $2::text is null then now() else null end where id = $1`,
      [cleanupId, reason ?? null],
    );
    return { pending: Boolean(reason), ...(reason ? { reason } : {}) };
  }, { trackCommitOutcome: true });
}
