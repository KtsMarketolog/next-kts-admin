import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import type { FetchMessageObject, ImapFlowOptions, MessageStructureObject } from 'imapflow';

import {
  getManagerDashboardMailStatus,
  importManagerDashboardFromEmail,
  MANAGER_DASHBOARD_MAIL_MAX_ATTACHMENT_BYTES,
  MANAGER_DASHBOARD_MAIL_MAX_MESSAGE_BYTES,
  type ManagerDashboardMailClient,
  type ManagerDashboardMailDependencies,
} from '../src/shared/lib/managerDashboardMail';

const currentDate = new Date('2026-09-14T06:55:00Z');
const enabledEnv = {
  MANAGER_DASHBOARD_MAIL_ENABLED: 'true',
  MANAGER_DASHBOARD_MAIL_ALLOWED_FROM: 'reports@example.com',
  STOCK_MAIL_HOST: 'imap.example.com',
  STOCK_MAIL_USER: 'inbox@example.com',
  STOCK_MAIL_PASSWORD: 'test-credential-not-a-secret',
};

function message(uid: number, names: string[], overrides: Partial<FetchMessageObject> = {}): FetchMessageObject {
  return {
    seq: uid, uid, size: 20_000, internalDate: currentDate,
    envelope: { from: [{ address: 'reports@example.com' }], messageId: `<${uid}@example.com>` },
    bodyStructure: {
      type: 'multipart/mixed',
      childNodes: names.map((filename, i) => ({
        type: 'application/octet-stream', part: `${i + 1}`, disposition: 'attachment',
        dispositionParameters: { filename }, size: 100,
      })),
    },
    ...overrides,
  };
}

function harness(messages: FetchMessageObject[], overrides: Partial<ManagerDashboardMailDependencies> = {}) {
  const events: string[] = [];
  const calls: Array<Parameters<ManagerDashboardMailDependencies['importSnapshot']>[0]> = [];
  const downloaded: Array<{ uid: string; part: string }> = [];
  const failures: Array<Parameters<ManagerDashboardMailDependencies['recordFailure']>[0]> = [];
  let clientOptions: ImapFlowOptions | undefined;
  let fetchRange: unknown;
  let activeFetch = false;
  let uidValidity = BigInt(100);
  const seen = new Set<string>();
  const client = {
    get mailbox() { return { exists: 1200, uidValidity, readOnly: true }; },
    on() { return this; },
    async connect() { events.push('connect'); },
    async getMailboxLock(path: string, options: { readOnly: boolean }) {
      assert.equal(path, 'INBOX');
      assert.equal(options.readOnly, true);
      events.push('mailbox-lock');
      return { path, release() { events.push('mailbox-release'); } };
    },
    async *fetch(range: unknown, query: Record<string, unknown>, options: { uid: boolean }) {
      fetchRange = range;
      assert.deepEqual(query, { uid: true, envelope: true, bodyStructure: true, size: true, internalDate: true });
      assert.equal(options.uid, false);
      activeFetch = true;
      try { yield* messages; } finally { activeFetch = false; }
    },
    async download(uid: string, part: string, options: { uid: boolean; maxBytes: number; chunkSize: number }) {
      assert.equal(activeFetch, false, 'download must not occur inside the FETCH iterator');
      assert.equal(options.uid, true);
      assert.equal(options.maxBytes, MANAGER_DASHBOARD_MAIL_MAX_ATTACHMENT_BYTES + 1);
      assert.equal(options.chunkSize, 64 * 1024);
      downloaded.push({ uid, part });
      return { meta: { expectedSize: 8, contentType: 'application/octet-stream' }, content: Readable.from([Buffer.from(`${uid}:${part}`)]) };
    },
    async logout() { events.push('logout'); },
    close() { events.push('close'); },
    messageMove() { assert.fail('must never move email'); },
    messageDelete() { assert.fail('must never delete email'); },
    messageFlagsAdd() { assert.fail('must never mark email'); },
    mailboxCreate() { assert.fail('must never create email folders'); },
  };
  const dependencies: ManagerDashboardMailDependencies = {
    async createClient(options) { clientOptions = options; return client as unknown as ManagerDashboardMailClient; },
    async acquireLock(name) {
      assert.match(name, /^manager_dashboard_mail:[a-f0-9]{64}$/);
      events.push('database-lock');
      return async () => { events.push('database-release'); };
    },
    async importSnapshot(input) {
      calls.push(input);
      const duplicate = seen.has(input.sourceKey);
      seen.add(input.sourceKey);
      return { status: duplicate ? 'duplicate' : 'imported', managerId: calls.length, code: duplicate ? 'duplicate' : 'imported' };
    },
    async recordFailure(input) {
      failures.push(input);
      return { status: 'invalid', managerId: null, code: input.code };
    },
    now: () => currentDate,
    ...overrides,
  };
  return {
    dependencies, client, calls, downloaded, failures, events,
    get clientOptions() { return clientOptions; },
    get fetchRange() { return fetchRange; },
    setUidValidity(value: bigint) { uidValidity = value; },
    run(env = enabledEnv) { return importManagerDashboardFromEmail({ env, dependencies }); },
  };
}

