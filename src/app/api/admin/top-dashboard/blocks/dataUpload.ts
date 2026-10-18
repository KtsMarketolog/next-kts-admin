import { createHash } from 'crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { createGunzip } from 'zlib';
import {
  JSONParser,
  TokenParserError,
  TokenizerError,
  TokenType,
  type ParsedTokenInfo,
} from '@streamparser/json';

import {
  TOP_DASHBOARD_DATA_MAX_BYTES,
  TOP_DASHBOARD_DATA_MAX_UNCOMPRESSED_BYTES,
  TOP_DASHBOARD_DATA_MAX_UNCOMPRESSED_LABEL,
  TOP_DASHBOARD_DATA_MULTIPART_MAX_BYTES,
  TOP_DASHBOARD_DATA_MULTIPART_MAX_MEGABYTES,
  TOP_DASHBOARD_DATA_MULTIPART_OVERHEAD_BYTES,
  TOP_DASHBOARD_JSON_RESOURCE_LIMITS,
} from '@/shared/lib/topDashboardLimits';
import type { PendingTopDashboardDataFile } from '@/shared/lib/topDashboardDataStorage';
import { createDashboardSnapshotDateInspector } from '@/shared/lib/dashboardSnapshotDate';
import {
  createSnapshotJsonResourceGuard,
  SNAPSHOT_JSON_PROCESSING_CHUNK_BYTES,
  SnapshotJsonResourceError,
} from '@/shared/lib/snapshotJsonResourceGuard';

import { parsePositiveId } from './routeUtils';
import {
  readStreamExpectedActiveVersionId,
  readStreamOriginalName,
  receiveTopDashboardDataStream,
} from './streamDataUpload';

export const MAX_TOP_DASHBOARD_DATA_BYTES = TOP_DASHBOARD_DATA_MAX_BYTES;
export const MAX_TOP_DASHBOARD_DATA_UNCOMPRESSED_BYTES =
  TOP_DASHBOARD_DATA_MAX_UNCOMPRESSED_BYTES;

const MAX_KTS_BUNDLE_ROWS = 500_000;

const INVALID_UTF8 = 'INVALID_UTF8';
const UNCOMPRESSED_TOO_LARGE = 'UNCOMPRESSED_TOO_LARGE';

export type TopDashboardSnapshotFormat = 'kts-bundle-v1' | 'purchases-v1';
export type TopDashboardDataProfile =
  | 'sales-analytics'
  | 'assortment-optimization'
  | 'purchases';

export type TopDashboardDataUpload = {
  originalName: string;
  content: Buffer | null;
  storagePath: string | null;
  pendingFile?: PendingTopDashboardDataFile;
  fileSize: number;
  uncompressedSize: number;
  sha256: string;
  snapshotFormat: TopDashboardSnapshotFormat;
  // Advisory legacy metadata only. Optional sections are shared by different
  // reports; the published HTML determines the persisted profile on upload.
  dashboardProfile: TopDashboardDataProfile | null;
  dataAsOf: string | null;
};

type ParsedTopDashboardDataUpload = {
  upload: TopDashboardDataUpload;
  expectedActiveVersionId: number | null;
};

type UploadResult =
  | { parsed: ParsedTopDashboardDataUpload; error?: never }
  | { parsed?: never; error: Response };

function errorResponse(error: string, status = 400) {
  return Response.json({ error }, { status });
}

