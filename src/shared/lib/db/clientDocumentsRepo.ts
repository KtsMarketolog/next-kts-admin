import type { AdminSession } from '../adminAuth';
import { query } from './client';
import { assertClientCompanyVisible } from './clientCompaniesRepo';
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
  await assertClientCompanyVisible(companyId, session);

  const result = await query<ClientDocumentRow>(
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
}

export async function updateClientDocumentVisibility(
  companyId: number,
  documentId: number,
  isVisible: boolean,
  session: AdminSession,
): Promise<ClientDocument> {
  await ensureSiteSchema();
  await assertClientCompanyVisible(companyId, session);

  const result = await query<ClientDocumentRow>(
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
}

export async function deleteClientDocument(
  companyId: number,
  documentId: number,
  session: AdminSession,
): Promise<ClientDocumentFile> {
  await ensureSiteSchema();
  await assertClientCompanyVisible(companyId, session);

  const result = await query<ClientDocumentRow>(
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
  return mapClientDocument(result.rows[0]);
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
