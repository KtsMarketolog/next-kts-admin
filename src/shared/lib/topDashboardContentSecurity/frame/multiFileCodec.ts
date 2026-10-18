import { TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_INPUT_INDEX } from '../../topDashboardMultiFileSnapshot';

/**
 * Validates and encodes/decodes the multi-file wire format in the trusted frame.
 * Uses the injected size/format constants and validBuffer helper; never evaluates uploaded code.
 * Emitted into the enclosing runtime's lexical scope; preserve statement order.
 */
export function multiFileCodecScript() {
  return String.raw`  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder('utf-8', { fatal: true });
  const unsafeFileName = /[\/\\\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
  const unsafeTargetText = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
  const unsafeRelativePath = /[\\\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
  const mimeTypePattern = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/u;

  function safeFileName(value) {
    if (typeof value !== 'string') return '';
    let name;
    try { name = value.normalize('NFC').trim(); } catch { return ''; }
    if (!name || name === '.' || name === '..' || unsafeFileName.test(name)) return '';
    return textEncoder.encode(name).byteLength <= 255 ? name : '';
  }

  function safeTargetText(value) {
    if (value == null || value === '') return null;
    if (typeof value !== 'string') return undefined;
    let normalized;
    try { normalized = value.normalize('NFC'); } catch { return undefined; }
    if (
      !normalized
      || normalized !== normalized.trim()
      || unsafeTargetText.test(normalized)
      || textEncoder.encode(normalized).byteLength > 512
    ) return undefined;
    return normalized;
  }

  function safeMimeType(value) {
    if (value == null || value === '') return '';
    if (
      typeof value !== 'string'
      || value !== value.trim()
      || !mimeTypePattern.test(value)
      || textEncoder.encode(value).byteLength > MULTI_FILE_MAX_MIME_BYTES
    ) return undefined;
    return value;
  }

  function safeRelativePath(value, fileName) {
    if (value == null || value === '') return '';
    if (typeof value !== 'string') return undefined;
    let normalized;
    try { normalized = value.normalize('NFC'); } catch { return undefined; }
    const segments = normalized.split('/');
    if (
      normalized !== normalized.trim()
      || normalized.startsWith('/')
      || normalized.endsWith('/')
      || unsafeRelativePath.test(normalized)
      || segments.some((segment) => !segment || segment === '.' || segment === '..')
      || segments[segments.length - 1] !== fileName
      || textEncoder.encode(normalized).byteLength > MULTI_FILE_MAX_PATH_BYTES
    ) return undefined;
    return normalized;
  }

  function normalizedMultiFileTarget(value) {
    if (!value || typeof value !== 'object') return null;
    const index = value.index;
    const id = safeTargetText(value.id);
    const name = safeTargetText(value.name);
    if (
      !Number.isInteger(index)
      || index < 0
      || index > ${TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_INPUT_INDEX}
      || id === undefined
      || name === undefined
    ) return null;
    return { id, name, index };
  }

  function multiFileTargetKey(target) {
    if (target.id) return 'id:' + target.id;
    if (target.name) return 'name:' + target.name;
    return 'index:' + target.index;
  }

  function normalizeSelectedFiles(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > MULTI_FILE_MAX_FILES_PER_TARGET) {
      return null;
    }
    const identities = new Set();
    const files = [];
    let total = 0;
    for (const candidate of value) {
      const blob = candidate instanceof Blob ? candidate : candidate && candidate.blob;
      const name = safeFileName(candidate && candidate.name);
      const type = safeMimeType(candidate && candidate.type);
      const relativePath = safeRelativePath(candidate && candidate.webkitRelativePath, name);
      const lastModified = candidate && Number.isSafeInteger(candidate.lastModified)
        && candidate.lastModified >= 0
        ? candidate.lastModified
        : 0;
      const identity = relativePath || name;
      if (
        !name
        || type === undefined
        || relativePath === undefined
        || identities.has(identity)
        || !(blob instanceof Blob)
        || blob.size <= 0
      ) return null;
      identities.add(identity);
      total += blob.size;
      if (total > MAX_BYTES) return null;
      files.push({ name, type, lastModified, webkitRelativePath: relativePath, blob });
    }
    return files;
  }

  function encodeMultiFileSnapshot(sourceTargets) {
    const targets = Array.from((sourceTargets || multiFileTargets).values())
      .sort((a, b) => a.target.index - b.target.index);
    if (targets.length === 0 || targets.length > MULTI_FILE_MAX_TARGETS) throw new Error('invalid targets');
    const prepared = [];
    let totalLength = 24;
    let totalPayloadLength = 0;
    let totalFiles = 0;
    for (const entry of targets) {
      const target = normalizedMultiFileTarget(entry.target);
      const files = normalizeSelectedFiles(entry.files);
      if (!target || !files) throw new Error('invalid target');
      const idBytes = target.id ? textEncoder.encode(target.id) : new Uint8Array(0);
      const targetNameBytes = target.name ? textEncoder.encode(target.name) : new Uint8Array(0);
      totalFiles += files.length;
      if (totalFiles > MULTI_FILE_MAX_FILES) throw new Error('too many files');
      totalLength += 12 + idBytes.byteLength + targetNameBytes.byteLength;
      const preparedFiles = [];
      for (const file of files) {
        totalPayloadLength += file.blob.size;
        if (totalPayloadLength > MAX_BYTES) throw new Error('too large');
        const fileNameBytes = textEncoder.encode(file.name);
        const mimeTypeBytes = textEncoder.encode(file.type);
        const relativePathBytes = textEncoder.encode(file.webkitRelativePath);
        totalLength += 20
          + fileNameBytes.byteLength
          + mimeTypeBytes.byteLength
          + relativePathBytes.byteLength
          + file.blob.size;
        if (totalLength > MULTI_FILE_MAX_BYTES) throw new Error('too large');
        preparedFiles.push({ ...file, fileNameBytes, mimeTypeBytes, relativePathBytes });
      }
      prepared.push({ target, idBytes, targetNameBytes, files: preparedFiles });
    }

    const header = new Uint8Array(24);
    header.set(textEncoder.encode(MULTI_FILE_MAGIC), 0);
    const headerView = new DataView(header.buffer);
    headerView.setUint16(8, MULTI_FILE_VERSION, false);
    headerView.setUint32(12, totalLength, false);
    headerView.setUint16(16, prepared.length, false);
    headerView.setUint32(20, totalFiles, false);
    const parts = [header];
    for (const entry of prepared) {
      const targetHeader = new Uint8Array(12);
      const targetView = new DataView(targetHeader.buffer);
      targetView.setUint32(0, entry.target.index, false);
      targetView.setUint16(4, entry.idBytes.byteLength, false);
      targetView.setUint16(6, entry.targetNameBytes.byteLength, false);
      targetView.setUint16(8, entry.files.length, false);
      parts.push(targetHeader, entry.idBytes, entry.targetNameBytes);
      for (const file of entry.files) {
        const fileHeader = new Uint8Array(20);
        const fileView = new DataView(fileHeader.buffer);
        fileView.setUint16(0, file.fileNameBytes.byteLength, false);
        fileView.setUint16(2, file.mimeTypeBytes.byteLength, false);
        fileView.setUint16(4, file.relativePathBytes.byteLength, false);
        fileView.setUint32(8, file.blob.size, false);
        fileView.setUint32(12, Math.floor(file.lastModified / 0x100000000), false);
        fileView.setUint32(16, file.lastModified % 0x100000000, false);
        parts.push(
          fileHeader,
          file.fileNameBytes,
          file.mimeTypeBytes,
          file.relativePathBytes,
          file.blob,
        );
      }
    }
    const blob = new Blob(parts, { type: 'application/octet-stream' });
    if (blob.size !== totalLength) throw new Error('invalid length');
    return blob;
  }

  function decodeMultiFileSnapshot(buffer) {
    if (!validBuffer(buffer, MULTI_FILE_MAX_BYTES) || buffer.byteLength < 24) {
      throw new Error('invalid buffer');
    }
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    if (textDecoder.decode(bytes.subarray(0, 8)) !== MULTI_FILE_MAGIC) throw new Error('invalid magic');
    if (
      view.getUint16(8, false) !== MULTI_FILE_VERSION
      || view.getUint16(10, false) !== 0
      || view.getUint32(12, false) !== buffer.byteLength
      || view.getUint16(18, false) !== 0
    ) throw new Error('invalid header');
    const targetCount = view.getUint16(16, false);
    const declaredFileCount = view.getUint32(20, false);
    if (
      targetCount <= 0
      || targetCount > MULTI_FILE_MAX_TARGETS
      || declaredFileCount <= 0
      || declaredFileCount > MULTI_FILE_MAX_FILES
    ) throw new Error('invalid count');

    let offset = 24;
    let fileCount = 0;
    let payloadLength = 0;
    const targets = [];
    const indexes = new Set();
    const ids = new Set();
    const readText = (length) => {
      if (length < 0 || offset + length > bytes.byteLength) throw new Error('truncated');
      const value = textDecoder.decode(bytes.subarray(offset, offset + length));
      offset += length;
      return value;
    };
    for (let targetNumber = 0; targetNumber < targetCount; targetNumber += 1) {
      if (offset + 12 > bytes.byteLength) throw new Error('truncated');
      const index = view.getUint32(offset, false);
      const idLength = view.getUint16(offset + 4, false);
      const nameLength = view.getUint16(offset + 6, false);
      const perTargetFiles = view.getUint16(offset + 8, false);
      const reserved = view.getUint16(offset + 10, false);
      offset += 12;
      if (
        reserved !== 0
        || index > ${TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_INPUT_INDEX}
        || indexes.has(index)
        || idLength > 512
        || nameLength > 512
        || perTargetFiles <= 0
        || perTargetFiles > MULTI_FILE_MAX_FILES_PER_TARGET
      ) throw new Error('invalid target');
      indexes.add(index);
      const id = idLength ? safeTargetText(readText(idLength)) : null;
      const name = nameLength ? safeTargetText(readText(nameLength)) : null;
      if (id === undefined || name === undefined || (id && ids.has(id))) throw new Error('invalid target');
      if (id) ids.add(id);
      const files = [];
      const fileIdentities = new Set();
      for (let fileNumber = 0; fileNumber < perTargetFiles; fileNumber += 1) {
        if (offset + 20 > bytes.byteLength) throw new Error('truncated');
        const fileNameLength = view.getUint16(offset, false);
        const mimeTypeLength = view.getUint16(offset + 2, false);
        const relativePathLength = view.getUint16(offset + 4, false);
        const fileReserved = view.getUint16(offset + 6, false);
        const contentLength = view.getUint32(offset + 8, false);
        const lastModified = view.getUint32(offset + 12, false) * 0x100000000
          + view.getUint32(offset + 16, false);
        offset += 20;
        payloadLength += contentLength;
        if (
          fileReserved !== 0
          || fileNameLength <= 0
          || fileNameLength > 255
          || mimeTypeLength > MULTI_FILE_MAX_MIME_BYTES
          || relativePathLength > MULTI_FILE_MAX_PATH_BYTES
          || contentLength <= 0
          || payloadLength > MAX_BYTES
          || !Number.isSafeInteger(lastModified)
        ) {
          throw new Error('invalid file');
        }
        const fileName = safeFileName(readText(fileNameLength));
        const type = safeMimeType(mimeTypeLength ? readText(mimeTypeLength) : '');
        const relativePath = safeRelativePath(
          relativePathLength ? readText(relativePathLength) : '',
          fileName,
        );
        const identity = relativePath || fileName;
        if (
          !fileName
          || type === undefined
          || relativePath === undefined
          || fileIdentities.has(identity)
          || offset + contentLength > bytes.byteLength
        ) {
          throw new Error('invalid file');
        }
        fileIdentities.add(identity);
        const blob = new Blob([bytes.subarray(offset, offset + contentLength)], { type });
        offset += contentLength;
        files.push({
          name: fileName,
          type,
          lastModified,
          webkitRelativePath: relativePath,
          blob,
        });
        fileCount += 1;
      }
      targets.push({ target: { id, name, index }, files });
    }
    if (fileCount !== declaredFileCount || offset !== bytes.byteLength) throw new Error('invalid length');
    return targets;
  }

`;
}
