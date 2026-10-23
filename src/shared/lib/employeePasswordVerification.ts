import { scrypt, timingSafeEqual } from 'node:crypto';

// One scrypt per Node worker: the deployed two-worker PM2 setup can execute at
// most two employee password checks at once, without filling libuv's whole pool.
export const EMPLOYEE_PASSWORD_VERIFICATION_LIMITS = {
  concurrent: 1,
  pending: 64,
  queuedBytes: 1024 * 1024,
  perIdentity: 2,
  queueTimeoutMs: 10_000,
  executionTimeoutMs: 10_000,
} as const;

export class EmployeePasswordVerificationUnavailable extends Error {
  constructor(readonly verificationStarted: boolean) {
    super('Employee password verification temporarily unavailable');
    this.name = 'EmployeePasswordVerificationUnavailable';
  }
}

type VerificationOptions = { identity: string; signal?: AbortSignal };
type DeriveKey = (password: string, salt: string) => Promise<Buffer>;
type QueueOptions = {
  concurrent?: number;
  pending?: number;
  queuedBytes?: number;
  perIdentity?: number;
  queueTimeoutMs?: number;
  executionTimeoutMs?: number;
  deriveKey?: DeriveKey;
};
type Task = { identity: string; start: () => void };

const deriveKey: DeriveKey = (password, salt) => new Promise((resolve, reject) => {
  scrypt(password, salt, 64, (error, result) => error ? reject(error) : resolve(result));
});

/** Factory permits isolated concurrency tests; request code uses the singleton below. */
export function createEmployeePasswordVerifier(options: QueueOptions = {}) {
  const limits = { ...EMPLOYEE_PASSWORD_VERIFICATION_LIMITS, ...options };
  const derive = options.deriveKey ?? deriveKey;
  for (const value of [limits.concurrent, limits.perIdentity, limits.queueTimeoutMs, limits.executionTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid password verification limit');
  }
  for (const value of [limits.pending, limits.queuedBytes]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid password queue limit');
  }
  let running = 0;
  let queuedBytes = 0;
  const pending: Task[] = [];
  const identities = new Map<string, number>();
  const releaseIdentity = (identity: string) => {
    const count = (identities.get(identity) ?? 1) - 1;
    if (count) identities.set(identity, count);
    else identities.delete(identity);
  };
  const drain = () => {
    while (running < limits.concurrent && pending.length) pending.shift()!.start();
  };

  return async function verify(password: string, storedHash: string, input: VerificationOptions): Promise<boolean> {
    // Existing hashes are exactly this format. Reject malformed/oversized values
    // before allocating buffers or submitting expensive work to the native pool.
    if (!/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(storedHash)) return false;
    if (input.signal?.aborted) throw new EmployeePasswordVerificationUnavailable(false);
    if ((identities.get(input.identity) ?? 0) >= limits.perIdentity
      || (running >= limits.concurrent && pending.length >= limits.pending)) {
      throw new EmployeePasswordVerificationUnavailable(false);
    }
    // Bound retained queued secrets without imposing a new password length rule:
    // when a native slot is free, previously valid long passwords still work.
    let reservedBytes = running >= limits.concurrent ? Buffer.byteLength(password, 'utf8') : 0;
    if (reservedBytes > limits.queuedBytes - queuedBytes) {
      throw new EmployeePasswordVerificationUnavailable(false);
    }
    queuedBytes += reservedBytes;
    const releaseQueuedBytes = () => { queuedBytes -= reservedBytes; reservedBytes = 0; };
    const [, salt, hash] = storedHash.split(':');
    identities.set(input.identity, (identities.get(input.identity) ?? 0) + 1);

    return new Promise<boolean>((resolve, reject) => {
      let started = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      // Cleared when a queued request is dropped; do not retain its password.
      let calculate: (() => Promise<Buffer>) | undefined = () => derive(password, salt);
      const cleanupResponse = () => {
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', unavailable);
      };
      const unavailable = () => {
        if (settled) return;
        settled = true;
        cleanupResponse();
        if (!started) {
          const index = pending.indexOf(task);
          if (index !== -1) pending.splice(index, 1);
          calculate = undefined;
          releaseQueuedBytes();
          releaseIdentity(input.identity);
        }
        // Native scrypt cannot be cancelled. A running job keeps its slot until
        // its callback, even when the client disconnected or stopped waiting.
        reject(new EmployeePasswordVerificationUnavailable(started));
      };
      const task: Task = {
        identity: input.identity,
        start: () => {
          started = true;
          releaseQueuedBytes();
          running++;
          clearTimeout(timer);
          timer = setTimeout(unavailable, limits.executionTimeoutMs);
          const work = calculate!;
          calculate = undefined;
          Promise.resolve().then(work).then((actual) => {
            if (settled) return;
            settled = true;
            const expected = Buffer.from(hash, 'hex');
            resolve(actual.length === expected.length && timingSafeEqual(actual, expected));
          }, () => {
            if (settled) return;
            settled = true;
            reject(new EmployeePasswordVerificationUnavailable(true));
          }).finally(() => {
            cleanupResponse();
            running--;
            releaseIdentity(input.identity);
            drain();
          });
        },
      };
      timer = setTimeout(unavailable, limits.queueTimeoutMs);
      input.signal?.addEventListener('abort', unavailable, { once: true });
      if (running < limits.concurrent) task.start();
      else pending.push(task);
    });
  };
}

const state = globalThis as typeof globalThis & {
  __ktsEmployeePasswordVerifierV1?: ReturnType<typeof createEmployeePasswordVerifier>;
};
export const verifyEmployeePassword = state.__ktsEmployeePasswordVerifierV1
  ??= createEmployeePasswordVerifier();
