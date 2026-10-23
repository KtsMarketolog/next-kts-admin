import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import {
  createEmployeePasswordVerifier,
  EmployeePasswordVerificationUnavailable,
  EMPLOYEE_PASSWORD_VERIFICATION_LIMITS,
} from '../src/shared/lib/employeePasswordVerification';

const password = 'SyntheticVerificationOnly871!';
const salt = '8'.repeat(32);
const expected = scryptSync(password, salt, 64);
const hash = `scrypt:${salt}:${expected.toString('hex')}`;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const unavailableBeforeStart = (error: unknown) => error instanceof EmployeePasswordVerificationUnavailable
  && !error.verificationStarted;

test('async employee verification accepts unchanged scrypt hashes and rejects a wrong password', async () => {
  const verify = createEmployeePasswordVerifier();
  assert.equal(await verify(password, hash, { identity: 'admin:1' }), true);
  assert.equal(await verify(`${password}-wrong`, hash, { identity: 'manager:1' }), false);
  assert.equal(EMPLOYEE_PASSWORD_VERIFICATION_LIMITS.concurrent, 1,
    'two deployed processes together must not start more than two employee scrypts');
});

test('malformed and oversized stored hashes fail closed without crypto', async () => {
  let calls = 0;
  const verify = createEmployeePasswordVerifier({ deriveKey: async () => { calls++; return expected; } });
  for (const bad of ['', 'invalid', `${hash}:extra`, hash.slice(0, -2), hash.replace(salt, 'f'.repeat(1_000_000)), hash.replace('scrypt', 'unknown')]) {
    assert.equal(await verify(password, bad, { identity: 'admin:1' }), false);
  }
  assert.equal(calls, 0);
});

test('bounded native work, bounded pending queue and per-identity isolation are independent of office IP', async () => {
  const releases: Array<() => void> = [];
  let running = 0;
  let peak = 0;
  const verify = createEmployeePasswordVerifier({ pending: 2, deriveKey: () => {
    running++;
    peak = Math.max(peak, running);
    return new Promise<Buffer>((resolve) => releases.push(() => { running--; resolve(expected); }));
  } });
  const first = verify(password, hash, { identity: 'admin:1' });
  const second = verify(password, hash, { identity: 'admin:1' });
  await assert.rejects(verify(password, hash, { identity: 'admin:1' }), unavailableBeforeStart);
  const colleague = verify(password, hash, { identity: 'admin:2' });
  await assert.rejects(verify(password, hash, { identity: 'admin:3' }), unavailableBeforeStart);
  await tick();
  assert.equal(releases.length, 1);
  releases.shift()!();
  await first;
  await tick();
  releases.shift()!();
  await second;
  await tick();
  releases.shift()!();
  await colleague;
  assert.equal(peak, 1);
});

test('aborting a queued request removes it without verification and allows replacement', async () => {
  const abort = new AbortController();
  const releases: Array<() => void> = [];
  let calls = 0;
  const verify = createEmployeePasswordVerifier({ pending: 1, deriveKey: () => {
    calls++;
    return new Promise<Buffer>((resolve) => releases.push(() => resolve(expected)));
  } });
  const first = verify(password, hash, { identity: 'admin:1' });
  const queued = verify(password, hash, { identity: 'admin:2', signal: abort.signal });
  const rejected = assert.rejects(queued, unavailableBeforeStart);
  abort.abort();
  await rejected;
  const replacement = verify(password, hash, { identity: 'admin:2' });
  await tick();
  releases.shift()!();
  await first;
  await tick();
  releases.shift()!();
  await replacement;
  assert.equal(calls, 2);
});

test('aborting running crypto does not release its slot before native completion', async () => {
  const abort = new AbortController();
  const releases: Array<() => void> = [];
  const verify = createEmployeePasswordVerifier({ deriveKey: () => new Promise<Buffer>((resolve) => releases.push(() => resolve(expected))) });
  const first = verify(password, hash, { identity: 'admin:1', signal: abort.signal });
  const rejected = assert.rejects(first, (error: unknown) => error instanceof EmployeePasswordVerificationUnavailable && error.verificationStarted);
  const second = verify(password, hash, { identity: 'admin:2' });
  await tick();
  abort.abort();
  await rejected;
  await tick();
  assert.equal(releases.length, 1);
  releases.shift()!();
  await tick();
  assert.equal(releases.length, 1);
  releases.shift()!();
  assert.equal(await second, true);
});

