import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeTopDashboardMultiFileSnapshot,
  encodeTopDashboardMultiFileSnapshot,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES_PER_TARGET,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_INPUT_INDEX,
  TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGETS,
  TopDashboardMultiFileSnapshotError,
  type TopDashboardMultiFileSnapshotErrorCode,
  type TopDashboardMultiFileSnapshotInput,
  validateTopDashboardMultiFileSnapshot,
} from '../src/shared/lib/topDashboardMultiFileSnapshot';

function byteValues(value: ArrayBuffer) {
  return Array.from(new Uint8Array(value));
}

function copyBuffer(value: ArrayBuffer) {
  return value.slice(0);
}

function expectSnapshotError(
  action: () => unknown,
  code: TopDashboardMultiFileSnapshotErrorCode,
) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof TopDashboardMultiFileSnapshotError);
    assert.equal(error.code, code);
    return true;
  });
}

function findBytes(haystack: Uint8Array, needle: Uint8Array) {
  outer: for (let offset = 0; offset <= haystack.length - needle.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (haystack[offset + index] !== needle[index]) continue outer;
    }
    return offset;
  }
  return -1;
}

function oneFileInput(overrides: Partial<TopDashboardMultiFileSnapshotInput> = {}) {
  return {
    targets: [{
      target: { id: 'upload', name: 'sources', index: 0 },
      files: [{ name: 'data.json.gz', bytes: Uint8Array.of(0x1f, 0x8b, 0x00, 0xff) }],
    }],
    ...overrides,
  } satisfies TopDashboardMultiFileSnapshotInput;
}

test('multi-file snapshot round-trips raw bytes, multiple targets and NFC metadata', () => {
  const firstPayload = Buffer.from([0x1f, 0x8b, 0x00, 0xff, 0x80]);
  const secondPayloadSource = Uint8Array.of(4, 3, 2, 1);
  const secondPayload = new DataView(secondPayloadSource.buffer);
  const finalPayload = Uint8Array.of(9, 8, 7, 6);
  const encoded = encodeTopDashboardMultiFileSnapshot({
    targets: [
      {
        target: { id: 'file-e\u0301', name: 'source-files', index: 0 },
        files: [
          {
            name: 'данные_e\u0301.json.gz',
            type: 'application/gzip',
            lastModified: 1_788_333_123_456,
            webkitRelativePath: 'снимки/данные_e\u0301.json.gz',
            bytes: firstPayload,
          },
          { name: 'meta.json', type: 'application/json', bytes: secondPayload },
        ],
      },
      {
        target: { name: 'folder-files', index: 2 },
        files: [{ name: 'other.json', bytes: finalPayload }],
      },
    ],
  });

  assert.ok(encoded instanceof ArrayBuffer);
  const validation = validateTopDashboardMultiFileSnapshot(encoded);
  assert.deepEqual(validation, {
    ok: true,
    byteLength: encoded.byteLength,
    targetCount: 2,
    fileCount: 3,
  });

  const paddedNodeBuffer = Buffer.alloc(encoded.byteLength + 6, 0xaa);
  Buffer.from(encoded).copy(paddedNodeBuffer, 3);
  const decoded = decodeTopDashboardMultiFileSnapshot(
    paddedNodeBuffer.subarray(3, paddedNodeBuffer.length - 3),
  );

  assert.equal(decoded.version, 2);
  assert.deepEqual(decoded.targets.map((entry) => entry.target), [
    { id: 'file-é', name: 'source-files', index: 0 },
    { id: null, name: 'folder-files', index: 2 },
  ]);
  assert.deepEqual(decoded.targets[0]?.files.map((file) => file.name), [
    'данные_é.json.gz',
    'meta.json',
  ]);
  assert.deepEqual(
    decoded.targets[0]?.files.map((file) => ({
      type: file.type,
      lastModified: file.lastModified,
      webkitRelativePath: file.webkitRelativePath,
    })),
    [
      {
        type: 'application/gzip',
        lastModified: 1_788_333_123_456,
        webkitRelativePath: 'снимки/данные_é.json.gz',
      },
      { type: 'application/json', lastModified: 0, webkitRelativePath: '' },
    ],
  );
  assert.deepEqual(byteValues(decoded.targets[0]!.files[0]!.bytes), [...firstPayload]);
  assert.deepEqual(byteValues(decoded.targets[0]!.files[1]!.bytes), [...secondPayloadSource]);
  assert.deepEqual(byteValues(decoded.targets[1]!.files[0]!.bytes), [...finalPayload]);

  assert.deepEqual(
    Array.from(new Uint8Array(encoded).slice(-finalPayload.byteLength)),
    [...finalPayload],
    'the final payload is stored verbatim rather than base64-encoded',
  );
});