function normalizeOriginalName(value: string) {
  const cleaned = value
    .replace(/[\\/:*?"<>|\r\n\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const extension = /\.json\.gz$/i.test(cleaned) ? cleaned.slice(-8) : cleaned.slice(-5);
  const baseName = cleaned.slice(0, -extension.length).trim();
  const maxBaseLength = 220 - extension.length;
  return `${baseName.slice(0, maxBaseLength).trim() || 'dashboard-data'}${extension}`;
}

function contentLengthTooLarge(request: Request) {
  const value = request.headers.get('content-length');
  if (!value) return false;
  const length = Number(value);
  return Number.isFinite(length)
    && length > TOP_DASHBOARD_DATA_MULTIPART_MAX_BYTES
      + TOP_DASHBOARD_DATA_MULTIPART_OVERHEAD_BYTES;
}

function parseExpectedActiveVersionId(
  value: FormDataEntryValue | null,
): { value: number | null; error?: never } | { value?: never; error: string } {
  if (value === null || value === '') return { value: null };
  if (typeof value !== 'string') return { error: 'Некорректная активная версия данных' };
  const id = parsePositiveId(value);
  return id ? { value: id } : { error: 'Некорректная активная версия данных' };
}

type JsonInspection = {
  size: number;
  signature: SnapshotSignature;
  dataAsOf: string | null;
};

type SnapshotField =
  | { kind: 'object' | 'array' | 'null' }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean };

type SnapshotSignature = {
  rootObject: boolean;
  fields: Map<string, SnapshotField>;
  extraKeys: Set<string>;
};

type SignatureState = 'key' | 'colon' | 'value' | 'delimiter' | 'nested';

type SnapshotSignatureTracker = {
  rootSeen: boolean;
  rootObject: boolean;
  depth: number;
  state: SignatureState;
  key: string | null;
  fields: Map<string, SnapshotField>;
  extraDepth: number | null;
  extraState: SignatureState;
  extraKey: string | null;
  extraKeys: Set<string>;
};

type JsonStreamInspector = {
  size: number;
  parser: JSONParser;
  decoder: TextDecoder;
  signature: SnapshotSignatureTracker;
  dates: ReturnType<typeof createDashboardSnapshotDateInspector>;
  resources: ReturnType<typeof createSnapshotJsonResourceGuard>;
};

const SNAPSHOT_SIGNATURE_KEYS = new Set([
  'format',
  'version',
  'n',
  'dict',
  'cols',
  'extra',
  'v',
  'raw',
  'meta',
  'params',
]);

const SALES_PROFILE_KEYS = ['plan', 'hr', 'timesheets', 'opex', 'alloc'];
const ASSORTMENT_PROFILE_KEYS = ['reserve', 'transit', 'otherWh'];
const SNAPSHOT_PROFILE_KEYS = new Set([...SALES_PROFILE_KEYS, ...ASSORTMENT_PROFILE_KEYS, 'actual']);

function createSnapshotSignatureTracker(): SnapshotSignatureTracker {
  return {
    rootSeen: false,
    rootObject: false,
    depth: 0,
    state: 'key',
    key: null,
    fields: new Map(),
    extraDepth: null,
    extraState: 'key',
    extraKey: null,
    extraKeys: new Set(),
  };
}

function tokenSnapshotField(token: TokenType, value: ParsedTokenInfo['value']): SnapshotField | null {
  if (token === TokenType.LEFT_BRACE) return { kind: 'object' };
  if (token === TokenType.LEFT_BRACKET) return { kind: 'array' };
  if (token === TokenType.STRING) return { kind: 'string', value: value as string };
  if (token === TokenType.NUMBER) return { kind: 'number', value: value as number };
  if (token === TokenType.TRUE || token === TokenType.FALSE) {
    return { kind: 'boolean', value: value as boolean };
  }
  if (token === TokenType.NULL) return { kind: 'null' };
  return null;
}

function recordTopLevelField(
  tracker: SnapshotSignatureTracker,
  token: TokenType,
  value: ParsedTokenInfo['value'],
) {
  if (!tracker.key || !SNAPSHOT_SIGNATURE_KEYS.has(tracker.key)) return;
  const field = tokenSnapshotField(token, value);
  if (field) {
    // Only the short format identifier is used as text. Keep types, not large
    // arbitrary strings attached to recognized signature fields.
    tracker.fields.set(tracker.key, field.kind === 'string'
      ? { kind: 'string', value: tracker.key === 'format' && field.value.length <= 64 ? field.value : '' }
      : field);
  }
}

function inspectSnapshotSignatureToken(
  tracker: SnapshotSignatureTracker,
  { token, value }: ParsedTokenInfo,
) {
  if (!tracker.rootSeen) {
    tracker.rootSeen = true;
    tracker.rootObject = token === TokenType.LEFT_BRACE;
    if (tracker.rootObject) tracker.depth = 1;
    return;
  }

  if (!tracker.rootObject || tracker.depth <= 0) return;

  if (tracker.depth > 1) {
    if (tracker.extraDepth !== null && tracker.depth === tracker.extraDepth) {
      if (tracker.extraState === 'key') {
        if (token === TokenType.STRING) {
          tracker.extraKey = SNAPSHOT_PROFILE_KEYS.has(value as string) ? value as string : null;
          tracker.extraState = 'colon';
        } else if (token === TokenType.RIGHT_BRACE) {
          tracker.depth -= 1;
          tracker.extraDepth = null;
          tracker.state = 'delimiter';
          tracker.key = null;
        }
        return;
      }

      if (tracker.extraState === 'colon') {
        if (token === TokenType.COLON) tracker.extraState = 'value';
        return;
      }

      if (tracker.extraState === 'value') {
        const field = tokenSnapshotField(token, value);
        if (!field) return;
        if (tracker.extraKey !== null) {
          // Shared exports include null placeholders for unused report inputs.
          // Track only non-null profile markers, with JSON's last-value-wins
          // semantics, without retaining the potentially large nested values.
          if (field.kind === 'null') tracker.extraKeys.delete(tracker.extraKey);
          else tracker.extraKeys.add(tracker.extraKey);
        }
        tracker.extraKey = null;
        if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) {
          tracker.depth += 1;
          tracker.extraState = 'nested';
        } else {
          tracker.extraState = 'delimiter';
        }
        return;
      }

      if (tracker.extraState === 'delimiter') {
        if (token === TokenType.COMMA) {
          tracker.extraState = 'key';
        } else if (token === TokenType.RIGHT_BRACE) {
          tracker.depth -= 1;
          tracker.extraDepth = null;
          tracker.state = 'delimiter';
          tracker.key = null;
        }
        return;
      }
    }

    if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) {
      tracker.depth += 1;
      return;
    }
    if (token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET) {
      tracker.depth -= 1;
      if (tracker.extraDepth !== null && tracker.depth === tracker.extraDepth) {
        tracker.extraState = 'delimiter';
      } else if (tracker.depth === 1) {
        tracker.state = 'delimiter';
        tracker.key = null;
      }
    }
    return;
  }

  if (tracker.state === 'key') {
    if (token === TokenType.STRING) {
      tracker.key = SNAPSHOT_SIGNATURE_KEYS.has(value as string) ? value as string : null;
      tracker.state = 'colon';
    } else if (token === TokenType.RIGHT_BRACE) {
      tracker.depth = 0;
    }
    return;
  }

  if (tracker.state === 'colon') {
    if (token === TokenType.COLON) tracker.state = 'value';
    return;
  }

  if (tracker.state === 'value') {
    const field = tokenSnapshotField(token, value);
    if (!field) return;
    if (tracker.key === 'extra') {
      tracker.extraKeys.clear();
      tracker.extraDepth = null;
      tracker.extraKey = null;
    }
    recordTopLevelField(tracker, token, value);
    if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) {
      tracker.depth += 1;
      tracker.state = 'nested';
      if (tracker.key === 'extra' && token === TokenType.LEFT_BRACE) {
        tracker.extraDepth = tracker.depth;
        tracker.extraState = 'key';
      }
    } else {
      tracker.state = 'delimiter';
      tracker.key = null;
    }
    return;
  }

  if (tracker.state === 'delimiter') {
    if (token === TokenType.COMMA) {
      tracker.state = 'key';
    } else if (token === TokenType.RIGHT_BRACE) {
      tracker.depth = 0;
    }
  }
}

