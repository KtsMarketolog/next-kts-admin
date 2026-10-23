import type { AdminSession } from '../adminAuth';
import { query, withTransaction } from './client';
import { assertClientCompanyVisible, assertClientCompanyWritable } from './clientCompaniesRepo';
import { ensureSiteSchema } from './schema';

export type ClientDocument = {
  id: number;
  companyId: number;
  title: string;
  originalName: string;
  mimeType: string;
  fileSize: number;
  isVisible: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ClientDocumentFile = ClientDocument & {
  filePath: string;
};

export type ClientDocumentInput = {
  title: string;
  originalName: string;
  mimeType: string;
  filePath: string;
  fileSize: number;
  isVisible: boolean;
};

type ClientDocumentRow = {
  id: string;
  company_id: string;
  title: string;
  original_name: string;
  mime_type: string;
  file_path: string;
  file_size: string;
  is_visible: boolean;
  created_at: string;
  updated_at: string;
};

function mapClientDocument(row: ClientDocumentRow): ClientDocumentFile {
  return {
    id: Number(row.id),
    companyId: Number(row.company_id),
    title: row.title,
    originalName: row.original_name,
    mimeType: row.mime_type,
    filePath: row.file_path,
    fileSize: Number(row.file_size ?? 0),
    isVisible: row.is_visible,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function withoutFilePath(document: ClientDocumentFile): ClientDocument {
  return {
    id: document.id,
    companyId: document.companyId,
    title: document.title,
    originalName: document.originalName,
    mimeType: document.mimeType,
    fileSize: document.fileSize,
    isVisible: document.isVisible,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

/** Reject uploads before reading the body; the write transaction checks again. */
export async function assertClientDocumentUploadAllowed(companyId: number, session: AdminSession): Promise<void> {
  await ensureSiteSchema();
  // Release the company lock before receiving the file. An archive or access
  // change during the upload is still caught by createClientDocument below.
  await withTransaction(async (client) => {
    await assertClientCompanyWritable(companyId, session, client);
  }, { retryOnConflict: true });
}

export async function getClientDocumentsForAdmin(companyId: number, session: AdminSession): Promise<ClientDocument[]> {
  await ensureSiteSchema();
  await assertClientCompanyVisible(companyId, session);

  const result = await query<ClientDocumentRow>(
    `select
       id::text,
       company_id::text,
       title,
       original_name,
       mime_type,
       file_path,
       file_size::text,
       is_visible,
       created_at::text,
       updated_at::text
     from client_documents
     where company_id = $1
     order by created_at desc, id desc`,
    [companyId],
  );

  return result.rows.map((row) => withoutFilePath(mapClientDocument(row)));
}

export async function getClientDocumentsForClient(companyId: number): Promise<ClientDocument[]> {
  await ensureSiteSchema();

  const result = await query<ClientDocumentRow>(
    `select
       id::text,
       company_id::text,
       title,
       original_name,
       mime_type,
       file_path,
       file_size::text,
       is_visible,
       created_at::text,
       updated_at::text
     from client_documents
     where company_id = $1 and is_visible = true
     order by created_at desc, id desc`,
    [companyId],
  );

  return result.rows.map((row) => withoutFilePath(mapClientDocument(row)));
}

export async function createClientDocument(
  companyId: number,
  input: ClientDocumentInput,
  session: AdminSession,
): Promise<ClientDocument> {
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    await assertClientCompanyWritable(companyId, session, client);
    await client.query('lock table client_documents in row exclusive mode');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`client-document:${input.filePath}`]);

    const result = await client.query<ClientDocumentRow>(
      `insert into client_documents (
         company_id, title, original_name, mime_type, file_path, file_size, is_visible
       )
       values ($1, $2, $3, $4, $5, $6, $7)
       returning
         id::text,
         company_id::text,
         title,
         original_name,
         mime_type,
         file_path,
         file_size::text,
         is_visible,
         created_at::text,
         updated_at::text`,
      [
        companyId,
        input.title,
        input.originalName,
        input.mimeType,
        input.filePath,
        input.fileSize,
        input.isVisible,
      ],
    );

    return withoutFilePath(mapClientDocument(result.rows[0]));
  }, { retryOnConflict: true, trackCommitOutcome: true });
}

export async function updateClientDocumentVisibility(
  companyId: number,
  documentId: number,
  isVisible: boolean,
  session: AdminSession,
): Promise<ClientDocument> {
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    await assertClientCompanyWritable(companyId, session, client);

    const result = await client.query<ClientDocumentRow>(
      `update client_documents
       set is_visible = $3,
           updated_at = now()
       where company_id = $1 and id = $2
       returning
         id::text,
         company_id::text,
         title,
         original_name,
         mime_type,
         file_path,
         file_size::text,
         is_visible,
         created_at::text,
         updated_at::text`,
      [companyId, documentId, isVisible],
    );
    if (!result.rows[0]) throw new Error('Документ не найден');
    return withoutFilePath(mapClientDocument(result.rows[0]));
  }, { retryOnConflict: true, trackCommitOutcome: true });
}

export async function deleteClientDocument(
  companyId: number,
  documentId: number,
  session: AdminSession,
): Promise<ClientDocumentFile & { cleanupId: number }> {
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    await assertClientCompanyWritable(companyId, session, client);

    const result = await client.query<ClientDocumentRow>(
      `delete from client_documents
       where company_id = $1 and id = $2
       returning
         id::text,
         company_id::text,
         title,
         original_name,
         mime_type,
         file_path,
         file_size::text,
         is_visible,
         created_at::text,
         updated_at::text`,
      [companyId, documentId],
    );
    if (!result.rows[0]) throw new Error('Документ не найден');
    const document = mapClientDocument(result.rows[0]);
    const cleanup = await client.query<{ id: string }>(
      `insert into client_document_file_cleanup (document_id, company_id, file_path)
       values ($1, $2, $3) returning id::text`, [document.id, companyId, document.filePath],
    );
    return { ...document, cleanupId: Number(cleanup.rows[0].id) };
  }, { retryOnConflict: true, trackCommitOutcome: true });
}

export async function getClientDocumentForAdminDownload(
  companyId: number,
  documentId: number,
  session: AdminSession,
): Promise<ClientDocumentFile> {
  await ensureSiteSchema();
  await assertClientCompanyVisible(companyId, session);

  const result = await query<ClientDocumentRow>(
    `select
       id::text,
       company_id::text,
       title,
       original_name,
       mime_type,
       file_path,
       file_size::text,
       is_visible,
       created_at::text,
       updated_at::text
     from client_documents
     where company_id = $1 and id = $2
     limit 1`,
    [companyId, documentId],
  );
  if (!result.rows[0]) throw new Error('Документ не найден');
  return mapClientDocument(result.rows[0]);
}

export async function getClientDocumentForClientDownload(
  companyId: number,
  documentId: number,
): Promise<ClientDocumentFile> {
  await ensureSiteSchema();

  const result = await query<ClientDocumentRow>(
    `select
       id::text,
       company_id::text,
       title,
       original_name,
       mime_type,
       file_path,
       file_size::text,
       is_visible,
       created_at::text,
       updated_at::text
     from client_documents
     where company_id = $1 and id = $2 and is_visible = true
     limit 1`,
    [companyId, documentId],
  );
  if (!result.rows[0]) throw new Error('Документ не найден');
  return mapClientDocument(result.rows[0]);
}
