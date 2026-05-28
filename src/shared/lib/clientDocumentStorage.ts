import { randomUUID } from 'crypto';
import { mkdir, readFile, unlink, writeFile } from 'fs/promises';
import path from 'path';

export const MAX_CLIENT_DOCUMENT_SIZE = 20 * 1024 * 1024;

const ALLOWED_DOCUMENT_EXTENSIONS = new Map([
  ['pdf', 'application/pdf'],
  ['doc', 'application/msword'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xls', 'application/vnd.ms-excel'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['csv', 'text/csv'],
  ['txt', 'text/plain'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['webp', 'image/webp'],
]);

export type SavedClientDocumentFile = {
  originalName: string;
  mimeType: string;
  filePath: string;
  fileSize: number;
};

export async function saveClientDocumentUpload(companyId: number, file: File): Promise<SavedClientDocumentFile> {
  if (file.size <= 0) throw new Error('Файл пустой');
  if (file.size > MAX_CLIENT_DOCUMENT_SIZE) throw new Error('Файл должен быть не больше 20 МБ');

  const originalName = normalizeOriginalName(file.name);
  const extension = getAllowedExtension(originalName);
  if (!extension) {
    throw new Error('Можно загрузить PDF, Word, Excel, CSV, TXT или изображение');
  }

  const uploadDir = path.join(getUploadRoot(), 'client-documents', String(companyId));
  await mkdir(uploadDir, { recursive: true });

  const filename = `${Date.now()}-${randomUUID()}.${extension}`;
  const filePath = path.posix.join('client-documents', String(companyId), filename);
  const bytes = Buffer.from(await file.arrayBuffer());
  await writeFile(/*turbopackIgnore: true*/ path.join(uploadDir, filename), bytes);

  return {
    originalName,
    mimeType: file.type || ALLOWED_DOCUMENT_EXTENSIONS.get(extension) || 'application/octet-stream',
    filePath,
    fileSize: file.size,
  };
}

export async function readClientDocumentFile(filePath: string) {
  return readFile(/*turbopackIgnore: true*/ resolveClientDocumentPath(filePath));
}

export async function removeClientDocumentFile(filePath: string) {
  await unlink(/*turbopackIgnore: true*/ resolveClientDocumentPath(filePath)).catch(() => undefined);
}

function getAllowedExtension(filename: string) {
  const extension = path.extname(filename).replace('.', '').toLowerCase();
  if (!extension) return null;
  if (extension === 'jpeg') return 'jpg';
  return ALLOWED_DOCUMENT_EXTENSIONS.has(extension) ? extension : null;
}

function normalizeOriginalName(value: string) {
  return value.replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220) || 'document';
}

function resolveClientDocumentPath(filePath: string) {
  const uploadRoot = path.resolve(/*turbopackIgnore: true*/ getUploadRoot());
  const normalized = filePath.replace(/\\/g, '/');
  if (!normalized.startsWith('client-documents/')) {
    throw new Error('Некорректный путь файла');
  }

  const fullPath = path.resolve(/*turbopackIgnore: true*/ uploadRoot, normalized);
  if (!fullPath.startsWith(`${uploadRoot}${path.sep}`)) {
    throw new Error('Некорректный путь файла');
  }
  return fullPath;
}

function getUploadRoot() {
  const configuredPath = process.env.UPLOAD_DIR?.trim();
  if (configuredPath) return configuredPath;

  if (process.env.NODE_ENV === 'production' && process.platform !== 'win32') {
    return '/var/www/kts-uploads';
  }

  return path.join(/*turbopackIgnore: true*/ process.cwd(), 'public', 'uploads');
}
