import assert from 'node:assert/strict';
import test from 'node:test';
import { JSONParser } from '@streamparser/json';

import {
  createSnapshotJsonResourceGuard,
  SNAPSHOT_JSON_PROCESSING_CHUNK_BYTES,
  SnapshotJsonResourceError,
  type SnapshotJsonResourceErrorCode,
  type SnapshotJsonResourceLimits,
} from '../src/shared/lib/snapshotJsonResourceGuard';

const limits: SnapshotJsonResourceLimits = {
  maxStringBytes: 8 * 1024 * 1024,
  maxKeyBytes: 64 * 1024,
  maxNumberBytes: 1024,
  maxDepth: 128,
  maxTokens: 200_000_000,
  maxProcessingMs: 120_000,
};

function expectResourceError(action: () => unknown, code: SnapshotJsonResourceErrorCode) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof SnapshotJsonResourceError);
    assert.equal(error.code, code);
    assert.ok(error.observed > error.limit);
    return true;
  });
}

function inspect(
  input: Uint8Array,
  chunkSize: number,
  overrides: Partial<SnapshotJsonResourceLimits> = {},
) {
  const guard = createSnapshotJsonResourceGuard({ ...limits, ...overrides });
  const parser = new JSONParser({ paths: [], keepStack: false, stringBufferSize: 1024 });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let offset = 0; offset < input.length; offset += chunkSize) {
    guard.write(input.subarray(offset, offset + chunkSize), (slice) => {
      decoder.decode(slice, { stream: true });
      parser.write(slice);
    });
  }
  return guard.finish(() => {
    decoder.decode();
    if (!parser.isEnded) parser.end();
  });
}

test('accepts arbitrary future fields, reserves and nested business data without a whitelist', () => {
  const input = Buffer.from(JSON.stringify({
    format: 'kts-bundle-v1',
    extra: {
      Резервы: [{ name: 'новый товар', amount: 17.34, availability: true }],
      futureSection: { records: [], optional: null },
    },
  }));
  const stats = inspect(input, 7);
  assert.equal(stats.bytes, input.length);
  assert.equal(stats.maxDepth, 4);
  assert.equal(stats.containers, 6);
  assert.ok(stats.tokens > 30);
});

test('byte metrics and key/value classification are invariant across UTF-8, escapes and chunk splits', () => {
  const input = Buffer.from('{"ключ":[{"x":"[\\\"{}] \\u005b 😁 \\\\"}],"longer":"123456789"}');
  const reference = inspect(input, input.length);
  for (let chunkSize = 1; chunkSize <= input.length + 1; chunkSize += 1) {
    const actual = inspect(input, chunkSize);
    assert.deepEqual({ ...actual, processingMs: 0 }, { ...reference, processingMs: 0 });
  }
  assert.equal(reference.maxDepth, 3);
  assert.equal(reference.maxKeyBytes, Buffer.byteLength('ключ'));
  assert.equal(reference.maxStringBytes, Buffer.byteLength('[\\\"{}] \\u005b 😁 \\\\'));
});

test('counts JSON tokens and scalar lengths, not braces/commas inside strings', () => {
  const stats = inspect(Buffer.from('{"a":[-1.2e+3,true,false,null,"[]{}:,"]}'), 1);
  assert.equal(stats.tokens, 15);
  assert.equal(stats.containers, 2);
  assert.equal(stats.maxDepth, 2);
  assert.equal(stats.maxNumberBytes, 7);
  assert.equal(stats.maxScalarBytes, 7);
});

test('accepts a UTF-8 BOM split across chunks without adding a scalar token', () => {
  const input = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"x":1}')]);
  const stats = inspect(input, 1);
  assert.equal(stats.bytes, input.length);
  assert.equal(stats.tokens, 5);
  assert.equal(stats.maxNumberBytes, 1);
});

test('checks value limit before delivering the violating slice to the real parser', () => {
  const guard = createSnapshotJsonResourceGuard({ ...limits, maxStringBytes: 5 });
  const delivered: string[] = [];
  guard.write(Buffer.from('{"x":"123'), (slice) => delivered.push(Buffer.from(slice).toString()));
  expectResourceError(
    () => guard.write(Buffer.from('456789"}'), (slice) => delivered.push(Buffer.from(slice).toString())),
    'JSON_STRING_TOO_LARGE',
  );
  assert.deepEqual(delivered, ['{"x":"123']);
  assert.equal(guard.stats().maxStringBytes, 6);
  expectResourceError(() => guard.write(Buffer.from('"}'), () => undefined), 'JSON_STRING_TOO_LARGE');
});

