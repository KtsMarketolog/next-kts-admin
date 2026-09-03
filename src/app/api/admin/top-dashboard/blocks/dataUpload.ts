import { createHash } from 'crypto';
import { createReadStream } from 'node:fs';
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
} from '@/shared/lib/topDashboardLimits';
import type { PendingTopDashboardDataFile } from '@/shared/lib/topDashboardDataStorage';

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
  dashboardProfile: TopDashboardDataProfile | null;
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
  extraKeys: Set<string>;
};

type JsonStreamInspector = {
  size: number;
  parser: JSONParser;
  decoder: TextDecoder;
  signature: SnapshotSignatureTracker;
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
  if (field) tracker.fields.set(tracker.key, field);
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
          tracker.extraKeys.add(value as string);
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
        if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) {
          tracker.depth += 1;
          tracker.extraState = 'nested';
        } else if (tokenSnapshotField(token, value)) {
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
      tracker.key = value as string;
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
  const parser = new JSONParser({
    paths: [],
    keepStack: false,
    stringBufferSize: 64 * 1024,
    numberBufferSize: 64,
  });
  parser.onToken = (token) => inspectSnapshotSignatureToken(signature, token);

  return {
    size: 0,
    parser,
    decoder: new TextDecoder('utf-8', { fatal: true }),
    signature,
  };
}

function writeJsonInspectionChunk(inspector: JsonStreamInspector, chunk: Buffer) {
  inspector.size += chunk.length;
  if (inspector.size > MAX_TOP_DASHBOARD_DATA_UNCOMPRESSED_BYTES) {
    throw new Error(UNCOMPRESSED_TOO_LARGE);
  }

  try {
    inspector.decoder.decode(chunk, { stream: true });
  } catch {
    throw new Error(INVALID_UTF8);
  }

  inspector.parser.write(chunk);
}

function finishJsonInspection(inspector: JsonStreamInspector): JsonInspection {
  try {
    inspector.decoder.decode();
  } catch {
    throw new Error(INVALID_UTF8);
  }
  if (!inspector.parser.isEnded) inspector.parser.end();
  return {
    size: inspector.size,
    signature: {
      rootObject: inspector.signature.rootObject,
      fields: inspector.signature.fields,
      extraKeys: inspector.signature.extraKeys,
    },
  };
}

function inspectJsonBuffer(bytes: Buffer) {
  const inspector = createJsonStreamInspector();
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
    writeJsonInspectionChunk(inspector, bytes.subarray(offset, offset + 64 * 1024));
  }
  return finishJsonInspection(inspector);
}

async function inspectJsonReadable(
  readable: NodeJS.ReadableStream,
  maxUncompressedBytes = MAX_TOP_DASHBOARD_DATA_UNCOMPRESSED_BYTES,
) {
  const inspector = createJsonStreamInspector();
  for await (const chunk of readable) {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === 'string'
        ? Buffer.from(chunk)
        : Buffer.from(chunk as Uint8Array);
    if (inspector.size + bytes.length > maxUncompressedBytes) {
      throw new Error(UNCOMPRESSED_TOO_LARGE);
    }
    writeJsonInspectionChunk(inspector, bytes);
  }
  return finishJsonInspection(inspector);
}

export async function inspectGzipJsonWithLimit(
  bytes: Buffer,
  maxUncompressedBytes = MAX_TOP_DASHBOARD_DATA_UNCOMPRESSED_BYTES,
) {
  return new Promise<JsonInspection>((resolve, reject) => {
    const gunzip = createGunzip();
    const inspector = createJsonStreamInspector();
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    gunzip.on('data', (chunk: Buffer) => {
      try {
        if (inspector.size + chunk.length > maxUncompressedBytes) {
          throw new Error(UNCOMPRESSED_TOO_LARGE);
        }
        writeJsonInspectionChunk(inspector, chunk);
      } catch (error) {
        gunzip.destroy(error instanceof Error ? error : new Error('Invalid JSON'));
      }
    });
    gunzip.once('error', fail);
    gunzip.once('end', () => {
      if (settled) return;
      try {
        const inspection = finishJsonInspection(inspector);
        settled = true;
        resolve(inspection);
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Invalid JSON'));
      }
    });
    gunzip.end(bytes);
  });
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

function detectSnapshotFormat(signature: SnapshotSignature): TopDashboardSnapshotFormat | null {
  if (!signature.rootObject) return null;

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
    return 'kts-bundle-v1';
  }

  const purchasesVersion = numberField(signature, 'v');
  const params = signature.fields.get('params');
  if (
    purchasesVersion === 1
    && fieldIs(signature, 'raw', 'object')
    && fieldIs(signature, 'meta', 'object')
    && (!params || params.kind === 'object')
  ) {
    return 'purchases-v1';
  }

  return null;
}