test('encoder copies payloads without parsing or decompressing them', () => {
  const deliberatelyInvalidGzip = Uint8Array.of(0x1f, 0x8b, 0xff, 0x00, 0xaa, 0x55);
  const encoded = encodeTopDashboardMultiFileSnapshot({
    targets: [{
      target: { index: 0 },
      files: [{ name: 'broken.json.gz', bytes: deliberatelyInvalidGzip }],
    }],
  });
  deliberatelyInvalidGzip.fill(0);

  const decoded = decodeTopDashboardMultiFileSnapshot(encoded);
  assert.deepEqual(
    byteValues(decoded.targets[0]!.files[0]!.bytes),
    [0x1f, 0x8b, 0xff, 0x00, 0xaa, 0x55],
  );
});

test('file names are normalized to NFC and unsafe or duplicate names are rejected', () => {
  const normalized = decodeTopDashboardMultiFileSnapshot(
    encodeTopDashboardMultiFileSnapshot({
      targets: [{
        target: { index: 0 },
        files: [{ name: '  cafe\u0301.json  ', bytes: Uint8Array.of(1) }],
      }],
    }),
  );
  assert.equal(normalized.targets[0]!.files[0]!.name, 'café.json');

  for (const name of [
    '',
    '.',
    '..',
    '../secret.json',
    'folder/file.json',
    'folder\\file.json',
    'line\nbreak.json',
    'hidden\u200b.json',
    'bidi\u202ejson.txt',
    `${'a'.repeat(251)}.json`,
  ]) {
    expectSnapshotError(
      () => encodeTopDashboardMultiFileSnapshot({
        targets: [{
          target: { index: 0 },
          files: [{ name, bytes: Uint8Array.of(1) }],
        }],
      }),
      name.length > 255 ? 'LIMIT_EXCEEDED' : 'INVALID_FILE',
    );
  }

  expectSnapshotError(
    () => encodeTopDashboardMultiFileSnapshot({
      targets: [{
        target: { index: 0 },
        files: [
          { name: 'cafe\u0301.json', bytes: Uint8Array.of(1) },
          { name: 'café.json', bytes: Uint8Array.of(2) },
        ],
      }],
    }),
    'DUPLICATE_FILE',
  );

  assert.doesNotThrow(() => encodeTopDashboardMultiFileSnapshot({
    targets: [
      {
        target: { index: 0 },
        files: [{ name: 'same.json', bytes: Uint8Array.of(1) }],
      },
      {
        target: { index: 1 },
        files: [{ name: 'same.json', bytes: Uint8Array.of(2) }],
      },
    ],
  }));
});

test('target descriptors enforce safe text, canonical identity and bounded indexes', () => {
  for (const target of [
    { index: -1 },
    { index: 1.5 },
    { index: TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_INPUT_INDEX + 1 },
    { index: 0, id: '' },
    { index: 0, id: ' spaced ' },
    { index: 0, name: 'bad\nname' },
  ]) {
    expectSnapshotError(
      () => encodeTopDashboardMultiFileSnapshot({
        targets: [{
          target,
          files: [{ name: 'data.json', bytes: Uint8Array.of(1) }],
        }],
      }),
      'INVALID_TARGET',
    );
  }

  expectSnapshotError(
    () => encodeTopDashboardMultiFileSnapshot({
      targets: [{
        target: { index: 0, id: 'я'.repeat(257) },
        files: [{ name: 'data.json', bytes: Uint8Array.of(1) }],
      }],
    }),
    'LIMIT_EXCEEDED',
  );

  expectSnapshotError(
    () => encodeTopDashboardMultiFileSnapshot({
      targets: [
        {
          target: { index: 0, id: 'first' },
          files: [{ name: 'a.json', bytes: Uint8Array.of(1) }],
        },
        {
          target: { index: 0, id: 'second' },
          files: [{ name: 'b.json', bytes: Uint8Array.of(2) }],
        },
      ],
    }),
    'DUPLICATE_TARGET',
  );

  expectSnapshotError(
    () => encodeTopDashboardMultiFileSnapshot({
      targets: [
        {
          target: { index: 0, id: 'cafe\u0301' },
          files: [{ name: 'a.json', bytes: Uint8Array.of(1) }],
        },
        {
          target: { index: 1, id: 'café' },
          files: [{ name: 'b.json', bytes: Uint8Array.of(2) }],
        },
      ],
    }),
    'DUPLICATE_TARGET',
  );
});