function createJsonStreamInspector(): JsonStreamInspector {
  const signature = createSnapshotSignatureTracker();
  const dates = createDashboardSnapshotDateInspector();
  const parser = new JSONParser({
    paths: [],
    keepStack: false,
    stringBufferSize: 64 * 1024,
    numberBufferSize: 64,
  });
  parser.onToken = (token) => { inspectSnapshotSignatureToken(signature, token); dates.visit(token); };

  return {
    size: 0,
    parser,
    dates,
    decoder: new TextDecoder('utf-8', { fatal: true }),
    signature,
    resources: createSnapshotJsonResourceGuard(TOP_DASHBOARD_JSON_RESOURCE_LIMITS),
  };
}

function writeJsonInspectionChunk(inspector: JsonStreamInspector, chunk: Buffer) {
  inspector.size += chunk.length;
  if (inspector.size > MAX_TOP_DASHBOARD_DATA_UNCOMPRESSED_BYTES) {
    throw new Error(UNCOMPRESSED_TOO_LARGE);
  }

  // Scan before the tokenizer can accumulate an entire string/key/number.
  inspector.resources.write(chunk, (slice) => {
    try {
      inspector.decoder.decode(slice, { stream: true });
    } catch {
      throw new Error(INVALID_UTF8);
    }
    inspector.parser.write(slice);
  });
}

