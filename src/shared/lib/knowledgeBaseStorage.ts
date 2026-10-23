import { createHash, randomUUID } from 'crypto';
import { constants } from 'fs';
import { lstat, mkdir, open, realpath, unlink, type FileHandle } from 'fs/promises';
import path from 'path';
import { KNOWLEDGE_BASE_MAX_FILE_BYTES, KnowledgeBaseError, knowledgeBaseInvalid } from './knowledgeBase';
import { buildTopDashboardContentSecurityPolicy } from './topDashboardContentSecurity/policy';
import { prepareInteractiveDashboardHtml } from './topDashboardContentSecurity/preparedHtml';
import { createUploadRequestGuard } from './uploadRequestGuard';

const FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', csv: 'text/csv', html: 'text/html', htm: 'text/html',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
};
export type SavedKnowledgeBaseFile = { storagePath: string; originalName: string; mimeType: string; size: number; sha256: string };

export function knowledgeBaseFilename(value: string) {
  if (!value || value.length > 220 || /[\u0000-\u001f\u007f\\/]/.test(value)) throw knowledgeBaseInvalid();
  const name = value.trim();
  const extension = path.extname(name).slice(1).toLowerCase();
  if (!FILE_TYPES[extension]) throw new KnowledgeBaseError(415, 'UNSUPPORTED_FILE', 'Допустимы PDF, Word, Excel, PowerPoint, TXT, CSV, HTML и изображения JPG, PNG, WebP, GIF');
  return { name, extension, mimeType: FILE_TYPES[extension] };
}

function uploadRoot() {
  return process.env.UPLOAD_DIR?.trim() || (process.env.NODE_ENV === 'production' && process.platform !== 'win32'
    ? '/var/www/kts-uploads' : path.join(/*turbopackIgnore: true*/ process.cwd(), 'public', 'uploads'));
}

async function privateDirectory(create: boolean) {
  if (create) await mkdir(/*turbopackIgnore: true*/ uploadRoot(), { recursive: true });
  const root = await realpath(/*turbopackIgnore: true*/ uploadRoot());
  const directory = path.join(root, 'knowledge-base');
  if (create) {
    try { await mkdir(/*turbopackIgnore: true*/ directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const before = await lstat(/*turbopackIgnore: true*/ directory);
  if (!before.isDirectory() || before.isSymbolicLink() || (process.getuid && before.uid !== process.getuid())) throw new Error('Unsafe private storage');
  const handle = await open(/*turbopackIgnore: true*/ directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (current.ino !== before.ino || current.dev !== before.dev) throw new Error('Private directory changed');
    if (create && (current.mode & 0o7777) !== 0o700) await handle.chmod(0o700);
    if (process.platform !== 'win32' && ((await handle.stat()).mode & 0o7777) !== 0o700) throw new Error('Private storage is not isolated');
  } finally { await handle.close(); }
  return directory;
}

function safeStorageName(storagePath: string) {
  if (!/^knowledge-base\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+$/.test(storagePath)) throw new Error('Invalid private storage path');
  return path.basename(storagePath);
}

export async function openKnowledgeBaseFile(storagePath: string, expectedSize: number) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > KNOWLEDGE_BASE_MAX_FILE_BYTES) throw new Error('Invalid file size');
  const name = safeStorageName(storagePath);
  const directory = await privateDirectory(false);
  const file = await open(/*turbopackIgnore: true*/ path.join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== expectedSize || (process.getuid && stat.uid !== process.getuid())
      || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o600)) throw new Error('Unsafe private file');
    return file;
  } catch (error) { await file.close(); throw error; }
}