test('string budget measures encoded bytes, so escaped and multibyte values cannot evade it', () => {
  for (const text of ['{"x":"\\u0041\\u0041"}', '{"x":"яяя"}']) {
    expectResourceError(() => inspect(Buffer.from(text), 1, { maxStringBytes: 5 }), 'JSON_STRING_TOO_LARGE');
  }
  assert.doesNotThrow(() => inspect(Buffer.from('{"x":"12345"}'), 1, { maxStringBytes: 5 }));
});

test('keys have their own bound while longer values remain allowed', () => {
  assert.doesNotThrow(() => inspect(Buffer.from('{"a":"long value","b":{"xx":"long value"}}'), 1, {
    maxKeyBytes: 2,
  }));
  expectResourceError(() => inspect(Buffer.from('{"abc":1}'), 1, { maxKeyBytes: 2 }), 'JSON_KEY_TOO_LARGE');
  expectResourceError(() => inspect(Buffer.from('{"x":{},"abc":1}'), 1, { maxKeyBytes: 2 }), 'JSON_KEY_TOO_LARGE');
});

test('bounds long numbers before downstream number buffering, including chunk boundaries', () => {
  assert.doesNotThrow(() => inspect(Buffer.from('[1.2e+3]'), 2, { maxNumberBytes: 6 }));
  expectResourceError(() => inspect(Buffer.from('[1234567]'), 1, { maxNumberBytes: 6 }), 'JSON_NUMBER_TOO_LARGE');
  expectResourceError(() => inspect(Buffer.from('[-1.2e+33]'), 2, { maxNumberBytes: 6 }), 'JSON_NUMBER_TOO_LARGE');
});

test('bounds structural depth without recursion and includes empty containers', () => {
  assert.doesNotThrow(() => inspect(Buffer.from('[[[[]]]]'), 1, { maxDepth: 4 }));
  expectResourceError(() => inspect(Buffer.from('[[[[[]]]]]'), 1, { maxDepth: 4 }), 'JSON_TOO_DEEP');
  const guard = createSnapshotJsonResourceGuard({ ...limits, maxDepth: 4 });
  expectResourceError(() => guard.write(Buffer.from('['.repeat(500_000)), () => {
    assert.fail('A rejected deep slice must not reach the parser');
  }), 'JSON_TOO_DEEP');
  assert.equal(guard.stats().bytes, 5);
});

test('bounds flat structural/token complexity including many empty containers', () => {
  assert.doesNotThrow(() => inspect(Buffer.from('[{},{},{}]'), 2, { maxTokens: 10 }));
  expectResourceError(() => inspect(Buffer.from('[{},{},{},{}]'), 2, { maxTokens: 10 }), 'JSON_TOO_COMPLEX');
  expectResourceError(() => inspect(Buffer.from('[1,2,3,4]'), 1, { maxTokens: 8 }), 'JSON_TOO_COMPLEX');
});

test('oversized upstream chunks are split before parser delivery', () => {
  const guard = createSnapshotJsonResourceGuard(limits);
  const input = Buffer.from(`"${'x'.repeat(SNAPSHOT_JSON_PROCESSING_CHUNK_BYTES * 3)}"`);
  const delivered: number[] = [];
  guard.write(input, (slice) => delivered.push(slice.length));
  guard.finish();
  assert.deepEqual(delivered, [SNAPSHOT_JSON_PROCESSING_CHUNK_BYTES, SNAPSHOT_JSON_PROCESSING_CHUNK_BYTES,
    SNAPSHOT_JSON_PROCESSING_CHUNK_BYTES, 2]);
  assert.equal(guard.stats().maxScalarBytes, input.length - 2);
});

