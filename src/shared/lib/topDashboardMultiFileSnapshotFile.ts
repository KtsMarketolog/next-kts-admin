import { open } from 'node:fs/promises';

import {
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_BYTES,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES_PER_TARGET,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILE_NAME_BYTES,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_INPUT_INDEX,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_MIME_TYPE_BYTES,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_PAYLOAD_BYTES,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_RELATIVE_PATH_BYTES,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGETS,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGET_TEXT_BYTES,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_VERSION,
  TopDashboardMultiFileSnapshotError,
  type TopDashboardMultiFileSnapshotInspectionResult,
  type TopDashboardMultiFileSnapshotTargetSummary,
  type TopDashboardMultiFileSnapshotValidationResult,
} from './topDashboardMultiFileSnapshot';

const MAGIC = Buffer.from('KTSMFILE', 'ascii');
const HEADER_BYTES = 24;
const TARGET_HEADER_BYTES = 12;
const FILE_HEADER_BYTES = 20;
const UINT32_BASE = 0x1_0000_0000;
const UNSAFE_FILE_NAME_PATTERN = /[\/\\\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const UNSAFE_TARGET_TEXT_PATTERN = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const UNSAFE_RELATIVE_PATH_PATTERN = /[\\\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const MIME_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u;
const decoder = new TextDecoder('utf-8', { fatal: true });

function snapshotError(
  code: ConstructorParameters<typeof TopDashboardMultiFileSnapshotError>[0],
  message: string,
) {
  return new TopDashboardMultiFileSnapshotError(code, message);
}

function assertAvailable(offset: number, length: number, total: number) {
  if (!Number.isInteger(length) || length < 0 || offset < 0 || length > total - offset) {
    throw snapshotError('INVALID_LENGTH', 'Бинарный контейнер обрезан');
  }
}

function validateCanonicalText(
  value: string,
  encodedLength: number,
  label: string,
  code: ConstructorParameters<typeof TopDashboardMultiFileSnapshotError>[0],
) {
  let normalized: string;
  try {
    normalized = value.normalize('NFC');
  } catch {
    throw snapshotError('INVALID_UTF8', `${label} содержит некорректный Unicode`);
  }
  if (normalized !== value || Buffer.byteLength(value, 'utf8') !== encodedLength) {
    throw snapshotError(code, `${label} не приведён к NFC`);
  }
}

function validateTargetText(value: string, encodedLength: number, label: string) {
  validateCanonicalText(value, encodedLength, label, 'INVALID_TARGET');
  if (!value || value !== value.trim() || UNSAFE_TARGET_TEXT_PATTERN.test(value)) {
    throw snapshotError('INVALID_TARGET', `${label} небезопасен`);
  }
}

function validateFileName(value: string, encodedLength: number) {
  validateCanonicalText(value, encodedLength, 'Имя файла', 'INVALID_FILE');
  if (
    !value
    || value === '.'
    || value === '..'
    || value !== value.trim()
    || UNSAFE_FILE_NAME_PATTERN.test(value)
  ) {
    throw snapshotError('INVALID_FILE', 'Имя файла небезопасно');
  }
}

function validateMimeType(value: string, encodedLength: number) {
  validateCanonicalText(value, encodedLength, 'MIME-тип файла', 'INVALID_FILE');
  if (value !== value.trim() || !MIME_TYPE_PATTERN.test(value)) {
    throw snapshotError('INVALID_FILE', 'MIME-тип файла некорректен');
  }
}

function validateRelativePath(value: string, encodedLength: number, fileName: string) {
  validateCanonicalText(value, encodedLength, 'Относительный путь файла', 'INVALID_FILE');
  const segments = value.split('/');
  if (
    value !== value.trim()
    || value.startsWith('/')
    || value.endsWith('/')
    || UNSAFE_RELATIVE_PATH_PATTERN.test(value)
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
    || segments.at(-1) !== fileName
  ) {
    throw snapshotError('INVALID_FILE', 'Относительный путь файла небезопасен');
  }
}

export async function inspectTopDashboardMultiFileSnapshotFile(
  filePath: string,
  fileSize: number,
): Promise<TopDashboardMultiFileSnapshotInspectionResult> {
  const file = await open(filePath, 'r');
  try {
    const readAt = async (offset: number, length: number) => {
      assertAvailable(offset, length, fileSize);
      const output = Buffer.allocUnsafe(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await file.read(output, filled, length - filled, offset + filled);
        if (bytesRead <= 0) throw snapshotError('INVALID_LENGTH', 'Бинарный контейнер обрезан');
        filled += bytesRead;
      }
      return output;
    };
    const readText = async (offset: number, length: number, label: string) => {
      try {
        return decoder.decode(await readAt(offset, length));
      } catch (error) {
        if (error instanceof TopDashboardMultiFileSnapshotError) throw error;
        throw snapshotError('INVALID_UTF8', `${label} содержит некорректный UTF-8`);
      }
    };

    if (fileSize < HEADER_BYTES) {
      throw snapshotError('INVALID_LENGTH', 'Бинарный контейнер слишком короткий');
    }
    if (fileSize > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_BYTES) {
      throw snapshotError('LIMIT_EXCEEDED', 'Бинарный контейнер слишком большой');
    }

    const header = await readAt(0, HEADER_BYTES);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw snapshotError('INVALID_MAGIC', 'Сигнатура бинарного контейнера не распознана');
    }
    if (header.readUInt16BE(8) !== TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_VERSION) {
      throw snapshotError('UNSUPPORTED_VERSION', 'Версия бинарного контейнера не поддерживается');
    }
    if (header.readUInt16BE(10) !== 0 || header.readUInt16BE(18) !== 0) {
      throw snapshotError('INVALID_HEADER', 'Зарезервированные поля контейнера должны быть пустыми');
    }
    if (header.readUInt32BE(12) !== fileSize) {
      throw snapshotError('INVALID_LENGTH', 'Заявленная длина контейнера не совпадает с фактической');
    }

    const targetCount = header.readUInt16BE(16);
    const declaredFileCount = header.readUInt32BE(20);
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
    const targets: TopDashboardMultiFileSnapshotTargetSummary[] = [];
    let offset = HEADER_BYTES;
    let actualFileCount = 0;
    let actualPayloadLength = 0;

    for (let targetNumber = 0; targetNumber < targetCount; targetNumber += 1) {
      const targetHeader = await readAt(offset, TARGET_HEADER_BYTES);
      offset += TARGET_HEADER_BYTES;
      const index = targetHeader.readUInt32BE(0);
      const idLength = targetHeader.readUInt16BE(4);
      const targetNameLength = targetHeader.readUInt16BE(6);
      const fileCount = targetHeader.readUInt16BE(8);
      if (targetHeader.readUInt16BE(10) !== 0) {
        throw snapshotError('INVALID_HEADER', 'Зарезервированное поле цели должно быть пустым');
      }
      if (index > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_INPUT_INDEX) {
        throw snapshotError('INVALID_TARGET', 'Индекс целевого поля некорректен');
      }
      if (targetIndexes.has(index)) {
        throw snapshotError('DUPLICATE_TARGET', 'Индекс целевого поля повторяется');
      }
      targetIndexes.add(index);
      if (
        idLength > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGET_TEXT_BYTES
        || targetNameLength > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGET_TEXT_BYTES
        || fileCount === 0
        || fileCount > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES_PER_TARGET
      ) {
        throw snapshotError('LIMIT_EXCEEDED', 'Описание целевого поля превышает лимит');
      }

      let id: string | null = null;
      if (idLength > 0) {
        id = await readText(offset, idLength, 'ID целевого поля');
        validateTargetText(id, idLength, 'ID целевого поля');
        offset += idLength;
        if (targetIds.has(id)) throw snapshotError('DUPLICATE_TARGET', 'ID целевого поля повторяется');
        targetIds.add(id);
      }
      let name: string | null = null;
      if (targetNameLength > 0) {
        name = await readText(offset, targetNameLength, 'Name целевого поля');
        validateTargetText(name, targetNameLength, 'Name целевого поля');
        offset += targetNameLength;
      }

      actualFileCount += fileCount;
      if (actualFileCount > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES) {
        throw snapshotError('LIMIT_EXCEEDED', 'В контейнере слишком много файлов');
      }
      const fileIdentities = new Set<string>();

      for (let fileNumber = 0; fileNumber < fileCount; fileNumber += 1) {
        const fileHeader = await readAt(offset, FILE_HEADER_BYTES);
        offset += FILE_HEADER_BYTES;
        const fileNameLength = fileHeader.readUInt16BE(0);
        const mimeTypeLength = fileHeader.readUInt16BE(2);
        const relativePathLength = fileHeader.readUInt16BE(4);
        const contentLength = fileHeader.readUInt32BE(8);
        if (fileHeader.readUInt16BE(6) !== 0) {
          throw snapshotError('INVALID_HEADER', 'Зарезервированное поле файла должно быть пустым');
        }
        if (
          fileNameLength === 0
          || fileNameLength > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILE_NAME_BYTES
          || mimeTypeLength > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_MIME_TYPE_BYTES
          || relativePathLength > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_RELATIVE_PATH_BYTES
          || contentLength === 0
          || contentLength > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_PAYLOAD_BYTES
        ) {
          throw snapshotError('LIMIT_EXCEEDED', 'Размер файла или его метаданных недопустим');
        }
        actualPayloadLength += contentLength;
        if (actualPayloadLength > TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_PAYLOAD_BYTES) {
          throw snapshotError('LIMIT_EXCEEDED', 'Общий размер файлов слишком большой');
        }

        const fileName = await readText(offset, fileNameLength, 'Имя файла');
        validateFileName(fileName, fileNameLength);
        offset += fileNameLength;
        if (mimeTypeLength > 0) {
          const mimeType = await readText(offset, mimeTypeLength, 'MIME-тип файла');
          validateMimeType(mimeType, mimeTypeLength);
        }
        offset += mimeTypeLength;
        let relativePath = '';
        if (relativePathLength > 0) {
          relativePath = await readText(offset, relativePathLength, 'Относительный путь файла');
          validateRelativePath(relativePath, relativePathLength, fileName);
        }
        offset += relativePathLength;

        const lastModified = fileHeader.readUInt32BE(12) * UINT32_BASE
          + fileHeader.readUInt32BE(16);
        if (!Number.isSafeInteger(lastModified)) {
          throw snapshotError('INVALID_FILE', 'Дата изменения файла выходит за допустимый диапазон');
        }
        const identity = relativePath || fileName;
        if (fileIdentities.has(identity)) {
          throw snapshotError('DUPLICATE_FILE', 'Файл повторяется в одном целевом поле');
        }
        fileIdentities.add(identity);
        assertAvailable(offset, contentLength, fileSize);
        offset += contentLength;
      }
      targets.push({ target: { id, name, index }, fileCount });
    }

    if (actualFileCount !== declaredFileCount || offset !== fileSize) {
      throw snapshotError('INVALID_LENGTH', 'Структура бинарного контейнера не совпадает с заголовком');
    }
    return {
      ok: true,
      byteLength: fileSize,
      targetCount,
      fileCount: actualFileCount,
      targets,
    };
  } catch (error) {
    if (error instanceof TopDashboardMultiFileSnapshotError) {
      return { ok: false, code: error.code, error: error.message };
    }
    throw error;
  } finally {
    await file.close();
  }
}

export async function validateTopDashboardMultiFileSnapshotFile(
  filePath: string,
  fileSize: number,
): Promise<TopDashboardMultiFileSnapshotValidationResult> {
  const inspected = await inspectTopDashboardMultiFileSnapshotFile(filePath, fileSize);
  if (!inspected.ok) return inspected;
  return {
    ok: true,
    byteLength: inspected.byteLength,
    targetCount: inspected.targetCount,
    fileCount: inspected.fileCount,
  };
}