test('queued byte budget counts UTF-8, frees on abort/start, and never limits a password with a free slot', async () => {
  const releases: Array<() => void> = [];
  const abort = new AbortController();
  const verify = createEmployeePasswordVerifier({ queuedBytes: 4,
    deriveKey: () => new Promise<Buffer>((resolve) => releases.push(() => resolve(expected))),
  });
  const first = verify('long legacy password exceeds the queue budget', hash, { identity: 'admin:1' });
  const queued = verify('💡', hash, { identity: 'admin:2', signal: abort.signal });
  await assert.rejects(verify('a', hash, { identity: 'admin:3' }), unavailableBeforeStart);
  const rejected = assert.rejects(queued, unavailableBeforeStart);
  abort.abort();
  await rejected;
  const replacement = verify('éé', hash, { identity: 'admin:2' });
  await assert.rejects(verify('a', hash, { identity: 'admin:3' }), unavailableBeforeStart);
  await tick();
  releases.shift()!();
  assert.equal(await first, true, 'a free native slot preserves acceptance of long existing passwords');
  await tick();
  const next = verify('💡', hash, { identity: 'admin:3' });
  releases.shift()!();
  assert.equal(await replacement, true);
  await tick();
  releases.shift()!();
  assert.equal(await next, true);
});

test('queue timeout releases retained password bytes for a later queued request', async () => {
  let release!: () => void;
  const verify = createEmployeePasswordVerifier({ queuedBytes: 1, queueTimeoutMs: 15,
    deriveKey: () => new Promise<Buffer>((resolve) => { release = () => resolve(expected); }),
  });
  const running = verify(password, hash, { identity: 'admin:1' });
  await assert.rejects(verify('a', hash, { identity: 'admin:2' }), unavailableBeforeStart);
  const replacement = verify('b', hash, { identity: 'admin:2' });
  release();
  assert.equal(await running, true);
  await tick();
  release();
  assert.equal(await replacement, true);
});

test('queue and execution deadlines are bounded, and running timeout does not free native capacity', async () => {
  const releases: Array<() => void> = [];
  const verify = createEmployeePasswordVerifier({ queueTimeoutMs: 15, executionTimeoutMs: 30,
    deriveKey: () => new Promise<Buffer>((resolve) => releases.push(() => resolve(expected))),
  });
  const first = verify(password, hash, { identity: 'admin:1' });
  const firstRejected = assert.rejects(first, (error: unknown) => error instanceof EmployeePasswordVerificationUnavailable && error.verificationStarted);
  await assert.rejects(verify(password, hash, { identity: 'admin:2' }), unavailableBeforeStart);
  await firstRejected;
  await assert.rejects(verify(password, hash, { identity: 'admin:3' }), unavailableBeforeStart);
  assert.equal(releases.length, 1);
  releases.shift()!();
  await tick();
  const fresh = verify(password, hash, { identity: 'admin:1' });
  await tick();
  releases.shift()!();
  assert.equal(await fresh, true);
});

test('crypto errors release capacity but never become a wrong-password result', async () => {
  let calls = 0;
  const verify = createEmployeePasswordVerifier({ deriveKey: async () => {
    if (++calls === 1) throw new Error('synthetic private crypto failure');
    return expected;
  } });
  await assert.rejects(verify(password, hash, { identity: 'admin:1' }), EmployeePasswordVerificationUnavailable);
  assert.equal(await verify(password, hash, { identity: 'admin:1' }), true);
});

test('42 distinct office employees can verify concurrently while the event loop remains responsive', async () => {
  const verify = createEmployeePasswordVerifier();
  let completed = 0;
  const attempts = Array.from({ length: 42 }, (_, index) => verify(password, hash, { identity: `admin:${index + 1}` })
    .then((result) => { completed++; return result; }));
  await delay(0);
  assert.ok(completed < 42, 'a timer must run before the crypto batch finishes');
  assert.ok((await Promise.all(attempts)).every(Boolean));
});