test('active processing budget includes parser callbacks but excludes time between chunks', () => {
  let clock = 0;
  const guard = createSnapshotJsonResourceGuard({ ...limits, maxProcessingMs: 10 }, { now: () => clock });
  guard.write(Buffer.from('['), () => { clock += 4; });
  clock += 60_000;
  guard.write(Buffer.from('1'), () => { clock += 4; });
  assert.equal(guard.stats().processingMs, 8);
  expectResourceError(() => guard.write(Buffer.from(']'), () => { clock += 3; }), 'JSON_PROCESSING_LIMIT');
  assert.equal(guard.stats().processingMs, 11);
});

test('scanner checks the processing clock within a chunk before parser delivery', () => {
  let clock = 0;
  const guard = createSnapshotJsonResourceGuard({ ...limits, maxProcessingMs: 5 }, {
    now: () => { clock += 1; return clock; },
  });
  expectResourceError(() => guard.write(Buffer.alloc(SNAPSHOT_JSON_PROCESSING_CHUNK_BYTES, 0x20), () => {
    assert.fail('Timed-out scan must not reach the parser');
  }), 'JSON_PROCESSING_LIMIT');
  assert.ok(guard.stats().bytes < SNAPSHOT_JSON_PROCESSING_CHUNK_BYTES);
});

test('parser completion is also charged to the processing budget', () => {
  let clock = 0;
  const guard = createSnapshotJsonResourceGuard({ ...limits, maxProcessingMs: 10 }, { now: () => clock });
  guard.write(Buffer.from('{}'), () => { clock += 4; });
  expectResourceError(() => guard.finish(() => { clock += 7; }), 'JSON_PROCESSING_LIMIT');
});

test('does not replace actual grammar/UTF-8 validation or turn malformed JSON into success', () => {
  for (const input of ['{"a":]', '"unterminated', '[01]', 'tru', '{"x":"\\q"}', '[}']) {
    assert.throws(() => inspect(Buffer.from(input), 1), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof SnapshotJsonResourceError));
      return true;
    });
  }
  assert.throws(() => inspect(Buffer.from([0x22, 0xc0, 0xaf, 0x22]), 1), TypeError);
});

test('metrics are snapshots, errors contain no file contents and completed guards cannot be reused', () => {
  const guard = createSnapshotJsonResourceGuard(limits);
  guard.write(Buffer.from('{"private":"value"}'), () => undefined);
  const stats = guard.finish();
  stats.bytes = 0;
  assert.ok(guard.stats().bytes > 0);
  assert.throws(() => guard.write(Buffer.from('{}'), () => undefined), /already finished/);
  const error = new SnapshotJsonResourceError('JSON_STRING_TOO_LARGE', 1, 2);
  assert.equal(error.message, 'JSON_STRING_TOO_LARGE');
});

test('rejects invalid safety configuration instead of silently disabling limits', () => {
  for (const maxDepth of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createSnapshotJsonResourceGuard({ ...limits, maxDepth }), RangeError);
  }
  assert.throws(() => createSnapshotJsonResourceGuard({} as SnapshotJsonResourceLimits), RangeError);
});

test('configuration is copied so later caller mutation cannot disable a guard', () => {
  const mutableLimits = { ...limits, maxDepth: 2 };
  const guard = createSnapshotJsonResourceGuard(mutableLimits);
  mutableLimits.maxDepth = 100;
  expectResourceError(() => guard.write(Buffer.from('[[[]]]'), () => undefined), 'JSON_TOO_DEEP');
});

test('token statistics match the real parser for a varied corpus at every byte boundary', () => {
  const values = [
    null, false, true, 0, -234, 1e-100, 9.87e99, '', '"\\{}[]:,\r\n', '🤖漢字ё', [], {},
    [{ '': {} }, { '\\"': [true, false, null, -123.45e-6] }, 'array string'],
    { nested: { a: [], b: [{ 'key[]{}\\"': 'value' }], c: {} }, final: 'tail' },
  ];
  for (const value of values) {
    const input = Buffer.from(JSON.stringify(value));
    const referenceParser = new JSONParser({ paths: [], keepStack: false });
    let expectedTokens = 0;
    referenceParser.onToken = () => { expectedTokens += 1; };
    referenceParser.write(input);
    if (!referenceParser.isEnded) referenceParser.end();
    for (let chunkSize = 1; chunkSize <= Math.min(input.length, 13); chunkSize += 1) {
      const stats = inspect(input, chunkSize);
      assert.equal(stats.tokens, expectedTokens, JSON.stringify({ value, chunkSize }));
    }
  }
});