function finishJsonInspection(inspector: JsonStreamInspector): JsonInspection {
  inspector.resources.finish(() => {
    try {
      inspector.decoder.decode();
    } catch {
      throw new Error(INVALID_UTF8);
    }
    if (!inspector.parser.isEnded) inspector.parser.end();
  });
  return {
    size: inspector.size,
    dataAsOf: inspector.dates.result(),
    signature: {
      rootObject: inspector.signature.rootObject,
      fields: inspector.signature.fields,
      extraKeys: inspector.signature.extraKeys,
    },
  };
}

function inspectJsonBuffer(bytes: Buffer, signal?: AbortSignal) {
  return inspectJsonReadable(Readable.from([bytes]), false, MAX_TOP_DASHBOARD_DATA_UNCOMPRESSED_BYTES, signal);
}

async function inspectJsonReadable(
  source: Readable,
  isGzip: boolean,
  maxUncompressedBytes = MAX_TOP_DASHBOARD_DATA_UNCOMPRESSED_BYTES,
  signal?: AbortSignal,
) {
  const inspector = createJsonStreamInspector();
  let lastYieldAt = performance.now();
  const inspect = async (readable: AsyncIterable<Buffer | Uint8Array | string>) => {
    for await (const chunk of readable) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (inspector.size + bytes.length > maxUncompressedBytes) {
        throw new Error(UNCOMPRESSED_TOO_LARGE);
      }
      for (let offset = 0; offset < bytes.length; offset += SNAPSHOT_JSON_PROCESSING_CHUNK_BYTES) {
        signal?.throwIfAborted();
        writeJsonInspectionChunk(inspector, bytes.subarray(offset, offset + SNAPSHOT_JSON_PROCESSING_CHUNK_BYTES));
        if (performance.now() - lastYieldAt >= 8) {
          // A large valid table must not monopolize the web server event loop.
          await yieldToEventLoop();
          lastYieldAt = performance.now();
        }
      }
    }
  };
  // Pipeline forwards read/decompression errors and destroys all streams on
  // rejection/abort, before the caller discards its new temporary upload.
  if (isGzip) await pipeline(source, createGunzip(), inspect, { signal });
  else await pipeline(source, inspect, { signal });
  return finishJsonInspection(inspector);
}

export async function inspectGzipJsonWithLimit(
  bytes: Buffer,
  maxUncompressedBytes = MAX_TOP_DASHBOARD_DATA_UNCOMPRESSED_BYTES,
  signal?: AbortSignal,
) {
  return inspectJsonReadable(Readable.from([bytes]), true, maxUncompressedBytes, signal);
}

function jsonInspectionErrorResponse(error: unknown, isGzip: boolean) {
  if (error instanceof SnapshotJsonResourceError) {
    const reasons: Record<SnapshotJsonResourceError['code'], string> = {
      JSON_STRING_TOO_LARGE: 'одно значение JSON превышает безопасный размер 8 МБ',
      JSON_KEY_TOO_LARGE: 'название одного поля JSON превышает безопасный размер 64 КБ',
      JSON_NUMBER_TOO_LARGE: 'числовое значение JSON содержит слишком много символов',
      JSON_TOO_DEEP: 'структура JSON содержит больше 128 уровней вложенности',
      JSON_TOO_COMPLEX: 'JSON содержит чрезмерное количество элементов',
      JSON_PROCESSING_LIMIT: 'проверка JSON превысила безопасное время обработки',
    };
    return Response.json({
      error: `Файл не загружен: ${reasons[error.code]}. Проверьте экспорт снимка. Предыдущий снимок не изменён.`,
      code: error.code,
    }, { status: 413 });
  }
  if (error instanceof Error && error.message === UNCOMPRESSED_TOO_LARGE) {
    return errorResponse(`Распакованный файл данных должен быть не больше ${TOP_DASHBOARD_DATA_MAX_UNCOMPRESSED_LABEL}`, 413);
  }
  if (error instanceof Error && error.message === INVALID_UTF8) {
    return errorResponse('Файл данных должен быть сохранён в кодировке UTF-8');
  }
  if (error instanceof TokenizerError || error instanceof TokenParserError || !isGzip) {
    return errorResponse('В файле данных содержится некорректный JSON');
  }
  return errorResponse('Файл .json.gz повреждён или не является корректным gzip-архивом');
}

