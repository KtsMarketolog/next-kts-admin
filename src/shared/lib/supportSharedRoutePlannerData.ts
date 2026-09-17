import { createHash, timingSafeEqual } from 'node:crypto';
import { read, type ReadStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Tokenizer, TokenParser, TokenType, type ParsedTokenInfo } from '@streamparser/json';

import { PersonalDashboardError } from './managerDashboardDomain';
import {
  openTopDashboardDataFile,
  TopDashboardDataStreamError,
  writeTopDashboardRequestToPendingFile,
  type PendingTopDashboardDataFile,
} from './topDashboardDataStorage';

export const SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES = 16 * 1024 * 1024;
export const SUPPORT_SHARED_JSON_MAX_BYTES = 100 * 1024 * 1024;
export const SUPPORT_SHARED_JSON_MAX_VERSIONS = 2;
export const SUPPORT_SHARED_JSON_TOTAL_MAX_BYTES = 1024 * 1024 * 1024;

const MAX_DEPTH = 64;
const MAX_TOKEN_BYTES = 1024 * 1024;
const MAX_NUMBER_BYTES = 128;
const MAX_KEY_CHARS = 4096;
const MAX_ARRAY_ITEMS = 1_000_000;
const MAX_OBJECT_PROPERTIES = 100_000;
const PARSER_CHUNK_BYTES = 16 * 1024;
const ARRAY_FIELDS = new Set(['orders', 'confirmed', 'zones', 'addrs', 'contacts', 'tk', 'nomen', 'depots', 'files']);
const OBJECT_FIELDS = new Set(['aliases', 'opt', 'f', 'diag']);
const REQUIRED_FIELDS = ['snapshot', 'app', 'savedAt', ...ARRAY_FIELDS, ...OBJECT_FIELDS, 'winding', 'rate'];
const OPTION_NUMBERS = new Set(['maxPoints', 'maxWeight', 'maxVol', 'innerKm']);
const OPTION_BOOLEANS = new Set(['splitByOrg', 'splitByWh']);
const FILTER_STRINGS = new Set(['from', 'to', 'ordFrom', 'ordTo']);
const FILTER_ARRAYS = new Set(['zone', 'org', 'dir', 'wh', 'author']);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function invalid(): never {
  throw new PersonalDashboardError('INVALID_SNAPSHOT', 'Файл не является полным JSON-снимком компоновщика рейсов');
}

function tooLarge(): never {
  throw new PersonalDashboardError('SNAPSHOT_SIZE', 'Превышен допустимый размер или сложность JSON-снимка');
}

function validSavedAt(value: unknown): string {
  // The source application exports Date.toISOString(); permit omitted milliseconds too.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) {
    throw new PersonalDashboardError('INVALID_DATE', 'Некорректная дата JSON-снимка');
  }
  const date = new Date(value);
  const normalized = value.replace(/(?:\.(\d{1,3}))?Z$/u, (_match, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalized) {
    throw new PersonalDashboardError('INVALID_DATE', 'Некорректная дата JSON-снимка');
  }
  return value;
}

type Container = {
  kind: 'object' | 'array';
  path: string[];
  expectingKey: boolean;
  key?: string;
  members: number;
  keys?: Set<string>;
};