test('snapshot cardinality and empty payloads are bounded before allocation', () => {
  expectSnapshotError(
    () => encodeTopDashboardMultiFileSnapshot({ targets: [] }),
    'LIMIT_EXCEEDED',
  );

  const tooManyTargets = Array.from(
    { length: TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGETS + 1 },
    (_, index) => ({
      target: { index },
      files: [{ name: `${index}.json`, bytes: Uint8Array.of(index) }],
    }),
  );
  expectSnapshotError(
    () => encodeTopDashboardMultiFileSnapshot({ targets: tooManyTargets }),
    'LIMIT_EXCEEDED',
  );

  const tooManyFilesForOneTarget = Array.from(
    { length: TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES_PER_TARGET + 1 },
    (_, index) => ({ name: `${index}.json`, bytes: Uint8Array.of(index) }),
  );
  expectSnapshotError(
    () => encodeTopDashboardMultiFileSnapshot({
      targets: [{ target: { index: 0 }, files: tooManyFilesForOneTarget }],
    }),
    'LIMIT_EXCEEDED',
  );

  const tooManyFilesTotal = Array.from({ length: 3 }, (_, targetIndex) => ({
    target: { index: targetIndex },
    files: Array.from(
      { length: Math.floor(TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES / 3) + 1 },
      (_, fileIndex) => ({
        name: `${targetIndex}-${fileIndex}.json`,
        bytes: Uint8Array.of(fileIndex),
      }),
    ),
  }));
  expectSnapshotError(
    () => encodeTopDashboardMultiFileSnapshot({ targets: tooManyFilesTotal }),
    'LIMIT_EXCEEDED',
  );

  expectSnapshotError(
    () => encodeTopDashboardMultiFileSnapshot({
      targets: [{
        target: { index: 0 },
        files: [{ name: 'empty.json', bytes: new ArrayBuffer(0) }],
      }],
    }),
    'INVALID_FILE',
  );
});

test('documented filename, target and cardinality boundaries are inclusive', () => {
  const maxTargets = Array.from(
    { length: TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGETS },
    (_, index) => ({
      target: {
        id: index === 0 ? 'я'.repeat(256) : `input-${index}`,
        index: index === 0 ? TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_INPUT_INDEX : index - 1,
      },
      files: [{
        name: index === 0 ? `${'a'.repeat(250)}.json` : `${index}.json`,
        bytes: Uint8Array.of(index),
      }],
    }),
  );

  const encoded = encodeTopDashboardMultiFileSnapshot({ targets: maxTargets });
  const validation = validateTopDashboardMultiFileSnapshot(encoded);
  assert.equal(validation.ok, true);
  if (validation.ok) {
    assert.equal(validation.targetCount, TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGETS);
    assert.equal(validation.fileCount, TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_TARGETS);
  }

  const maxFilesPerTarget = Array.from(
    { length: TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES_PER_TARGET },
    (_, index) => ({ name: `${index}.json`, bytes: Uint8Array.of(index) }),
  );
  assert.equal(
    validateTopDashboardMultiFileSnapshot(encodeTopDashboardMultiFileSnapshot({
      targets: [{ target: { index: 0 }, files: maxFilesPerTarget }],
    })).ok,
    true,
  );

  const maxFilesTotal = Array.from({ length: 2 }, (_, targetIndex) => ({
    target: { index: targetIndex },
    files: Array.from(
      { length: TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES_PER_TARGET },
      (_, fileIndex) => ({
        name: `${targetIndex}-${fileIndex}.json`,
        bytes: Uint8Array.of(targetIndex, fileIndex),
      }),
    ),
  }));
  const totalValidation = validateTopDashboardMultiFileSnapshot(
    encodeTopDashboardMultiFileSnapshot({ targets: maxFilesTotal }),
  );
  assert.equal(totalValidation.ok, true);
  if (totalValidation.ok) {
    assert.equal(totalValidation.fileCount, TOP_DASHBOARD_MULTI_FILE_SNAPSHOT_MAX_FILES);
  }
});