function fieldIs(signature: SnapshotSignature, key: string, kind: SnapshotField['kind']) {
  return signature.fields.get(key)?.kind === kind;
}

function numberField(signature: SnapshotSignature, key: string) {
  const field = signature.fields.get(key);
  return field?.kind === 'number' ? field.value : null;
}

function stringField(signature: SnapshotSignature, key: string) {
  const field = signature.fields.get(key);
  return field?.kind === 'string' ? field.value : null;
}

function detectSnapshotFormat(
  signature: SnapshotSignature,
  expectedFormat?: TopDashboardSnapshotFormat,
): TopDashboardSnapshotFormat | null {
  if (!signature.rootObject) return null;
  const formats: TopDashboardSnapshotFormat[] = [];

  const ktsVersion = numberField(signature, 'version');
  const ktsRows = numberField(signature, 'n');
  if (
    stringField(signature, 'format') === 'kts-bundle'
    && ktsVersion === 1
    && Number.isInteger(ktsRows)
    && ktsRows !== null
    && ktsRows >= 0
    && ktsRows <= MAX_KTS_BUNDLE_ROWS
    && fieldIs(signature, 'dict', 'object')
    && fieldIs(signature, 'cols', 'object')
    && fieldIs(signature, 'extra', 'object')
  ) {
    formats.push('kts-bundle-v1');
  }

  const purchasesVersion = numberField(signature, 'v');
  const params = signature.fields.get('params');
  if (
    purchasesVersion === 1
    && fieldIs(signature, 'raw', 'object')
    && fieldIs(signature, 'meta', 'object')
    && (!params || params.kind === 'object')
  ) {
    formats.push('purchases-v1');
  }

  // Additional fields must not change the interpretation of an otherwise
  // valid base format. Prefer the format of the published HTML if both match.
  return expectedFormat && formats.includes(expectedFormat)
    ? expectedFormat
    : formats[0] ?? null;
}

function detectDashboardProfile(
  snapshotFormat: TopDashboardSnapshotFormat,
  signature: SnapshotSignature,
): TopDashboardDataProfile | null {
  if (snapshotFormat === 'purchases-v1') return 'purchases';

  // `actual` is also exported by current sales analytics (actual stock). It is
  // a legacy assortment fallback, not evidence of a conflicting profile.
  const hasSalesKeys = SALES_PROFILE_KEYS.some((key) => signature.extraKeys.has(key));
  const hasAssortmentKeys = ASSORTMENT_PROFILE_KEYS.some((key) => signature.extraKeys.has(key));
  if (hasSalesKeys && hasAssortmentKeys) return null;
  if (hasSalesKeys) return 'sales-analytics';
  if (hasAssortmentKeys || signature.extraKeys.has('actual')) return 'assortment-optimization';
  return null;
}