/** No emitted values or ancestors are retained, including the orders array. */
function snapshotValidator() {
  const tokenizer = new Tokenizer({ stringBufferSize: PARSER_CHUNK_BYTES, numberBufferSize: 128 });
  const parser = new TokenParser({ paths: [], keepStack: false });
  const stack: Container[] = [];
  let savedAt: string | undefined;
  let complete = false;
  let lexicalState: 'outside' | 'string' | 'number' = 'outside';
  let escaped = false;
  let tokenBytes = 0;
  let totalBytes = 0;
  const utf8 = new TextDecoder('utf-8', { fatal: true });

  function validateValue(parent: Container, info: ParsedTokenInfo) {
    const { token, value } = info;
    const key = parent.key;
    if (parent.path.length === 0) {
      if (ARRAY_FIELDS.has(key!) && token !== TokenType.LEFT_BRACKET) invalid();
      if (OBJECT_FIELDS.has(key!) && token !== TokenType.LEFT_BRACE) invalid();
      if (key === 'snapshot' && token !== TokenType.TRUE) invalid();
      if (key === 'app' && (token !== TokenType.STRING || value !== 'компоновщик')) invalid();
      if (key === 'savedAt') savedAt = validSavedAt(value);
      if ((key === 'winding' || key === 'rate') && (token !== TokenType.NUMBER || Number(value) < 0)) invalid();
    } else if (parent.path.length === 1) {
      const field = parent.path[0];
      if (ARRAY_FIELDS.has(field) && token !== TokenType.LEFT_BRACE) invalid();
      if (field === 'aliases' && token !== TokenType.STRING) invalid();
      if (field === 'opt') {
        if (OPTION_NUMBERS.has(key!) && (token !== TokenType.NUMBER || Number(value) < 0)) invalid();
        if (OPTION_BOOLEANS.has(key!) && token !== TokenType.TRUE && token !== TokenType.FALSE) invalid();
      }
      if (field === 'f') {
        if (FILTER_STRINGS.has(key!) && token !== TokenType.STRING) invalid();
        if (FILTER_ARRAYS.has(key!) && token !== TokenType.LEFT_BRACKET) invalid();
        if (key === 'onlyConfirmed' && token !== TokenType.TRUE && token !== TokenType.FALSE) invalid();
      }
      if (field === 'diag' && token !== TokenType.LEFT_BRACKET) invalid();
    } else if (parent.path.length === 2 && parent.path[0] === 'f' && FILTER_ARRAYS.has(parent.path[1]) && token !== TokenType.STRING) {
      invalid();
    }
  }

  tokenizer.onToken = (info) => {
    const { token, value } = info;
    const parent = stack.at(-1);
    if (token === TokenType.STRING && typeof value === 'string' && value.length > MAX_TOKEN_BYTES) tooLarge();
    if (token === TokenType.NUMBER && !Number.isFinite(value)) invalid();

    if (token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET) {
      // Let the grammar parser reject mismatched braces and trailing commas first.
      parser.write(info);
      const ended = stack.pop();
      if (!ended) invalid();
      if (ended.path.length === 0) {
        if (!REQUIRED_FIELDS.every((field) => ended.keys?.has(field)) || !savedAt) invalid();
        complete = true;
      } else if (ended.path.length === 1 && ended.path[0] === 'opt') {
        if (![...OPTION_NUMBERS, ...OPTION_BOOLEANS].every((field) => ended.keys?.has(field))) invalid();
      } else if (ended.path.length === 1 && ended.path[0] === 'f') {
        if (![...FILTER_STRINGS, ...FILTER_ARRAYS, 'onlyConfirmed'].every((field) => ended.keys?.has(field))) invalid();
      }
      return;
    }
    if (token === TokenType.COLON || token === TokenType.COMMA) {
      parser.write(info);
      if (parent && token === TokenType.COMMA && parent.kind === 'object') parent.expectingKey = true;
      return;
    }
    if (parent?.kind === 'object' && parent.expectingKey) {
      if (token !== TokenType.STRING || typeof value !== 'string') invalid();
      if (value.length > MAX_KEY_CHARS) tooLarge();
      if (UNSAFE_KEYS.has(value) || parent.keys?.has(value)) invalid();
      parent.key = value;
      parent.expectingKey = false;
      parent.keys?.add(value);
      if (parent.keys && parent.keys.size > 128) tooLarge();
      parser.write(info);
      return;
    }
    if (!parent) {
      if (complete || token !== TokenType.LEFT_BRACE) invalid();
    } else {
      parent.members += 1;
      if (parent.members > (parent.kind === 'array' ? MAX_ARRAY_ITEMS : MAX_OBJECT_PROPERTIES)) tooLarge();
      validateValue(parent, info);
    }
    if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) {
      if (stack.length >= MAX_DEPTH) tooLarge();
      const path = parent ? [...parent.path, parent.kind === 'array' ? '*' : parent.key!] : [];
      stack.push({
        kind: token === TokenType.LEFT_BRACE ? 'object' : 'array', path,
        expectingKey: token === TokenType.LEFT_BRACE, members: 0,
        keys: path.length === 0 || (path.length === 1 && ['opt', 'f'].includes(path[0])) ? new Set() : undefined,
      });
    }
    parser.write(info);
  };

  // Cap lexical tokens BEFORE handing them to a parser that buffers each string/number.
  function boundTokens(chunk: Buffer) {
    for (const byte of chunk) {
      if (lexicalState === 'string') {
        if (++tokenBytes > MAX_TOKEN_BYTES) tooLarge();
        if (escaped) escaped = false;
        else if (byte === 0x5c) escaped = true;
        else if (byte === 0x22) lexicalState = 'outside';
      } else {
        if (lexicalState === 'number') {
          if ((byte >= 0x30 && byte <= 0x39) || byte === 0x2b || byte === 0x2d || byte === 0x2e || byte === 0x45 || byte === 0x65) {
            if (++tokenBytes > MAX_NUMBER_BYTES) tooLarge();
            continue;
          }
          lexicalState = 'outside';
        }
        if (byte === 0x22) { lexicalState = 'string'; tokenBytes = 0; }
        else if (byte === 0x2d || (byte >= 0x30 && byte <= 0x39)) { lexicalState = 'number'; tokenBytes = 1; }
      }
    }
  }

  return {
    write(chunk: Buffer) {
      totalBytes += chunk.length;
      if (totalBytes > SUPPORT_SHARED_JSON_MAX_BYTES) tooLarge();
      // Even a single oversized upstream chunk cannot grow a token unboundedly.
      for (let offset = 0; offset < chunk.length; offset += PARSER_CHUNK_BYTES) {
        const part = chunk.subarray(offset, offset + PARSER_CHUNK_BYTES);
        boundTokens(part);
        utf8.decode(part, { stream: true });
        tokenizer.write(part);
      }
    },
    end() {
      utf8.decode();
      tokenizer.end();
      if (!parser.isEnded) parser.end();
      if (!complete || stack.length || !savedAt) invalid();
      return savedAt;
    },
  };
}

