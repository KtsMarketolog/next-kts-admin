import { performance } from 'node:perf_hooks';

// Bound the work handed to the real parser, even if an upstream stream emits a
// much larger chunk. The caller should also yield between chunks when possible.
export const SNAPSHOT_JSON_PROCESSING_CHUNK_BYTES = 64 * 1024;
const CLOCK_CHECK_BYTES = 4 * 1024;

export type SnapshotJsonResourceLimits = {
  /** Encoded UTF-8 bytes inside one quoted value, including escape sequences. */
  maxStringBytes: number;
  /** Encoded UTF-8 bytes inside an object key. */
  maxKeyBytes: number;
  /** Bytes of one unquoted scalar. Valid booleans/null need at most five. */
  maxNumberBytes: number;
  maxDepth: number;
  /** Strings, scalars and punctuation all count as tokens. */
  maxTokens: number;
  /** Cumulative synchronous validation time; network/disk waits do not count. */
  maxProcessingMs: number;
};

export type SnapshotJsonResourceErrorCode =
  | 'JSON_STRING_TOO_LARGE'
  | 'JSON_KEY_TOO_LARGE'
  | 'JSON_NUMBER_TOO_LARGE'
  | 'JSON_TOO_DEEP'
  | 'JSON_TOO_COMPLEX'
  | 'JSON_PROCESSING_LIMIT';

export class SnapshotJsonResourceError extends Error {
  constructor(
    public readonly code: SnapshotJsonResourceErrorCode,
    public readonly limit: number,
    public readonly observed: number,
  ) {
    // Do not include file contents, keys or personal data in errors or logs.
    super(code);
    this.name = 'SnapshotJsonResourceError';
  }
}

export type SnapshotJsonResourceStats = {
  bytes: number;
  /** Longest encoded quoted string, including keys. Quotes are not counted. */
  maxStringBytes: number;
  maxKeyBytes: number;
  /** Longest encoded value, quoted or unquoted; excludes keys. */
  maxScalarBytes: number;
  maxNumberBytes: number;
  maxDepth: number;
  tokens: number;
  containers: number;
  processingMs: number;
};

type ContainerState = 'array' | 'object-key' | 'object-value';

/**
 * Resource preflight, not a JSON grammar validator. It retains only bounded
 * nesting state and counters, never a key, value or complete JSON document.
 * Call the real UTF-8/JSON parser from consumeSlice: every slice is checked
 * before the parser can append it to its string/number buffers. Invalid JSON
 * (including mismatched delimiters or incomplete strings) remains the real
 * parser's responsibility.
 */