export async function readTopDashboardDataUpload(
  request: Request,
  expectedFormat?: TopDashboardSnapshotFormat,
): Promise<UploadResult> {
  if (contentLengthTooLarge(request)) {
    return {
      error: errorResponse(
        `Файл данных в этом режиме должен быть не больше ${TOP_DASHBOARD_DATA_MULTIPART_MAX_MEGABYTES} МБ`,
        413,
      ),
    };
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return { error: errorResponse('Не удалось прочитать файл данных') };
  }

  const expected = parseExpectedActiveVersionId(formData.get('expectedActiveVersionId'));
  if (typeof expected.error === 'string') return { error: errorResponse(expected.error) };

  const file = formData.get('file');
  if (!(file instanceof File)) return { error: errorResponse('Выберите файл данных') };
  if (file.size <= 0) return { error: errorResponse('Файл данных пустой') };
  if (file.size > TOP_DASHBOARD_DATA_MULTIPART_MAX_BYTES) {
    return {
      error: errorResponse(
        `Файл данных в этом режиме должен быть не больше ${TOP_DASHBOARD_DATA_MULTIPART_MAX_MEGABYTES} МБ`,
        413,
      ),
    };
  }
  if (!/\.json(?:\.gz)?$/i.test(file.name)) {
    return { error: errorResponse('Загрузите файл с расширением .json или .json.gz') };
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length <= 0) return { error: errorResponse('Файл данных пустой') };
  if (bytes.length > TOP_DASHBOARD_DATA_MULTIPART_MAX_BYTES) {
    return {
      error: errorResponse(
        `Файл данных в этом режиме должен быть не больше ${TOP_DASHBOARD_DATA_MULTIPART_MAX_MEGABYTES} МБ`,
        413,
      ),
    };
  }

  const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const hasGzipExtension = /\.json\.gz$/i.test(file.name);
  if (isGzip !== hasGzipExtension) {
    return {
      error: errorResponse(
        isGzip
          ? 'Сжатый файл должен иметь расширение .json.gz'
          : 'Файл .json.gz не является корректным gzip-архивом',
      ),
    };
  }

  let inspection: JsonInspection;
  try {
    inspection = isGzip
      ? await inspectGzipJsonWithLimit(bytes, MAX_TOP_DASHBOARD_DATA_UNCOMPRESSED_BYTES, request.signal)
      : await inspectJsonBuffer(bytes, request.signal);
  } catch (error) {
    return { error: jsonInspectionErrorResponse(error, isGzip) };
  }

  const snapshotFormat = detectSnapshotFormat(inspection.signature, expectedFormat);
  if (!snapshotFormat) {
    return { error: errorResponse('Файл не похож на поддерживаемый снимок данных КТС') };
  }
  const dashboardProfile = detectDashboardProfile(snapshotFormat, inspection.signature);

  return {
    parsed: {
      expectedActiveVersionId: expected.value ?? null,
      upload: {
        originalName: normalizeOriginalName(file.name),
        content: bytes,
        storagePath: null,
        fileSize: bytes.length,
        uncompressedSize: inspection.size,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        snapshotFormat,
        dataAsOf: inspection.dataAsOf,
        dashboardProfile,
      },
    },
  };
}

export async function readTopDashboardDataStreamUpload(
  request: Request,
  expectedFormat?: TopDashboardSnapshotFormat,
): Promise<UploadResult> {
  const originalName = readStreamOriginalName(request);
  if (!originalName || !/\.json(?:\.gz)?$/i.test(originalName)) {
    return { error: errorResponse('Загрузите файл с расширением .json или .json.gz') };
  }
  const expected = readStreamExpectedActiveVersionId(request);
  if (typeof expected.error === 'string') return { error: errorResponse(expected.error) };

  const received = await receiveTopDashboardDataStream(request, 'Файл данных');
  if (received.error) return { error: received.error };
  const pending = received.pending;
  const isGzip = pending.firstBytes.length >= 2
    && pending.firstBytes[0] === 0x1f
    && pending.firstBytes[1] === 0x8b;
  const hasGzipExtension = /\.json\.gz$/i.test(originalName);
  if (isGzip !== hasGzipExtension) {
    await pending.discard();
    return {
      error: errorResponse(
        isGzip
          ? 'Сжатый файл должен иметь расширение .json.gz'
          : 'Файл .json.gz не является корректным gzip-архивом',
      ),
    };
  }

  let inspection: JsonInspection;
  try {
    const source = createReadStream(pending.temporaryPath);
    inspection = await inspectJsonReadable(source, isGzip, MAX_TOP_DASHBOARD_DATA_UNCOMPRESSED_BYTES, request.signal);
  } catch (error) {
    await pending.discard();
    return { error: jsonInspectionErrorResponse(error, isGzip) };
  }

  const snapshotFormat = detectSnapshotFormat(inspection.signature, expectedFormat);
  if (!snapshotFormat) {
    await pending.discard();
    return { error: errorResponse('Файл не похож на поддерживаемый снимок данных КТС') };
  }
  const dashboardProfile = detectDashboardProfile(snapshotFormat, inspection.signature);

  return {
    parsed: {
      expectedActiveVersionId: expected.value,
      upload: {
        originalName: normalizeOriginalName(originalName),
        content: null,
        storagePath: null,
        pendingFile: pending,
        fileSize: pending.fileSize,
        uncompressedSize: inspection.size,
        sha256: pending.sha256,
        snapshotFormat,
        dataAsOf: inspection.dataAsOf,
        dashboardProfile,
      },
    },
  };
}
