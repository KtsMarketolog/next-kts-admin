const MAGIC_TEXT = 'KTSMFILE';
const MAGIC_BYTES = Uint8Array.of(0x4b, 0x54, 0x53, 0x4d, 0x46, 0x49, 0x4c, 0x45);
const HEADER_BYTES = 24;
const TARGET_HEADER_BYTES = 12;
const FILE_HEADER_BYTES = 20;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffff_ffff;

const UNSAFE_FILE_NAME_PATTERN = /[\/\\\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const UNSAFE_TARGET_TEXT_PATTERN = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const MIME_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u;
const UNSAFE_RELATIVE_PATH_PATTERN = /[\\\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;

export const TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAGIC = MAGIC_TEXT;
export const TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_VERSION = 2;
export const TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_BYTES = 100 * 1024 * 1024;
export const TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGETS = 32;
export const TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES = 128;
export const TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES_PER_TARGET = 64;
export const TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILE_NAME_BYTES = 255;
export const TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_MIME_TYPE_BYTES = 255;
export const TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_RELATIVE_PATH_BYTES = 1024;
export const TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGET_TEXT_BYTES = 512;
export const TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_INPUT_INDEX = UINT16_MAX;

export type TopDashboardMultiFileSnapshotErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_MAGIC'
  | 'UNSUPPORTED_VERSION'
  | 'INVALID_HEADER'
  | 'INVALID_LENGTH'
  | 'LIMIT_EXCEEDED'
  | 'INVALID_TARGET'
  | 'DUPLICATE_TARGET'
  | 'INVALID_FILE'
  | 'DUPLICATE_FILE'
  | 'INVALID_UTF8';

export class TopDashboardMultiFileSnapshotError extends Error {
  readonly code: TopDashboardMultiFileSnapshotErrorCode;

  constructor(code: TopDashboardMultiFileSnapshotErrorCode, message: string) {
    super(message);
    this.name = 'TopDashboardMultiFileSnapshotError';
    this.code = code;
  }
}

export type TopDashboardMultiFileSnapshotBinary = ArrayBuffer | ArrayBufferView;

export type TopDashboardMultiFileSnapshotTarget = {
  /** Optional HTML id of the target file input. */
  id?: string | null;
  /** Optional HTML name of the target file input. */
  name?: string | null;
  /** Zero-based position among the dashboard's file inputs. */
  index: number;
};

export type TopDashboardMultiFileSnapshotFileInput = {
  name: string;
  type?: string | null;
  lastModified?: number | null;
  webkitRelativePath?: string | null;
  bytes: TopDashboardMultiFileSnapshotBinary;
};

export type TopDashboardMultiFileSnapshotTargetInput = {
  target: TopDashboardMultiFileSnapshotTarget;
  files: readonly TopDashboardMultiFileSnapshotFileInput[];
};

export type TopDashboardMultiFileSnapshotInput = {
  targets: readonly TopDashboardMultiFileSnapshotTargetInput[];
};

export type DecodedTopDashboardMultiFileSnapshotFile = {
  name: string;
  type: string;
  lastModified: number;
  webkitRelativePath: string;
  bytes: ArrayBuffer;
};

export type DecodedTopDashboardMultiFileSnapshotTarget = {
  target: {
    id: string | null;
    name: string | null;
    index: number;
  };
  files: DecodedTopDashboardMultiFileSnapshotFile[];
};

export type DecodedTopDashboardMultiFileSnapshot = {
  version: typeof TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_VERSION;
  targets: DecodedTopDashboardMultiFileSnapshotTarget[];
};

export type TopDashboardMultiFileSnapshotValidationResult =
  | {
      ok: true;
      byteLength: number;
      targetCount: number;
      fileCount: number;
    }
  | {
      ok: false;
      code: TopDashboardMultiFileSnapshotErrorCode;
      error: string;
    };

type NormalizedFile = {
  name: string;
  encodedName: Uint8Array;
  type: string;
  encodedType: Uint8Array;
  webkitRelativePath: string;
  encodedRelativePath: Uint8Array;
  lastModified: number;
  bytes: Uint8Array;
};

type NormalizedTarget = {
  target: {
    id: string | null;
    name: string | null;
    index: number;
  };
  encodedId: Uint8Array;
  encodedTargetName: Uint8Array;
  files: NormalizedFile[];
};

type ParsedSnapshot = {
  byteLength: number;
  fileCount: number;
  targets: DecodedTopDashboardMultiFileSnapshotTarget[];
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function snapshotError(
  code: TopDashboardMultiFileSnapshotErrorCode,
  message: string,
): TopDashboardMultiFileSnapshotError {
  return new TopDashboardMultiFileSnapshotError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasUnpairedSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function normalizedNfc(value: string, label: string) {
  if (hasUnpairedSurrogate(value)) {
    throw snapshotError('INVALID_UTF8', `${label} содержит некорректный Unicode`);
  }
  try {
    return value.normalize('NFC');
  } catch {
    throw snapshotError('INVALID_UTF8', `${label} содержит некорректный Unicode`);
  }
}

function normalizeFileName(value: unknown) {
  if (typeof value !== 'string') {
    throw snapshotError('INVALID_FILE', 'Имя файла должно быть строкой');
  }
  const name = normalizedNfc(value, 'Имя файла').trim();
  if (
    name.length === 0
    || name === '.'
    || name === '..'
    || UNSAFE_FILE_NAME_PATTERN.test(name)
  ) {
    throw snapshotError('INVALID_FILE', 'Имя файла небезопасно');
  }
  const encoded = textEncoder.encode(name);
  if (encoded.byteLength > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILE_NAME_BYTES) {
    throw snapshotError('LIMIT_EXCEEDED', 'Имя файла слишком длинное');
  }
  return { value: name, encoded };
}

function normalizeMimeType(value: unknown) {
  if (value === undefined || value === null || value === '') {
    return { value: '', encoded: new Uint8Array(0) };
  }
  if (typeof value !== 'string' || value !== value.trim() || !MIME_TYPE_PATTERN.test(value)) {
    throw snapshotError('INVALID_FILE', 'MIME-тип файла некорректен');
  }
  const encoded = textEncoder.encode(value);
  if (encoded.byteLength > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_MIME_TYPE_BYTES) {
    throw snapshotError('LIMIT_EXCEEDED', 'MIME-тип файла слишком длинный');
  }
  return { value, encoded };
}

function normalizeRelativePath(value: unknown, fileName: string) {
  if (value === undefined || value === null || value === '') {
    return { value: '', encoded: new Uint8Array(0) };
  }
  if (typeof value !== 'string') {
    throw snapshotError('INVALID_FILE', 'Относительный путь файла должен быть строкой');
  }
  const normalized = normalizedNfc(value, 'Относительный путь файла');
  const segments = normalized.split('/');
  if (
    normalized !== normalized.trim()
    || normalized.startsWith('/')
    || normalized.endsWith('/')
    || UNSAFE_RELATIVE_PATH_PATTERN.test(normalized)
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    || segments.at(-1) !== fileName
  ) {
    throw snapshotError('INVALID_FILE', 'Относительный путь файла небезопасен');
  }
  const encoded = textEncoder.encode(normalized);
  if (encoded.byteLength > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_RELATIVE_PATH_BYTES) {
    throw snapshotError('LIMIT_EXCEEDED', 'Относительный путь файла слишком длинный');
  }
  return { value: normalized, encoded };
}

function normalizeLastModified(value: unknown) {
  if (value === undefined || value === null) return 0;
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw snapshotError('INVALID_FILE', 'Дата изменения файла некорректна');
  }
  return value;
}

function normalizeTargetText(value: unknown, label: string) {
  if (value === undefined || value === null) {
    return { value: null, encoded: new Uint8Array(0) };
  }
  if (typeof value !== 'string') {
    throw snapshotError('INVALID_TARGET', `${label} должен быть строкой`);
  }
  const normalized = normalizedNfc(value, label);
  if (
    normalized.length === 0
    || normalized !== normalized.trim()
    || UNSAFE_TARGET_TEXT_PATTERN.test(normalized)
  ) {
    throw snapshotError('INVALID_TARGET', `${label} небезопасен`);
  }
  const encoded = textEncoder.encode(normalized);
  if (encoded.byteLength > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGET_TEXT_BYTES) {
    throw snapshotError('LIMIT_EXCEEDED', `${label} слишком длинный`);
  }
  return { value: normalized, encoded };
}

function binaryView(value: unknown, label: string) {
  try {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
  } catch {
    throw snapshotError('INVALID_INPUT', `${label} недоступен`);
  }
  throw snapshotError('INVALID_INPUT', `${label} должен быть ArrayBuffer или его представлением`);
}

function checkedLength(current: number, increment: number) {
  const next = current + increment;
  if (
    !Number.isSafeInteger(next)
    || next > UINT32_MAX
    || next > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_BYTES
  ) {
    throw snapshotError('LIMIT_EXCEEDED', 'Бинарный контейнер слишком большой');
  }
  return next;
}

function normalizeSnapshotInput(input: TopDashboardMultiFileSnapshotInput) {
  if (!isRecord(input) || !Array.isArray(input.targets)) {
    throw snapshotError('INVALID_INPUT', 'Контейнер должен содержать массив целей');
  }
  if (
    input.targets.length === 0
    || input.targets.length > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGETS
  ) {
    throw snapshotError('LIMIT_EXCEEDED', 'Недопустимое количество целевых полей');
  }

  const targetIndexes = new Set<number>();
  const targetIds = new Set<string>();
  const normalizedTargets: NormalizedTarget[] = [];
  let totalFileCount = 0;
  let totalLength = HEADER_BYTES;

  for (const entry of input.targets) {
    if (!isRecord(entry) || !isRecord(entry.target) || !Array.isArray(entry.files)) {
      throw snapshotError('INVALID_INPUT', 'Описание целевого поля некорректно');
    }
    const index = entry.target.index;
    if (
      typeof index !== 'number'
      || !Number.isInteger(index)
      || index < 0
      || index > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_INPUT_INDEX
    ) {
      throw snapshotError('INVALID_TARGET', 'Индекс целевого поля некорректен');
    }
    if (targetIndexes.has(index)) {
      throw snapshotError('DUPLICATE_TARGET', 'Индекс целевого поля повторяется');
    }
    targetIndexes.add(index);

    const id = normalizeTargetText(entry.target.id, 'ID целевого поля');
    const name = normalizeTargetText(entry.target.name, 'Name целевого поля');
    if (id.value !== null) {
      if (targetIds.has(id.value)) {
        throw snapshotError('DUPLICATE_TARGET', 'ID целевого поля повторяется');
      }
      targetIds.add(id.value);
    }
    if (
      entry.files.length === 0
      || entry.files.length > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES_PER_TARGET
    ) {
      throw snapshotError('LIMIT_EXCEEDED', 'Недопустимое количество файлов для одного поля');
    }

    totalFileCount += entry.files.length;
    if (totalFileCount > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES) {
      throw snapshotError('LIMIT_EXCEEDED', 'В контейнере слишком много файлов');
    }

    totalLength = checkedLength(
      totalLength,
      TARGET_HEADER_BYTES + id.encoded.byteLength + name.encoded.byteLength,
    );
    const fileIdentities = new Set<string>();
    const files: NormalizedFile[] = [];
    for (const file of entry.files) {
      if (!isRecord(file)) {
        throw snapshotError('INVALID_FILE', 'Описание файла некорректно');
      }
      const normalizedName = normalizeFileName(file.name);
      const normalizedType = normalizeMimeType(file.type);
      const normalizedRelativePath = normalizeRelativePath(
        file.webkitRelativePath,
        normalizedName.value,
      );
      const lastModified = normalizeLastModified(file.lastModified);
      const fileIdentity = normalizedRelativePath.value || normalizedName.value;
      if (fileIdentities.has(fileIdentity)) {
        throw snapshotError('DUPLICATE_FILE', 'Файл повторяется в одном целевом поле');
      }
      fileIdentities.add(fileIdentity);

      const bytes = binaryView(file.bytes, `Содержимое файла «${normalizedName.value}»`);
      if (bytes.byteLength === 0) {
        throw snapshotError('INVALID_FILE', 'Пустые файлы не поддерживаются');
      }
      if (bytes.byteLength > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_BYTES) {
        throw snapshotError('LIMIT_EXCEEDED', 'Один из файлов слишком большой');
      }
      totalLength = checkedLength(
        totalLength,
        FILE_HEADER_BYTES
          + normalizedName.encoded.byteLength
          + normalizedType.encoded.byteLength
          + normalizedRelativePath.encoded.byteLength
          + bytes.byteLength,
      );
      files.push({
        name: normalizedName.value,
        encodedName: normalizedName.encoded,
        type: normalizedType.value,
        encodedType: normalizedType.encoded,
        webkitRelativePath: normalizedRelativePath.value,
        encodedRelativePath: normalizedRelativePath.encoded,
        lastModified,
        bytes,
      });
    }

    normalizedTargets.push({
      target: { id: id.value, name: name.value, index },
      encodedId: id.encoded,
      encodedTargetName: name.encoded,
      files,
    });
  }

  return { targets: normalizedTargets, totalFileCount, totalLength };
}

function writeBytes(target: Uint8Array, offset: number, value: Uint8Array) {
  target.set(value, offset);
  return offset + value.byteLength;
}

/**
 * Encodes file inputs into a compact binary envelope. File payloads are copied
 * byte-for-byte; this function never parses, decompresses or base64-encodes them.
 *
 * Binary layout (all integers are unsigned, big-endian):
 * - 24-byte container header: magic, version, flags, total length, target count,
 *   reserved field and total file count.
 * - Per target: input index, UTF-8 id/name lengths, file count, then id/name bytes.
 * - Per file: UTF-8 name/MIME/relative-path lengths, raw byte length,
 *   last-modified timestamp, then metadata and raw payload bytes.
 */
export function encodeTopDashboardMultiFileSnapshot(
  input: TopDashboardMultiFileSnapshotInput,
): ArrayBuffer {
  const normalized = normalizeSnapshotInput(input);
  const buffer = new ArrayBuffer(normalized.totalLength);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let offset = 0;

  offset = writeBytes(bytes, offset, MAGIC_BYTES);
  view.setUint16(offset, TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_VERSION, false);
  offset += 2;
  view.setUint16(offset, 0, false);
  offset += 2;
  view.setUint32(offset, normalized.totalLength, false);
  offset += 4;
  view.setUint16(offset, normalized.targets.length, false);
  offset += 2;
  view.setUint16(offset, 0, false);
  offset += 2;
  view.setUint32(offset, normalized.totalFileCount, false);
  offset += 4;

  for (const entry of normalized.targets) {
    view.setUint32(offset, entry.target.index, false);
    offset += 4;
    view.setUint16(offset, entry.encodedId.byteLength, false);
    offset += 2;
    view.setUint16(offset, entry.encodedTargetName.byteLength, false);
    offset += 2;
    view.setUint16(offset, entry.files.length, false);
    offset += 2;
    view.setUint16(offset, 0, false);
    offset += 2;
    offset = writeBytes(bytes, offset, entry.encodedId);
    offset = writeBytes(bytes, offset, entry.encodedTargetName);

    for (const file of entry.files) {
      view.setUint16(offset, file.encodedName.byteLength, false);
      offset += 2;
      view.setUint16(offset, file.encodedType.byteLength, false);
      offset += 2;
      view.setUint16(offset, file.encodedRelativePath.byteLength, false);
      offset += 2;
      view.setUint16(offset, 0, false);
      offset += 2;
      view.setUint32(offset, file.bytes.byteLength, false);
      offset += 4;
      view.setUint32(offset, Math.floor(file.lastModified / (UINT32_MAX + 1)), false);
      offset += 4;
      view.setUint32(offset, file.lastModified % (UINT32_MAX + 1), false);
      offset += 4;
      offset = writeBytes(bytes, offset, file.encodedName);
      offset = writeBytes(bytes, offset, file.encodedType);
      offset = writeBytes(bytes, offset, file.encodedRelativePath);
      offset = writeBytes(bytes, offset, file.bytes);
    }
  }

  if (offset !== normalized.totalLength) {
    throw snapshotError('INVALID_LENGTH', 'Не удалось собрать бинарный контейнер');
  }
  return buffer;
}

function assertAvailable(offset: number, length: number, total: number) {
  if (
    !Number.isInteger(length)
    || length < 0
    || offset < 0
    || offset > total
    || length > total - offset
  ) {
    throw snapshotError('INVALID_LENGTH', 'Бинарный контейнер обрезан');
  }
}

function decodeText(
  bytes: Uint8Array,
  offset: number,
  length: number,
  label: string,
) {
  assertAvailable(offset, length, bytes.byteLength);
  try {
    return textDecoder.decode(bytes.subarray(offset, offset + length));
  } catch {
    throw snapshotError('INVALID_UTF8', `${label} содержит некорректный UTF-8`);
  }
}

function validateDecodedFileName(value: string, encodedLength: number) {
  const normalized = normalizeFileName(value);
  if (normalized.value !== value || normalized.encoded.byteLength !== encodedLength) {
    throw snapshotError('INVALID_FILE', 'Имя файла не приведено к NFC');
  }
  return value;
}

function validateDecodedMimeType(value: string, encodedLength: number) {
  const normalized = normalizeMimeType(value);
  if (normalized.value !== value || normalized.encoded.byteLength !== encodedLength) {
    throw snapshotError('INVALID_FILE', 'MIME-тип файла некорректен');
  }
  return value;
}

function validateDecodedRelativePath(
  value: string,
  encodedLength: number,
  fileName: string,
) {
  const normalized = normalizeRelativePath(value, fileName);
  if (normalized.value !== value || normalized.encoded.byteLength !== encodedLength) {
    throw snapshotError('INVALID_FILE', 'Относительный путь файла некорректен');
  }
  return value;
}

function validateDecodedTargetText(value: string, encodedLength: number, label: string) {
  const normalized = normalizeTargetText(value, label);
  if (
    normalized.value === null
    || normalized.value !== value
    || normalized.encoded.byteLength !== encodedLength
  ) {
    throw snapshotError('INVALID_TARGET', `${label} не приведён к NFC`);
  }
  return value;
}

function parseTopDashboardMultiFileSnapshot(
  source: unknown,
  copyPayloads: boolean,
): ParsedSnapshot {
  const bytes = binaryView(source, 'Бинарный контейнер');
  const total = bytes.byteLength;
  if (total < HEADER_BYTES) {
    throw snapshotError('INVALID_LENGTH', 'Бинарный контейнер слишком короткий');
  }
  if (total > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_BYTES) {
    throw snapshotError('LIMIT_EXCEEDED', 'Бинарный контейнер слишком большой');
  }

  for (let index = 0; index < MAGIC_BYTES.byteLength; index += 1) {
    if (bytes[index] !== MAGIC_BYTES[index]) {
      throw snapshotError('INVALID_MAGIC', 'Сигнатура бинарного контейнера не распознана');
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(8, false);
  if (version !== TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_VERSION) {
    throw snapshotError('UNSUPPORTED_VERSION', 'Версия бинарного контейнера не поддерживается');
  }
  if (view.getUint16(10, false) !== 0 || view.getUint16(18, false) !== 0) {
    throw snapshotError('INVALID_HEADER', 'Зарезервированные поля контейнера должны быть пустыми');
  }
  if (view.getUint32(12, false) !== total) {
    throw snapshotError('INVALID_LENGTH', 'Заявленная длина контейнера не совпадает с фактической');
  }

  const targetCount = view.getUint16(16, false);
  const declaredFileCount = view.getUint32(20, false);
  if (
    targetCount === 0
    || targetCount > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGETS
    || declaredFileCount === 0
    || declaredFileCount > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES
  ) {
    throw snapshotError('LIMIT_EXCEEDED', 'Количество целей или файлов недопустимо');
  }

  const targetIndexes = new Set<number>();
  const targetIds = new Set<string>();
  const targets: DecodedTopDashboardMultiFileSnapshotTarget[] = [];
  let offset = HEADER_BYTES;
  let actualFileCount = 0;

  for (let targetNumber = 0; targetNumber < targetCount; targetNumber += 1) {
    assertAvailable(offset, TARGET_HEADER_BYTES, total);
    const index = view.getUint32(offset, false);
    const idLength = view.getUint16(offset + 4, false);
    const targetNameLength = view.getUint16(offset + 6, false);
    const fileCount = view.getUint16(offset + 8, false);
    const reserved = view.getUint16(offset + 10, false);
    offset += TARGET_HEADER_BYTES;

    if (reserved !== 0) {
      throw snapshotError('INVALID_HEADER', 'Зарезервированное поле цели должно быть пустым');
    }
    if (index > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_INPUT_INDEX) {
      throw snapshotError('INVALID_TARGET', 'Индекс целевого поля превышает лимит');
    }
    if (targetIndexes.has(index)) {
      throw snapshotError('DUPLICATE_TARGET', 'Индекс целевого поля повторяется');
    }
    targetIndexes.add(index);
    if (
      idLength > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGET_TEXT_BYTES
      || targetNameLength > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGET_TEXT_BYTES
    ) {
      throw snapshotError('LIMIT_EXCEEDED', 'Описание целевого поля слишком длинное');
    }
    if (fileCount === 0 || fileCount > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES_PER_TARGET) {
      throw snapshotError('LIMIT_EXCEEDED', 'Количество файлов для целевого поля недопустимо');
    }

    let id: string | null = null;
    if (idLength > 0) {
      id = validateDecodedTargetText(
        decodeText(bytes, offset, idLength, 'ID целевого поля'),
        idLength,
        'ID целевого поля',
      );
      offset += idLength;
      if (targetIds.has(id)) {
        throw snapshotError('DUPLICATE_TARGET', 'ID целевого поля повторяется');
      }
      targetIds.add(id);
    }

    let name: string | null = null;
    if (targetNameLength > 0) {
      name = validateDecodedTargetText(
        decodeText(bytes, offset, targetNameLength, 'Name целевого поля'),
        targetNameLength,
        'Name целевого поля',
      );
      offset += targetNameLength;
    }

    actualFileCount += fileCount;
    if (actualFileCount > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES) {
      throw snapshotError('LIMIT_EXCEEDED', 'В контейнере слишком много файлов');
    }

    const fileIdentities = new Set<string>();
    const files: DecodedTopDashboardMultiFileSnapshotFile[] = [];
    for (let fileNumber = 0; fileNumber < fileCount; fileNumber += 1) {
      assertAvailable(offset, FILE_HEADER_BYTES, total);
      const fileNameLength = view.getUint16(offset, false);
      const mimeTypeLength = view.getUint16(offset + 2, false);
      const relativePathLength = view.getUint16(offset + 4, false);
      const fileReserved = view.getUint16(offset + 6, false);
      const contentLength = view.getUint32(offset + 8, false);
      const lastModifiedHigh = view.getUint32(offset + 12, false);
      const lastModifiedLow = view.getUint32(offset + 16, false);
      offset += FILE_HEADER_BYTES;

      if (fileReserved !== 0) {
        throw snapshotError('INVALID_HEADER', 'Зарезервированное поле файла должно быть пустым');
      }
      if (
        fileNameLength === 0
        || fileNameLength > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILE_NAME_BYTES
        || mimeTypeLength > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_MIME_TYPE_BYTES
        || relativePathLength > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_RELATIVE_PATH_BYTES
      ) {
        throw snapshotError('LIMIT_EXCEEDED', 'Длина метаданных файла недопустима');
      }
      if (contentLength === 0 || contentLength > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_BYTES) {
        throw snapshotError('LIMIT_EXCEEDED', 'Размер файла недопустим');
      }

      const fileName = validateDecodedFileName(
        decodeText(bytes, offset, fileNameLength, 'Имя файла'),
        fileNameLength,
      );
      offset += fileNameLength;

      const mimeType = mimeTypeLength > 0
        ? validateDecodedMimeType(
            decodeText(bytes, offset, mimeTypeLength, 'MIME-тип файла'),
            mimeTypeLength,
          )
        : '';
      offset += mimeTypeLength;

      const webkitRelativePath = relativePathLength > 0
        ? validateDecodedRelativePath(
            decodeText(bytes, offset, relativePathLength, 'Относительный путь файла'),
            relativePathLength,
            fileName,
          )
        : '';
      offset += relativePathLength;

      const lastModified = lastModifiedHigh * (UINT32_MAX + 1) + lastModifiedLow;
      if (!Number.isSafeInteger(lastModified)) {
        throw snapshotError('INVALID_FILE', 'Дата изменения файла выходит за допустимый диапазон');
      }

      const fileIdentity = webkitRelativePath || fileName;
      if (fileIdentities.has(fileIdentity)) {
        throw snapshotError('DUPLICATE_FILE', 'Файл повторяется в одном целевом поле');
      }
      fileIdentities.add(fileIdentity);

      assertAvailable(offset, contentLength, total);
      let content = new ArrayBuffer(0);
      if (copyPayloads) {
        const copy = new Uint8Array(contentLength);
        copy.set(bytes.subarray(offset, offset + contentLength));
        content = copy.buffer;
      }
      offset += contentLength;
      files.push({
        name: fileName,
        type: mimeType,
        lastModified,
        webkitRelativePath,
        bytes: content,
      });
    }

    targets.push({ target: { id, name, index }, files });
  }

  if (actualFileCount !== declaredFileCount || offset !== total) {
    throw snapshotError('INVALID_LENGTH', 'Структура бинарного контейнера не совпадает с заголовком');
  }

  return { byteLength: total, fileCount: actualFileCount, targets };
}

export function decodeTopDashboardMultiFileSnapshot(
  source: TopDashboardMultiFileSnapshotBinary,
): DecodedTopDashboardMultiFileSnapshot {
  const parsed = parseTopDashboardMultiFileSnapshot(source, true);
  return {
    version: TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_VERSION,
    targets: parsed.targets,
  };
}

export function validateTopDashboardMultiFileSnapshot(
  source: unknown,
): TopDashboardMultiFileSnapshotValidationResult {
  try {
    const parsed = parseTopDashboardMultiFileSnapshot(source, false);
    return {
      ok: true,
      byteLength: parsed.byteLength,
      targetCount: parsed.targets.length,
      fileCount: parsed.fileCount,
    };
  } catch (error) {
    const normalizedError = error instanceof TopDashboardMultiFileSnapshotError
      ? error
      : snapshotError('INVALID_INPUT', 'Не удалось проверить бинарный контейнер');
    return {
      ok: false,
      code: normalizedError.code,
      error: normalizedError.message,
    };
  }
}