test('manager email imports all 11 attachments and repeats produce 11 durable duplicate outcomes without mailbox writes', async () => {
  const names = Array.from({ length: 11 }, (_, i) => `Менеджер_${i + 1}.ktsp`);
  const h = harness([message(42, names)]);
  const first = await h.run();
  assert.equal(first.status, 'completed');
  assert.equal(first.imported, 11);
  assert.equal(first.attachments, 11);
  assert.equal(first.failed, 0);
  assert.deepEqual(h.calls.map((input) => input.filename), names);
  assert.equal(new Set(h.calls.map((input) => input.sourceKey)).size, 11);
  assert.ok(h.calls.every((input) => input.sourceKey.length <= 512));
  assert.equal(h.calls[0].sender, 'reports@example.com');
  assert.equal(h.calls[0].messageId, '<42@example.com>');
  assert.equal(h.fetchRange, '901:1200');
  assert.deepEqual(h.events, ['database-lock', 'connect', 'mailbox-lock', 'mailbox-release', 'logout', 'close', 'database-release']);
  const second = await h.run();
  assert.equal(second.imported, 0);
  assert.equal(second.duplicates, 11);
  assert.equal(second.failed, 0);
});

test('manager email disabled and missing or invalid sender settings fail closed before DB or IMAP access', async () => {
  for (const env of [
    {}, { ...enabledEnv, MANAGER_DASHBOARD_MAIL_ENABLED: 'false' },
    { ...enabledEnv, MANAGER_DASHBOARD_MAIL_ALLOWED_FROM: '' },
    { ...enabledEnv, MANAGER_DASHBOARD_MAIL_ALLOWED_FROM: '*@example.com' },
    { ...enabledEnv, MANAGER_DASHBOARD_MAIL_ALLOWED_FROM: 'invalid' },
  ]) {
    const h = harness([message(1, ['manager.ktsp'])]);
    const result = await importManagerDashboardFromEmail({ env, dependencies: h.dependencies });
    assert.equal(result.status, 'disabled');
    assert.deepEqual(h.events, []);
    assert.equal(h.calls.length, 0);
  }
  assert.deepEqual(getManagerDashboardMailStatus(enabledEnv), { enabled: true, configured: true, reason: undefined });
  assert.deepEqual(Object.keys(getManagerDashboardMailStatus(enabledEnv)).sort(), ['configured', 'enabled', 'reason']);
});

test('manager email exact single From allowlist rejects spoofed suffixes, multiple senders, stock default and mailbox self', async () => {
  const senders = [
    [{ address: 'reports@example.com.evil' }], [{ address: 'inbox@example.com' }],
    [{ address: 'saunakva@yandex.ru' }], [{ address: 'reports@example.com' }, { address: 'evil@example.com' }], [],
  ];
  const h = harness(senders.map((from, i) => message(i + 1, ['manager.ktsp'], { envelope: { from } })));
  const result = await h.run();
  assert.equal(result.skipped.sender, 5);
  assert.equal(h.downloaded.length, 0);
  assert.equal(h.calls.length, 0);
});

