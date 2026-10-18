import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  adminRequest, AdminRequestError, ADMIN_UNKNOWN_OUTCOME, ADMIN_REQUEST_TIMEOUT_MS,
  ADMIN_UPLOAD_TIMEOUT_MS, ADMIN_SNAPSHOT_TIMEOUT_MS, runWithRequestTimeout,
} from '../src/features/admin/shared/adminRequest';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('admin request reads the entire response within its deadline and preserves HTTP errors', async () => {
  globalThis.fetch = async () => Response.json({ error: 'Версия устарела', code: 'CONFLICT' }, { status: 409, headers: { 'x-test': 'preserved' } });
  const response = await adminRequest('/synthetic', { method: 'PUT' });
  assert.equal(response.status, 409);
  assert.equal(response.headers.get('x-test'), 'preserved');
  assert.deepEqual(await response.json(), { error: 'Версия устарела', code: 'CONFLICT' });
});

test('hung fetch releases a mutation even when the browser ignores abort; never retries', async () => {
  let calls = 0;
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = async (_url, init) => { calls++; signal = init?.signal; return new Promise(() => {}); };
  await assert.rejects(adminRequest('/synthetic', { method: 'PUT' }, { timeoutMs: 5 }), { message: ADMIN_UNKNOWN_OUTCOME, code: 'timeout' });
  assert.equal(signal?.aborted, true);
  assert.equal(calls, 1);
});

test('hung success body cannot keep the button busy indefinitely', async () => {
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = async (_url, init) => {
    signal = init?.signal;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }));
  };
  await assert.rejects(adminRequest('/synthetic', { method: 'POST' }, { timeoutMs: 5 }), { message: ADMIN_UNKNOWN_OUTCOME, code: 'timeout' });
  assert.equal(signal?.aborted, true);
});

test('hung error body is bounded too', async () => {
  globalThis.fetch = async () => new Response(new ReadableStream(), { status: 500 });
  await assert.rejects(adminRequest('/synthetic', {}, { timeoutMs: 5 }), { code: 'timeout' });
});

test('live cancellation rejects promptly and warns that a write may have committed', async () => {
  const controller = new AbortController();
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = async (_url, init) => { signal = init?.signal; return new Promise(() => {}); };
  const pending = adminRequest('/synthetic', { method: 'DELETE', signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { message: ADMIN_UNKNOWN_OUTCOME, code: 'cancelled' });
  assert.equal(signal?.aborted, true);
});

test('pre-cancelled requests do not reach the server', async () => {
  globalThis.fetch = async () => { throw new Error('must not be called'); };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(adminRequest('/synthetic', { signal: controller.signal }), { code: 'cancelled', message: 'Запрос отменён до отправки.' });
});

test('network errors do not claim a mutation was rolled back', async () => {
  globalThis.fetch = async () => { throw new Error('sensitive internal network details'); };
  await assert.rejects(adminRequest('/synthetic', { method: 'PATCH' }), { message: ADMIN_UNKNOWN_OUTCOME, code: 'network' });
  await assert.rejects(adminRequest('/synthetic'), (error: unknown) => error instanceof AdminRequestError && !error.message.includes('sensitive') && !error.message.includes('сохраниться'));
});

test('POST used for read-only export can opt out of unknown-save wording', async () => {
  globalThis.fetch = async () => { throw new Error('network'); };
  await assert.rejects(adminRequest('/synthetic', { method: 'POST' }, { mutation: false }), { message: 'Не удалось получить ответ сервера. Повторите загрузку данных.' });
});

test('uploads forward FormData without reading or transforming the file', async () => {
  const form = new FormData();
  form.append('file', new Blob(['synthetic']), 'fixture.txt');
  globalThis.fetch = async (_url, init) => {
    assert.equal(init?.body, form);
    assert.equal(init?.headers, undefined, 'Browser must supply multipart boundary');
    return new Response(null, { status: 204 });
  };
  const response = await adminRequest('/synthetic', { method: 'POST', body: form }, { timeoutMs: ADMIN_UPLOAD_TIMEOUT_MS });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
});

test('read/cancel listeners are removed after completion', async () => {
  const controller = new AbortController();
  let added = 0;
  let removed = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args: Parameters<AbortSignal['addEventListener']>) => { added++; add(...args); };
  controller.signal.removeEventListener = (...args: Parameters<AbortSignal['removeEventListener']>) => { removed++; remove(...args); };
  globalThis.fetch = async () => Response.json({ saved: true });
  await adminRequest('/synthetic', { signal: controller.signal });
  assert.equal(added, 1);
  assert.equal(removed, 1);
});

test('late fetch resolution cannot turn a timed-out operation into success', async () => {
  let resolve!: (response: Response) => void;
  let successes = 0;
  globalThis.fetch = () => new Promise((done) => { resolve = done; });
  const pending = adminRequest('/synthetic', { method: 'POST' }, { timeoutMs: 5 }).then(() => { successes++; });
  await assert.rejects(pending, { code: 'timeout' });
  resolve(Response.json({ saved: true }));
  await new Promise((done) => setTimeout(done, 5));
  assert.equal(successes, 0);
});

test('bounded callbacks preserve business errors, not a false network diagnosis', async () => {
  const error = new Error('Conflict');
  await assert.rejects(runWithRequestTimeout(async () => { throw error; }), (received) => received === error);
});

test('large snapshots are not constrained by the simple-edit timeout', () => {
  assert.equal(ADMIN_REQUEST_TIMEOUT_MS, 20_000);
  assert.equal(ADMIN_UPLOAD_TIMEOUT_MS, 300_000);
  assert.equal(ADMIN_SNAPSHOT_TIMEOUT_MS, 1_200_000);
  assert.ok(ADMIN_SNAPSHOT_TIMEOUT_MS > 15 * 60_000, 'Allow server receipt/validation deadline plus response time');
});