/** Only call for the exact new uncommitted file owned by this upload. Never bulk-clean storage. */
export async function removeUncommittedKnowledgeBaseFile(storagePath: string) {
  const name = safeStorageName(storagePath);
  const directory = await privateDirectory(false);
  const fullPath = path.join(directory, name);
  try {
    const stat = await lstat(/*turbopackIgnore: true*/ fullPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe cleanup target');
    await unlink(/*turbopackIgnore: true*/ fullPath);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

export function knowledgeBaseHtmlPolicy(html: string) {
  // Bound work before the shared HTML tokenizer/hash builder; many unterminated tags or
  // hundreds of thousands of tiny handlers must not amplify parser work.
  let scriptCount = 0;
  const markers = /<script\b|\son[a-z][\w:-]*\s*=/gi;
  while (markers.exec(html)) {
    if (++scriptCount > 50) throw new KnowledgeBaseError(422, 'HTML_POLICY_TOO_LARGE', 'В HTML слишком много отдельных скриптов. Объедините их перед загрузкой.');
  }
  // Reuse the exact author-script hashes, but no privileged dashboard bridge,
  // popups, same-origin, external connections, workers, forms or nested frames.
  const policy = buildTopDashboardContentSecurityPolicy(html)
    .replace('sandbox allow-scripts allow-popups', 'sandbox allow-scripts')
    .replace('worker-src blob:', "worker-src 'none'");
  // Keep the full response below standard Nginx's 4 KiB upstream header buffer.
  if (Buffer.byteLength(policy) > 3_000) throw new KnowledgeBaseError(422, 'HTML_POLICY_TOO_LARGE', 'В HTML слишком много отдельных скриптов. Объедините их перед загрузкой.');
  return policy;
}

function validateSignature(extension: string, bytes: Buffer) {
  const starts = (signature: number[]) => signature.every((value, index) => bytes[index] === value);
  const valid = extension === 'pdf' ? bytes.subarray(0, 5).toString() === '%PDF-'
    : ['doc', 'xls', 'ppt'].includes(extension) ? starts([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    : ['docx', 'xlsx', 'pptx'].includes(extension) ? starts([0x50, 0x4b, 0x03, 0x04])
    : ['jpg', 'jpeg'].includes(extension) ? starts([0xff, 0xd8, 0xff])
    : extension === 'png' ? starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    : extension === 'gif' ? /^GIF8[79]a/.test(bytes.subarray(0, 6).toString())
    : extension === 'webp' ? bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
    : !bytes.includes(0);
  if (!valid || bytes.subarray(0, 2).toString() === 'MZ' || starts([0x7f, 0x45, 0x4c, 0x46])) {
    throw new KnowledgeBaseError(415, 'INVALID_FILE_CONTENT', 'Содержимое файла не соответствует его расширению');
  }
}

export async function saveKnowledgeBaseUpload(request: Request, originalName: string): Promise<SavedKnowledgeBaseFile> {
  const type = knowledgeBaseFilename(originalName);
  const declared = request.headers.get('content-length');
  if (declared && (!/^[0-9]+$/.test(declared) || Number(declared) > KNOWLEDGE_BASE_MAX_FILE_BYTES)) {
    throw new KnowledgeBaseError(413, 'TOO_LARGE', 'Файл должен быть не больше 25 МБ');
  }
  const guard = createUploadRequestGuard(request, { maxBytes: KNOWLEDGE_BASE_MAX_FILE_BYTES, idleTimeoutMs: 30_000, totalTimeoutMs: 180_000 });
  let file: FileHandle | null = null;
  let storagePath: string | null = null;
  let success = false;
  try {
    if (!guard.request.body) throw knowledgeBaseInvalid();
    const directory = await privateDirectory(true);
    const filename = `${randomUUID()}.${type.extension}`;
    file = await open(/*turbopackIgnore: true*/ path.join(directory, filename), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    storagePath = `knowledge-base/${filename}`;
    const hash = createHash('sha256');
    const reader = guard.request.body.getReader();
    let size = 0;
    let prefix = Buffer.alloc(0);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        guard.assertActive();
        if (prefix.length < 512) prefix = Buffer.concat([prefix, Buffer.from(value.subarray(0, 512 - prefix.length))]);
        hash.update(value);
        let written = 0;
        while (written < value.byteLength) {
          const result = await file.write(value, written, value.byteLength - written, size + written);
          if (!result.bytesWritten) throw new Error('Storage write stalled');
          written += result.bytesWritten; guard.assertActive();
        }
        size += value.byteLength;
      }
    } finally { reader.releaseLock(); }
    if (!size) throw new KnowledgeBaseError(400, 'EMPTY_FILE', 'Файл пустой');
    validateSignature(type.extension, prefix);
    if (type.mimeType === 'text/html') {
      // This allocation occurs only after the bounded stream is fully written.
      let html: string;
      try { html = new TextDecoder('utf-8', { fatal: true }).decode(await file.readFile()); }
      catch { throw new KnowledgeBaseError(415, 'INVALID_HTML_ENCODING', 'Сохраните HTML в кодировке UTF-8 и загрузите снова'); }
      // Validate the exact derived preview, but retain the original file bytes.
      knowledgeBaseHtmlPolicy(prepareInteractiveDashboardHtml(html));
    }
    guard.assertActive();
    await file.sync();
    guard.assertActive();
    success = true;
    return { storagePath, originalName: type.name, mimeType: type.mimeType, size, sha256: hash.digest('hex') };
  } finally {
    guard.dispose();
    await file?.close();
    if (!success && storagePath) await removeUncommittedKnowledgeBaseFile(storagePath);
  }
}

/** Pull-based reads keep large documents bounded and close descriptors on cancellation. */
export function knowledgeBaseFileStream(file: FileHandle) {
  let position = 0;
  let closed = false;
  async function close() { if (!closed) { closed = true; await file.close(); } }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const buffer = new Uint8Array(64 * 1024);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
        if (closed) return;
        if (!bytesRead) { await close(); controller.close(); return; }
        position += bytesRead;
        controller.enqueue(buffer.subarray(0, bytesRead));
      } catch (error) { await close(); controller.error(error); }
    },
    cancel: close,
  }, { highWaterMark: 0 });
}