export function createSnapshotJsonResourceGuard(
  settings: SnapshotJsonResourceLimits,
  options: { now?: () => number } = {},
) {
  const limits = { ...settings };
  const limitNames: Array<keyof SnapshotJsonResourceLimits> = [
    'maxStringBytes', 'maxKeyBytes', 'maxNumberBytes', 'maxDepth', 'maxTokens', 'maxProcessingMs',
  ];
  for (const name of limitNames) {
    const value = limits[name];
    if (!Number.isFinite(value) || value <= 0
      || (name !== 'maxProcessingMs' && !Number.isSafeInteger(value))) {
      throw new RangeError(`Invalid snapshot JSON resource limit: ${name}`);
    }
  }

  const now = options.now ?? (() => performance.now());
  const result: SnapshotJsonResourceStats = {
    bytes: 0,
    maxStringBytes: 0,
    maxKeyBytes: 0,
    maxScalarBytes: 0,
    maxNumberBytes: 0,
    maxDepth: 0,
    tokens: 0,
    containers: 0,
    processingMs: 0,
  };
  const stack: ContainerState[] = [];
  let inString = false;
  let escaped = false;
  let stringIsKey = false;
  let stringBytes = 0;
  let inScalar = false;
  let scalarBytes = 0;
  // A UTF-8 BOM is accepted by the real parser, including across chunk splits.
  let bomPosition = 0;
  let finished = false;
  let failure: { error: unknown } | undefined;

  function fail(code: SnapshotJsonResourceErrorCode, limit: number, observed: number): never {
    throw new SnapshotJsonResourceError(code, limit, observed);
  }

  function countToken() {
    result.tokens += 1;
    if (result.tokens > limits.maxTokens) {
      fail('JSON_TOO_COMPLEX', limits.maxTokens, result.tokens);
    }
  }

  function recordStringSize() {
    result.maxStringBytes = Math.max(result.maxStringBytes, stringBytes);
    if (stringIsKey) result.maxKeyBytes = Math.max(result.maxKeyBytes, stringBytes);
    else result.maxScalarBytes = Math.max(result.maxScalarBytes, stringBytes);
  }

  function recordScalarSize() {
    result.maxNumberBytes = Math.max(result.maxNumberBytes, scalarBytes);
    result.maxScalarBytes = Math.max(result.maxScalarBytes, scalarBytes);
  }

  function assertWritable() {
    if (failure) throw failure.error;
    if (finished) throw new Error('Snapshot JSON resource guard is already finished');
  }

  function measure(work: (checkTime: () => void) => void) {
    const started = now();
    const checkTime = () => {
      const elapsed = result.processingMs + Math.max(0, now() - started);
      if (elapsed > limits.maxProcessingMs) {
        fail('JSON_PROCESSING_LIMIT', limits.maxProcessingMs, elapsed);
      }
    };
    try {
      checkTime();
      work(checkTime);
      checkTime();
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      result.processingMs += Math.max(0, now() - started);
    }
  }

  function scan(slice: Uint8Array, checkTime: () => void) {
    for (let index = 0; index < slice.length; index += 1) {
      if (index % CLOCK_CHECK_BYTES === 0) checkTime();
      const byte = slice[index];
      result.bytes += 1;

      if (result.bytes <= 3 && bomPosition === result.bytes - 1) {
        const expected = [0xef, 0xbb, 0xbf][bomPosition];
        if (byte === expected) {
          bomPosition += 1;
          continue;
        }
        // Any incomplete/invalid BOM is rejected by the actual UTF-8 parser.
        bomPosition = -1;
      }

      if (inString) {
        if (!escaped && byte === 0x22) {
          recordStringSize();
          inString = false;
          continue;
        }
        stringBytes += 1;
        const limit = stringIsKey ? limits.maxKeyBytes : limits.maxStringBytes;
        if (stringBytes > limit) {
          recordStringSize();
          fail(stringIsKey ? 'JSON_KEY_TOO_LARGE' : 'JSON_STRING_TOO_LARGE', limit, stringBytes);
        }
        if (escaped) escaped = false;
        else if (byte === 0x5c) escaped = true;
        continue;
      }

      const whitespace = byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
      const punctuation = byte === 0x7b || byte === 0x5b || byte === 0x7d
        || byte === 0x5d || byte === 0x3a || byte === 0x2c;
      if (inScalar) {
        if (!whitespace && !punctuation && byte !== 0x22) {
          scalarBytes += 1;
          if (scalarBytes > limits.maxNumberBytes) {
            recordScalarSize();
            fail('JSON_NUMBER_TOO_LARGE', limits.maxNumberBytes, scalarBytes);
          }
          continue;
        }
        recordScalarSize();
        inScalar = false;
      }

      if (whitespace) continue;
      countToken();
      if (byte === 0x22) {
        inString = true;
        escaped = false;
        stringBytes = 0;
        stringIsKey = stack[stack.length - 1] === 'object-key';
      } else if (byte === 0x7b || byte === 0x5b) {
        // Check before pushing: the guard's own state is bounded as well.
        const depth = stack.length + 1;
        result.maxDepth = Math.max(result.maxDepth, depth);
        if (depth > limits.maxDepth) fail('JSON_TOO_DEEP', limits.maxDepth, depth);
        stack.push(byte === 0x7b ? 'object-key' : 'array');
        result.containers += 1;
      } else if (byte === 0x7d || byte === 0x5d) {
        stack.pop();
      } else if (byte === 0x3a) {
        if (stack[stack.length - 1] === 'object-key') stack[stack.length - 1] = 'object-value';
      } else if (byte === 0x2c) {
        if (stack[stack.length - 1] === 'object-value') stack[stack.length - 1] = 'object-key';
      } else {
        inScalar = true;
        scalarBytes = 1;
      }
    }
    // Keep useful metrics even for values that cross stream chunk boundaries.
    if (inString) recordStringSize();
    if (inScalar) recordScalarSize();
  }

  return {
    write(chunk: Uint8Array, consumeSlice: (slice: Uint8Array) => void) {
      assertWritable();
      for (let offset = 0; offset < chunk.byteLength; offset += SNAPSHOT_JSON_PROCESSING_CHUNK_BYTES) {
        const slice = chunk.subarray(offset, offset + SNAPSHOT_JSON_PROCESSING_CHUNK_BYTES);
        measure((checkTime) => {
          scan(slice, checkTime);
          checkTime();
          consumeSlice(slice);
        });
      }
    },
    finish(consumeFinal?: () => void): SnapshotJsonResourceStats {
      assertWritable();
      measure(() => { consumeFinal?.(); });
      finished = true;
      return { ...result };
    },
    stats(): SnapshotJsonResourceStats {
      return { ...result };
    },
  };
}