function detectDashboardProfile(
  snapshotFormat: TopDashboardSnapshotFormat,
  signature: SnapshotSignature,
): TopDashboardDataProfile | null {
  if (snapshotFormat === 'purchases-v1') return 'purchases';

  const salesKeys = ['plan', 'hr', 'timesheets', 'opex', 'alloc'];
  const assortmentKeys = ['actual', 'reserve', 'transit', 'otherWh'];
  const hasSalesKeys = salesKeys.some((key) => signature.extraKeys.has(key));
  const hasAssortmentKeys = assortmentKeys.some((key) => signature.extraKeys.has(key));
  if (hasSalesKeys === hasAssortmentKeys) return null;
  return hasSalesKeys ? 'sales-analytics' : 'assortment-optimization';
}

export async function readTopDashboardDataUpload(request: Request): Promise<UploadResult> {
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
  if (isGzip) {
    try {
      inspection = await inspectGzipJsonWithLimit(bytes);
    } catch (error) {
      if (error instanceof Error && error.message === UNCOMPRESSED_TOO_LARGE) {
        return {
          error: errorResponse(
            `Распакованный файл данных должен быть не больше ${TOP_DASHBOARD_DATA_MAX_UNCOMPRESSED_LABEL}`,
            413,
          ),
        };
      }
      if (error instanceof Error && error.message === INVALID_UTF8) {
        return { error: errorResponse('Файл данных должен быть сохранён в кодировке UTF-8') };
      }
      if (error instanceof TokenizerError || error instanceof TokenParserError) {
        return { error: errorResponse('В файле данных содержится некорректный JSON') };
      }
      return {
        error: errorResponse('Файл .json.gz повреждён или не является корректным gzip-архивом'),
      };
    }
  } else {
    try {
      inspection = inspectJsonBuffer(bytes);
    } catch (error) {
      if (error instanceof Error && error.message === INVALID_UTF8) {
        return { error: errorResponse('Файл данных должен быть сохранён в кодировке UTF-8') };
      }
      return { error: errorResponse('В файле данных содержится некорректный JSON') };
    }
  }

  const snapshotFormat = detectSnapshotFormat(inspection.signature);
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
        dashboardProfile,
      },
    },
  };
}

export async function readTopDashboardDataStreamUpload(request: Request): Promise<UploadResult> {
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
    inspection = await inspectJsonReadable(isGzip ? source.pipe(createGunzip()) : source);
  } catch (error) {
    await pending.discard();
    if (error instanceof Error && error.message === UNCOMPRESSED_TOO_LARGE) {
      return {
        error: errorResponse(
          `Распакованный файл данных должен быть не больше ${TOP_DASHBOARD_DATA_MAX_UNCOMPRESSED_LABEL}`,
          413,
        ),
      };
    }
    if (error instanceof Error && error.message === INVALID_UTF8) {
      return { error: errorResponse('Файл данных должен быть сохранён в кодировке UTF-8') };
    }
    if (!isGzip && (error instanceof TokenizerError || error instanceof TokenParserError)) {
      return { error: errorResponse('В файле данных содержится некорректный JSON') };
    }
    return {
      error: errorResponse(
        isGzip
          ? 'Файл .json.gz повреждён или не является корректным gzip-архивом'
          : 'В файле данных содержится некорректный JSON',
      ),
    };
  }

  const snapshotFormat = detectSnapshotFormat(inspection.signature);
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
        dashboardProfile,
      },
    },
  };
}