test('manager email handles several messages and isolates bad, unmapped and stale attachments from valid ones', async () => {
  const h = harness([
    message(11, ['ok.ktsp', 'invalid.ktsp', 'stock.xlsx', 'unknown.ktsp']),
    message(12, ['stale.ktsp', 'after.ktsp']),
  ], {
    async importSnapshot({ filename }) {
      const status = filename === 'invalid.ktsp' ? 'invalid'
        : filename === 'unknown.ktsp' ? 'unknown' : filename === 'stale.ktsp' ? 'stale' : 'imported';
      return { status, code: status, managerId: status === 'unknown' ? null : 1 };
    },
  });
  const result = await h.run();
  assert.equal(result.checkedMessages, 2);
  assert.equal(result.attachments, 5);
  assert.equal(result.imported, 2);
  assert.equal(result.failed, 2);
  assert.equal(result.stale, 1);
  assert.deepEqual(result.results.map((item) => item.originalName), ['stale.ktsp', 'after.ktsp', 'ok.ktsp', 'invalid.ktsp', 'unknown.ktsp']);
});

test('manager email rejects oversized messages before downloading and ignores old messages using internal date', async () => {
  const h = harness([
    message(1, ['big.ktsp'], { size: MANAGER_DASHBOARD_MAIL_MAX_MESSAGE_BYTES + 1 }),
    message(2, ['old.ktsp'], { internalDate: new Date('2026-08-01T00:00:00Z'), envelope: { from: [{ address: 'reports@example.com' }], date: currentDate } }),
    message(3, ['ok.ktsp']),
  ]);
  const result = await h.run();
  assert.equal(result.skipped.messageSize, 1);
  assert.equal(result.skipped.age, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.imported, 1);
  assert.deepEqual(h.downloaded, [{ uid: '3', part: '1' }]);
  assert.deepEqual(h.failures.map((entry) => entry.code), ['MESSAGE_TOO_LARGE']);
});

test('manager email bounds decoded streams to 8 MiB even with small reported MIME size and continues afterward', async () => {
  const h = harness([message(1, ['large.ktsp', 'after.ktsp'])]);
  const originalDownload = h.client.download.bind(h.client);
  let largeStream: Readable | undefined;
  h.client.download = async (uid, part, options) => {
    if (part !== '1') return originalDownload(uid, part, options);
    largeStream = Readable.from((async function* () {
      for (let i = 0; i < 129; i++) yield Buffer.alloc(64 * 1024);
    })());
    return { meta: { expectedSize: 1, contentType: 'application/octet-stream' }, content: largeStream };
  };
  const result = await h.run();
  assert.equal(result.failed, 1);
  assert.equal(result.imported, 1);
  assert.equal(result.results[0].code, 'ATTACHMENT_TOO_LARGE');
  assert.equal(largeStream?.destroyed, true);
  assert.deepEqual(h.calls.map((input) => input.filename), ['after.ktsp']);
  assert.deepEqual(h.failures.map((entry) => entry.code), ['ATTACHMENT_TOO_LARGE']);
});

test('manager email identity changes with UIDVALIDITY, UID, attachment bytes and account', async () => {
  const h = harness([message(1, ['manager.ktsp'])]);
  await h.run();
  const first = h.calls[0].sourceKey;
  h.setUidValidity(BigInt(101));
  await h.run();
  assert.notEqual(first, h.calls[1].sourceKey);
  const h2 = harness([message(2, ['manager.ktsp'])]);
  await h2.run();
  assert.notEqual(first, h2.calls[0].sourceKey);
  const h3 = harness([message(1, ['manager.ktsp'])]);
  await h3.run({ ...enabledEnv, STOCK_MAIL_USER: 'other@example.com' });
  assert.notEqual(first, h3.calls[0].sourceKey);
  const h4 = harness([message(1, ['manager.ktsp'])]);
  h4.client.download = async () => ({ meta: { expectedSize: 7, contentType: 'application/octet-stream' }, content: Readable.from([Buffer.from('changed')]) });
  await h4.run();
  assert.notEqual(first, h4.calls[0].sourceKey);
});