test('decoder rejects corrupted headers, lengths, reserved fields and malformed UTF-8', () => {
  const encoded = encodeTopDashboardMultiFileSnapshot(oneFileInput());

  const badMagic = copyBuffer(encoded);
  new Uint8Array(badMagic)[0] ^= 0xff;
  expectSnapshotError(() => decodeTopDashboardMultiFileSnapshot(badMagic), 'INVALID_MAGIC');

  const badVersion = copyBuffer(encoded);
  new DataView(badVersion).setUint16(8, 3, false);
  expectSnapshotError(() => decodeTopDashboardMultiFileSnapshot(badVersion), 'UNSUPPORTED_VERSION');

  const badFlags = copyBuffer(encoded);
  new DataView(badFlags).setUint16(10, 1, false);
  expectSnapshotError(() => decodeTopDashboardMultiFileSnapshot(badFlags), 'INVALID_HEADER');

  const badDeclaredLength = copyBuffer(encoded);
  new DataView(badDeclaredLength).setUint32(12, encoded.byteLength - 1, false);
  expectSnapshotError(
    () => decodeTopDashboardMultiFileSnapshot(badDeclaredLength),
    'INVALID_LENGTH',
  );

  expectSnapshotError(
    () => decodeTopDashboardMultiFileSnapshot(encoded.slice(0, encoded.byteLength - 1)),
    'INVALID_LENGTH',
  );

  const badTargetReserved = copyBuffer(encoded);
  new DataView(badTargetReserved).setUint16(24 + 10, 1, false);
  expectSnapshotError(
    () => decodeTopDashboardMultiFileSnapshot(badTargetReserved),
    'INVALID_HEADER',
  );

  const malformedId = copyBuffer(encoded);
  new Uint8Array(malformedId)[24 + 12] = 0xff;
  expectSnapshotError(() => decodeTopDashboardMultiFileSnapshot(malformedId), 'INVALID_UTF8');

  const mismatchedFileCount = copyBuffer(encoded);
  new DataView(mismatchedFileCount).setUint32(20, 2, false);
  expectSnapshotError(
    () => decodeTopDashboardMultiFileSnapshot(mismatchedFileCount),
    'INVALID_LENGTH',
  );
});

test('decoder independently rejects duplicate target indexes and normalized file names', () => {
  const twoTargets = encodeTopDashboardMultiFileSnapshot({
    targets: [
      {
        target: { index: 0 },
        files: [{ name: 'a.json', bytes: Uint8Array.of(1) }],
      },
      {
        target: { index: 1 },
        files: [{ name: 'b.json', bytes: Uint8Array.of(2) }],
      },
    ],
  });
  const duplicateIndex = copyBuffer(twoTargets);
  const secondTargetOffset = 24 + 12 + 20 + 'a.json'.length + 1;
  new DataView(duplicateIndex).setUint32(secondTargetOffset, 0, false);
  expectSnapshotError(
    () => decodeTopDashboardMultiFileSnapshot(duplicateIndex),
    'DUPLICATE_TARGET',
  );

  const twoFiles = encodeTopDashboardMultiFileSnapshot({
    targets: [{
      target: { index: 0 },
      files: [
        { name: 'a.json', bytes: Uint8Array.of(1) },
        { name: 'b.json', bytes: Uint8Array.of(2) },
      ],
    }],
  });
  const duplicateName = copyBuffer(twoFiles);
  const duplicateNameBytes = new Uint8Array(duplicateName);
  const secondNameOffset = findBytes(duplicateNameBytes, new TextEncoder().encode('b.json'));
  assert.notEqual(secondNameOffset, -1);
  duplicateNameBytes.set(new TextEncoder().encode('a.json'), secondNameOffset);
  expectSnapshotError(
    () => decodeTopDashboardMultiFileSnapshot(duplicateName),
    'DUPLICATE_FILE',
  );
});

test('non-throwing validator reports a stable error code for invalid input', () => {
  assert.deepEqual(validateTopDashboardMultiFileSnapshot({}), {
    ok: false,
    code: 'INVALID_INPUT',
    error: 'Бинарный контейнер должен быть ArrayBuffer или его представлением',
  });

  const encoded = encodeTopDashboardMultiFileSnapshot(oneFileInput());
  const broken = copyBuffer(encoded);
  new Uint8Array(broken)[0] = 0;
  const result = validateTopDashboardMultiFileSnapshot(broken);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'INVALID_MAGIC');
});
