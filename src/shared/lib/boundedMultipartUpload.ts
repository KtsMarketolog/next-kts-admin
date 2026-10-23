import busboy from 'busboy';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { createUploadRequestGuard, UploadRequestError } from './uploadRequestGuard';

export type BoundedMultipartUploadErrorCode = 'INVALID_MULTIPART' | 'TOO_MANY_PARTS' | 'INVALID_FIELD' | 'FIELD_TOO_LARGE';

const messages: Record<BoundedMultipartUploadErrorCode, string> = {
  INVALID_MULTIPART: 'Не удалось прочитать файл. Выберите его и повторите загрузку.',
  TOO_MANY_PARTS: 'В одном запросе передано слишком много файлов или полей.',
  INVALID_FIELD: 'Загрузка содержит неизвестное или повторяющееся поле.',
  FIELD_TOO_LARGE: 'Одно из полей загрузки превышает допустимый размер.',
};

export class BoundedMultipartUploadError extends Error {
  readonly status: 400 | 413;

  constructor(readonly code: BoundedMultipartUploadErrorCode) {
    super(messages[code]);
    this.name = 'BoundedMultipartUploadError';
    this.status = code === 'TOO_MANY_PARTS' || code === 'FIELD_TOO_LARGE' ? 413 : 400;
  }
}

export type BoundedMultipartUploadOptions = {
  /** Includes the multipart envelope, not only the file payload. */
  maxBodyBytes: number;
  maxFileBytes: number;
  maxFiles?: number;
  maxFields?: number;
  maxFieldBytes?: number;
  allowedFileFields?: readonly string[];
  allowedTextFields?: readonly string[];
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** Admission/owner cancellation, in addition to the incoming request signal. */
  signal?: AbortSignal;
};

/**
 * Parses only bounded multipart input. Limits apply while streaming, before
 * constructing File/FormData values; a false/missing Content-Length cannot
 * bypass them. Callers must authorize first and hold their admission slot until
 * all subsequent processing and file writes have finished.
 */