test('manager email lock covers connect through logout and releases after transport or per-file infrastructure errors', async () => {
  const busy = harness([], { async acquireLock() { return null; } });
  assert.equal((await busy.run()).status, 'busy');
  assert.deepEqual(busy.events, []);
  const failure = harness([]);
  failure.client.connect = async () => { throw new Error('credentials must not appear'); };
  await assert.rejects(failure.run(), (error: Error) => {
    assert.doesNotMatch(error.message, /credentials/);
    return /Не удалось проверить почту/.test(error.message);
  });
  assert.equal(failure.events.at(-1), 'database-release');
  const partial = harness([message(1, ['bad.ktsp', 'good.ktsp'])], {
    async importSnapshot({ filename }) {
      if (filename === 'bad.ktsp') throw new Error('SQL secret');
      return { status: 'imported', managerId: 1, code: 'imported' };
    },
  });
  const result = await partial.run();
  assert.equal(result.failed, 1);
  assert.equal(result.imported, 1);
  assert.doesNotMatch(JSON.stringify(result), /SQL secret/);
  assert.equal(partial.events.at(-1), 'database-release');
});

test('manager email parses nested MIME parts and skips forwarded message attachments', async () => {
  const structure: MessageStructureObject = {
    type: 'multipart/mixed', childNodes: [
      { type: 'multipart/mixed', childNodes: [{ type: 'application/octet-stream', part: '1.2', parameters: { name: 'Альфия.ktsp' } }] },
      { type: 'message/rfc822', childNodes: [{ type: 'application/octet-stream', part: '2.1', parameters: { name: 'forwarded.ktsp' } }] },
    ],
  };
  const h = harness([message(1, [], { bodyStructure: structure })]);
  const result = await h.run();
  assert.equal(result.imported, 1);
  assert.equal(h.calls[0].filename, 'Альфия.ktsp');
  assert.deepEqual(h.downloaded, [{ uid: '1', part: '1.2' }]);
});

test('manager email accepts a single root attachment and retries transport failures with independent durable keys', async () => {
  const h = harness([message(1, [], {
    bodyStructure: { type: 'application/octet-stream', parameters: { name: 'manager.ktsp' } },
  })]);
  const originalDownload = h.client.download.bind(h.client);
  h.client.download = async () => { throw new Error('server said sensitive details'); };
  const failed = await h.run();
  assert.equal(failed.failed, 1);
  assert.equal(h.failures[0].code, 'ATTACHMENT_DOWNLOAD_FAILED');
  assert.doesNotMatch(JSON.stringify(failed), /sensitive/);
  h.client.download = originalDownload;
  const retried = await h.run();
  assert.equal(retried.imported, 1);
  assert.notEqual(h.failures[0].sourceKey, h.calls[0].sourceKey);
  assert.deepEqual(h.downloaded, [{ uid: '1', part: '1' }]);
});

test('manager email refuses a writable mailbox or missing UIDVALIDITY and still releases both locks', async () => {
  for (const mailbox of [
    { exists: 1, uidValidity: BigInt(1), readOnly: false },
    { exists: 1, uidValidity: BigInt(0), readOnly: true },
  ]) {
    const h = harness([message(1, ['manager.ktsp'])]);
    Object.defineProperty(h.client, 'mailbox', { value: mailbox });
    await assert.rejects(h.run(), /Не удалось проверить почту/);
    assert.equal(h.downloaded.length, 0);
    assert.ok(h.events.includes('mailbox-release'));
    assert.equal(h.events.at(-1), 'database-release');
  }
});

test('manager email enforces scan bound, safe config fallback and mandatory STARTTLS for plaintext ports', async () => {
  const h = harness(Array.from({ length: 5 }, (_, i) => message(i + 1, ['manager.ktsp'])));
  const result = await importManagerDashboardFromEmail({
    env: { ...enabledEnv, MANAGER_DASHBOARD_MAIL_SCAN_LIMIT: '2', MANAGER_DASHBOARD_MAIL_PORT: '143', MANAGER_DASHBOARD_MAIL_SECURE: 'false' },
    dependencies: h.dependencies,
  });
  assert.equal(result.checkedMessages, 2);
  assert.equal(h.fetchRange, '1199:1200');
  assert.equal(h.clientOptions?.host, 'imap.example.com');
  assert.equal(h.clientOptions?.auth?.user, 'inbox@example.com');
  assert.equal(h.clientOptions?.secure, false);
  assert.equal(h.clientOptions?.doSTARTTLS, true);
});
