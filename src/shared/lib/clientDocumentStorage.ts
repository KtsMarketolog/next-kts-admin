import { randomUUID } from 'crypto';
import { constants } from 'fs';
import { lstat, mkdir, open, realpath, unlink, writeFile } from 'fs/promises';
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
  if (!Number.isSafeInteger(companyId) || companyId <= 0) throw new Error('Некорректный клиент');
  if (file.size <= 0) throw new Error('Файл пустой');
  if (file.size > MAX_CLIENT_DOCUMENT_SIZE) throw new Error('Файл должен быть не больше 20 МБ');

  const originalName = normalizeOriginalName(file.name);
  const extension = getAllowedExtension(originalName);
  if (!extension) {
    throw new Error('Можно загрузить PDF, Word, Excel, CSV, TXT или изображение');
  }

  // Keep legacy relative paths and backup references, but never let the public
  // web-server user traverse this private subtree. Deployment also protects
  // existing roots before activation; this enforces the same rule on new ones.
  await mkdir(/*turbopackIgnore: true*/ getUploadRoot(), { recursive: true });
  const root = await realpath(/*turbopackIgnore: true*/ getUploadRoot());
  const privateRoot = path.join(root, 'client-documents');
  await ensurePrivateDirectory(privateRoot);
  const uploadDir = path.join(privateRoot, String(companyId));
  await ensurePrivateDirectory(uploadDir);

  const filename = `${Date.now()}-${randomUUID()}.${extension}`;
  const filePath = path.posix.join('client-documents', String(companyId), filename);
  const bytes = Buffer.from(await file.arrayBuffer());
  await writeFile(/*turbopackIgnore: true*/ path.join(uploadDir, filename), bytes, { flag: 'wx', mode: 0o600 });

  return {
    originalName,
    mimeType: file.type || ALLOWED_DOCUMENT_EXTENSIONS.get(extension) || 'application/octet-stream',
    filePath,
    fileSize: file.size,
  };
}

export async function readClientDocumentFile(filePath: string, companyId?: number) {
  const fullPath = resolveClientDocumentPath(filePath, companyId);
  const root = await realpath(/*turbopackIgnore: true*/ getUploadRoot());
  const actualParent = await realpath(/*turbopackIgnore: true*/ path.dirname(fullPath));
  if (actualParent !== path.join(root, path.dirname(filePath))) throw new Error('Небезопасный каталог документа');
  const file = await open(/*turbopackIgnore: true*/ fullPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error('Небезопасный файл документа');
    return await file.readFile();
  } finally {
    await file.close();
  }
}

async function ensurePrivateDirectory(directory: string) {
  try {
    await mkdir(/*turbopackIgnore: true*/ directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  // EEXIST is acceptable only for an ordinary directory owned by this app.
  const stat = await lstat(/*turbopackIgnore: true*/ directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Небезопасный каталог документа');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('Неверный владелец каталога документов');
  }
  const handle = await open(/*turbopackIgnore: true*/ directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (current.ino !== stat.ino || current.dev !== stat.dev) throw new Error('Каталог документов изменился');
    await handle.chmod(0o700);
    if (process.platform !== 'win32' && ((await handle.stat()).mode & 0o777) !== 0o700) {
      throw new Error('Не удалось закрыть публичный доступ к документам');
    }
  } finally {
    await handle.close();
  }
}

export async function removeClientDocumentFile(filePath: string, companyId?: number) {
  const fullPath = resolveClientDocumentPath(filePath, companyId);
  // A missing/unavailable storage root is not evidence that this exact file was
  // removed. Leave the durable request pending until storage is available again.
  const root = await realpath(/*turbopackIgnore: true*/ getUploadRoot());
  try {
    // A lexical prefix check alone does not protect against symlink directories.
    const expectedParent = path.join(root, path.dirname(filePath));
    const actualParent = await realpath(/*turbopackIgnore: true*/ path.dirname(fullPath));
    if (actualParent !== expectedParent) throw new Error('Небезопасный каталог документа');
    const stat = await lstat(/*turbopackIgnore: true*/ fullPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Небезопасный файл документа');
    await unlink(/*turbopackIgnore: true*/ fullPath);
    return 'removed' as const;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing' as const;
    // Permission/storage failures must remain visible to the durable cleanup queue.
    throw error;
  }
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

function resolveClientDocumentPath(filePath: string, companyId?: number) {
  const uploadRoot = path.resolve(/*turbopackIgnore: true*/ getUploadRoot());
  const match = /^client-documents\/([1-9]\d*)\/([a-zA-Z0-9][a-zA-Z0-9._-]*)$/.exec(filePath);
  if (!match || (companyId !== undefined && match[1] !== String(companyId))) {
    throw new Error('Некорректный путь файла');
  }

  const fullPath = path.resolve(/*turbopackIgnore: true*/ uploadRoot, filePath);
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