export async function readBoundedMultipartUpload(
  request: Request,
  options: BoundedMultipartUploadOptions,
): Promise<FormData> {
  const maxFiles = options.maxFiles ?? 1;
  const maxFields = options.maxFields ?? 8;
  const maxFieldBytes = options.maxFieldBytes ?? 4096;
  for (const value of [options.maxBodyBytes, options.maxFileBytes, maxFiles, maxFieldBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError('Multipart resource limits must be positive safe integers.');
    }
  }
  if (!Number.isSafeInteger(maxFields) || maxFields < 0 || !Number.isSafeInteger(maxFiles + maxFields + 1)) {
    throw new RangeError('Multipart field count must be a non-negative safe integer.');
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.length > 1024 || !/^multipart\/form-data\s*;/i.test(contentType)) {
    throw new BoundedMultipartUploadError('INVALID_MULTIPART');
  }
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) throw new BoundedMultipartUploadError('INVALID_MULTIPART');
    if (Number(declaredLength) > options.maxBodyBytes) throw new UploadRequestError('TOO_LARGE');
  }
  if (!request.body) throw new BoundedMultipartUploadError('INVALID_MULTIPART');

  let parser: busboy.Busboy;
  try {
    parser = busboy({
      headers: { 'content-type': contentType },
      defParamCharset: 'utf8',
      highWaterMark: 64 * 1024,
      fileHwm: 64 * 1024,
      limits: {
        files: maxFiles,
        fields: maxFields,
        // Busboy signals size/parts limits at equality. Our public limits are
        // inclusive, so the sentinel byte/part is never retained in the result.
        fileSize: options.maxFileBytes + 1,
        fieldSize: maxFieldBytes + 1,
        parts: maxFiles + maxFields + 1,
      },
    });
  } catch {
    throw new BoundedMultipartUploadError('INVALID_MULTIPART');
  }

  const guardedRequest = options.signal
    ? new Request(request, { signal: AbortSignal.any([request.signal, options.signal]) })
    : request;
  const guard = createUploadRequestGuard(guardedRequest, {
    maxBytes: options.maxBodyBytes,
    idleTimeoutMs: options.idleTimeoutMs,
    totalTimeoutMs: options.totalTimeoutMs,
  });
  const result = new FormData();
  const seenNames = new Set<string>();
  const allowedFiles = new Set(options.allowedFileFields ?? ['file']);
  const allowedFields = options.allowedTextFields ? new Set(options.allowedTextFields) : null;
  let failure: UploadRequestError | BoundedMultipartUploadError | null = null;

  function fail(error: UploadRequestError | BoundedMultipartUploadError) {
    if (failure) return;
    failure = error;
    // Busboy may still be updating the current file stream in this callback.
    // Defer destruction one microtask; failure prevents retaining further data.
    queueMicrotask(() => parser.destroy(error));
  }

  function acceptName(name: string, allowedNames: ReadonlySet<string> | null) {
    if (typeof name !== 'string' || !name || Buffer.byteLength(name) > 128
      || seenNames.has(name) || (allowedNames && !allowedNames.has(name))) {
      fail(new BoundedMultipartUploadError('INVALID_FIELD'));
      return false;
    }
    seenNames.add(name);
    return true;
  }

  parser.on('filesLimit', () => fail(new BoundedMultipartUploadError('TOO_MANY_PARTS')));
  parser.on('fieldsLimit', () => fail(new BoundedMultipartUploadError('TOO_MANY_PARTS')));
  parser.on('partsLimit', () => fail(new BoundedMultipartUploadError('TOO_MANY_PARTS')));
  parser.on('field', (name, value, info) => {
    if (failure || !acceptName(name, allowedFields)) return;
    if (info.nameTruncated || info.valueTruncated || Buffer.byteLength(value) > maxFieldBytes) {
      fail(new BoundedMultipartUploadError('FIELD_TOO_LARGE'));
      return;
    }
    result.append(name, value);
  });
  parser.on('file', (name, stream, info) => {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let block: Uint8Array<ArrayBuffer> | null = null;
    let filled = 0;
    let bytes = 0;
    // Destroying the parser propagates an error to the current file stream.
    // Always handle it, including validation rejection before the first byte.
    stream.on('error', () => undefined);
    if (failure || !acceptName(name, allowedFiles)) {
      stream.resume();
      return;
    }
    if (typeof info.filename !== 'string' || Buffer.byteLength(info.filename) > 1024) {
      fail(new BoundedMultipartUploadError('INVALID_FIELD'));
      stream.resume();
      return;
    }
    stream.on('limit', () => fail(new UploadRequestError('TOO_LARGE')));
    stream.on('data', (chunk: Buffer) => {
      if (failure) return;
      bytes += chunk.byteLength;
      if (bytes > options.maxFileBytes) {
        fail(new UploadRequestError('TOO_LARGE'));
        return;
      }
      // Request streams may deliver one-byte chunks. Retain a bounded number
      // of 64 KiB blocks, not an object per network chunk.
      let offset = 0;
      while (offset < chunk.byteLength) {
        block ??= new Uint8Array(64 * 1024);
        const count = Math.min(block.byteLength - filled, chunk.byteLength - offset);
        block.set(chunk.subarray(offset, offset + count), filled);
        filled += count;
        offset += count;
        if (filled === block.byteLength) {
          chunks.push(block);
          block = null;
          filled = 0;
        }
      }
    });
    stream.on('end', () => {
      if (failure) return;
      if (stream.truncated) {
        fail(new UploadRequestError('TOO_LARGE'));
        return;
      }
      if (block && filled) chunks.push(block.subarray(0, filled));
      result.append(name, new File(chunks, info.filename, { type: info.mimeType }));
    });
  });

  try {
    await pipeline(
      Readable.fromWeb(guard.request.body! as NodeReadableStream<Uint8Array>),
      parser,
      { signal: guard.request.signal },
    );
    guard.assertActive();
    if (failure) throw failure;
    return result;
  } catch (error) {
    if (guard.error) throw guard.error;
    if (failure) throw failure;
    if (error instanceof UploadRequestError || error instanceof BoundedMultipartUploadError) throw error;
    throw new BoundedMultipartUploadError('INVALID_MULTIPART');
  } finally {
    guard.dispose();
  }
}