function uploadError(error: unknown): PersonalDashboardError {
  if (error instanceof PersonalDashboardError) return error;
  if (error instanceof TopDashboardDataStreamError && error.code === 'TOO_LARGE') {
    return new PersonalDashboardError('SNAPSHOT_SIZE', 'Превышен допустимый размер JSON-снимка');
  }
  if (error instanceof TopDashboardDataStreamError && error.code === 'UNAVAILABLE') {
    return new PersonalDashboardError('STORAGE_UNAVAILABLE', 'Хранилище JSON-снимков недоступно');
  }
  if (['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EMFILE', 'ENFILE'].includes((error as NodeJS.ErrnoException)?.code ?? '')) {
    return new PersonalDashboardError('STORAGE_UNAVAILABLE', 'Хранилище JSON-снимков недоступно');
  }
  return new PersonalDashboardError('INVALID_SNAPSHOT', 'Не удалось прочитать полный JSON-снимок компоновщика рейсов');
}

export async function prepareSupportSharedRoutePlannerUpload(request: Request): Promise<{
  pending: PendingTopDashboardDataFile;
  savedAt: string;
}> {
  if (!request.body) invalid();
  const encoding = request.headers.get('content-encoding')?.trim().toLowerCase();
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/gzip' || (encoding && encoding !== 'identity')) invalid();
  const source = Readable.fromWeb(request.body as import('node:stream/web').ReadableStream);
  let pending: PendingTopDashboardDataFile | undefined;
  try {
    let transportSize = 0;
    const declaredSize = request.headers.get('content-length');
    if (declaredSize && (!/^\d+$/u.test(declaredSize) || Number(declaredSize) > SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES)) tooLarge();
    const input = Readable.from((async function* () {
      for await (const chunk of source) {
        transportSize += chunk.length;
        if (transportSize > SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES) tooLarge();
        yield chunk;
      }
    })());
    const validator = snapshotValidator();
    let savedAt: string | undefined;
    const checked = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try { validator.write(chunk); callback(null, chunk); }
        catch (error) { callback(uploadError(error)); }
      },
      flush(callback) {
        try { savedAt = validator.end(); callback(); }
        catch (error) { callback(uploadError(error)); }
      },
    });
    const copy = pipeline(input, createGunzip(), checked);
    const plainRequest = new Request('http://localhost/internal-route-planner-upload', {
      method: 'POST', body: Readable.toWeb(checked) as ReadableStream<Uint8Array>, duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const write = writeTopDashboardRequestToPendingFile(plainRequest, SUPPORT_SHARED_JSON_MAX_BYTES)
      .then((file) => { pending = file; })
      .catch((error: unknown) => { checked.destroy(uploadError(error)); throw error; });
    const results = await Promise.allSettled([copy, write]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    if (!pending || !savedAt) invalid();
    return { pending, savedAt };
  } catch (error) {
    await pending?.discard().catch(() => {});
    throw uploadError(error);
  } finally {
    source.destroy();
  }
}

/** Verify using positioned reads, then serve from the same untouched descriptor. */
export async function openVerifiedSupportSharedRoutePlannerFile(
  storagePath: string,
  fileSize: number,
  sha256: string,
): Promise<ReadStream> {
  let stream: ReadStream | undefined;
  try {
    if (!Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > SUPPORT_SHARED_JSON_MAX_BYTES || !/^[a-f0-9]{64}$/u.test(sha256)) invalid();
    stream = await openTopDashboardDataFile(storagePath, fileSize);
    // Node exposes fd at runtime; @types/node omits it from ReadStream.
    const fd = (stream as ReadStream & { fd: number }).fd;
    if (!Number.isInteger(fd) || fd < 0) invalid();
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    for (;;) {
      const bytesRead = await new Promise<number>((resolve, reject) => {
        read(fd, buffer, 0, buffer.length, size, (error, count) => error ? reject(error) : resolve(count));
      });
      if (!bytesRead) break;
      size += bytesRead;
      if (size > fileSize) invalid();
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (size !== fileSize || !timingSafeEqual(hash.digest(), Buffer.from(sha256, 'hex'))) invalid();
    return stream;
  } catch {
    stream?.destroy();
    throw new PersonalDashboardError('SNAPSHOT_INTEGRITY', 'Не удалось проверить целостность JSON-снимка');
  }
}
