import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as crypto from 'node:crypto';
import { drainPriceRequestMail } from '../src/shared/lib/priceRequestMailWorker';
import type { ClaimedPriceRequestMail } from '../src/shared/lib/db/priceRequestOutboxRepo';

const mail: ClaimedPriceRequestMail = { id: '11', requestId: '9', recipient: 'synthetic@example.test',
  subject: 'Synthetic', html: '<p>Synthetic</p>', text: 'Synthetic', attempts: 1, leaseToken: crypto.randomUUID() };

test('worker bounds a drain to five envelopes and acknowledges only successful SMTP acceptance', async () => {
  let claimed = 0;
  const acknowledged: string[] = [];
  const deferred: string[] = [];
  const result = await drainPriceRequestMail({ now: () => 1,
    claim: async () => ({ ...mail, id: String(++claimed) }),
    send: async (item) => { if (item.id === '2') throw { code: 'EAUTH', message: 'Do not log provider reply or secrets' }; },
    acknowledge: async (item) => { acknowledged.push(item.id); return true; },
    defer: async (_, code) => { deferred.push(code); }, counts: async () => ({ pending: 1, failed: 0 }),
  });
  assert.deepEqual(result, { sent: 4, deferred: 1, pending: 1, failed: 0 });
  assert.equal(claimed, 5);
  assert.deepEqual(acknowledged, ['1', '3', '4', '5']);
  assert.deepEqual(deferred, ['EAUTH']);
});

test('worker stops claiming after its time budget and retains a lease on uncertain DB acknowledgement', async () => {
  let elapsed = 0;
  let claimed = 0;
  const result = await drainPriceRequestMail({ now: () => elapsed,
    claim: async () => { claimed++; return mail; }, send: async () => { elapsed += 20_000; },
    acknowledge: async () => true, defer: async () => assert.fail('no delivery failure'), counts: async () => ({ pending: 0, failed: 0 }),
  });
  assert.equal(claimed, 3);
  assert.equal(result.sent, 3);
  let deferred = false;
  await assert.rejects(drainPriceRequestMail({ now: () => 0, claim: async () => mail, send: async () => {},
    acknowledge: async () => { throw new Error('Synthetic DB unknown'); }, defer: async () => { deferred = true; },
    counts: async () => ({ pending: 1, failed: 0 }),
  }), /Synthetic DB unknown/);
  assert.equal(deferred, false);
});

test('unknown SMTP failures are sanitized and long outages still attempt delivery', async () => {
  let claimed = false;
  let sent = false;
  let deferred = '';
  await drainPriceRequestMail({ now: () => 0,
    claim: async () => { if (claimed) return null; claimed = true; return { ...mail, attempts: 72 }; },
    send: async () => { sent = true; throw { code: 'secret reply', message: 'password=secret' }; },
    acknowledge: async () => assert.fail('failed SMTP cannot be acknowledged'),
    defer: async (_, code) => { deferred = code; }, counts: async () => ({ pending: 1, failed: 0 }),
  });
  assert.equal(sent, true);
  assert.equal(deferred, 'DELIVERY_FAILED');
});

function smtpHarness(mode: 'accepted' | 'rejected' | 'timeout', configured = true) {
  const sent: Array<Record<string, unknown>> = [];
  let closes = 0;
  let transportOptions: Record<string, unknown> | null = null;
  let timeout: (() => void) | null = null;
  const output = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL('../src/shared/lib/priceRequestMailWorker.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { module: output, exports: output.exports, console,
    process: { env: configured ? { SMTP_USER: 'synthetic@example.test', SMTP_PASSWORD: 'synthetic-only', SMTP_HOST: 'smtp.invalid' } : {} },
    setTimeout: (callback: () => void, duration: number) => { assert.equal(duration, 15_000); timeout = callback; return 1; },
    clearTimeout: () => {},
    require: (name: string) => {
      if (name === './db/priceRequestOutboxRepo') return {};
      assert.equal(name, 'nodemailer');
      return { createTransport: (options: Record<string, unknown>) => {
        transportOptions = options;
        return { close: () => { closes++; }, sendMail: async (input: Record<string, unknown>) => {
          sent.push(input);
          if (mode === 'timeout') return new Promise(() => {});
          return mode === 'accepted' ? { accepted: [mail.recipient], rejected: [] } : { accepted: [], rejected: [mail.recipient] };
        } };
      } };
    },
  });
  return { send: (output.exports as { sendPriceRequestMail: (item: ClaimedPriceRequestMail) => Promise<void> }).sendPriceRequestMail,
    sent, get closes() { return closes; }, get options() { return transportOptions; }, expire: () => timeout?.() };
}

test('SMTP has bounded deadlines, stable Message-ID, per-recipient envelope and cleanup', async () => {
  const accepted = smtpHarness('accepted');
  await accepted.send(mail);
  await accepted.send(mail);
  assert.equal(accepted.sent[0].messageId, accepted.sent[1].messageId);
  assert.equal(accepted.sent[0].to, mail.recipient);
  assert.equal(accepted.options?.connectionTimeout, 5000);
  assert.equal(accepted.options?.socketTimeout, 10000);
  assert.equal(accepted.closes, 2);
  const rejected = smtpHarness('rejected');
  await assert.rejects(rejected.send(mail), { code: 'EENVELOPE' });
  const timeout = smtpHarness('timeout');
  const pending = timeout.send(mail);
  timeout.expire();
  await assert.rejects(pending, { code: 'ETIMEDOUT' });
  assert.ok(timeout.closes >= 1);
  const unconfigured = smtpHarness('accepted', false);
  await assert.rejects(unconfigured.send(mail), { code: 'ECONFIG' });
  assert.equal(unconfigured.sent.length, 0);
});

test('cron authenticates before draining and returns no SMTP data on failures', async () => {
  const output = { exports: {} };
  let drains = 0;
  let fail = false;
  const env: Record<string, string> = {};
  const code = ts.transpileModule(readFileSync(new URL('../src/app/api/cron/price-request-mail/route.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { module: output, exports: output.exports, Response, Buffer, process: { env }, console: { error: () => {} },
    require: (name: string) => {
      if (name === 'node:crypto') return crypto;
      assert.equal(name, '@/shared/lib/priceRequestMailWorker');
      return { drainPriceRequestMail: async () => {
        drains++; if (fail) throw new Error('SMTP credentials not for response');
        return { sent: 1, deferred: 0, pending: 0, failed: 0 };
      } };
    },
  });
  const post = (output.exports as { POST: (request: Request) => Promise<Response> }).POST;
  const call = (token?: string) => post(new Request('https://example.test/api/cron/price-request-mail', {
    method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {},
  }));
  assert.equal((await call()).status, 503);
  env.PRICE_REQUEST_MAIL_CRON_SECRET = 'synthetic-'.repeat(5);
  assert.equal((await call()).status, 401);
  assert.equal((await call('invalid')).status, 401);
  assert.equal(drains, 0);
  const success = await call(env.PRICE_REQUEST_MAIL_CRON_SECRET);
  assert.equal(success.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await success.json(), { sent: 1, deferred: 0, pending: 0, failed: 0 });
  fail = true;
  const failure = await call(env.PRICE_REQUEST_MAIL_CRON_SECRET);
  assert.equal(failure.status, 503);
  assert.doesNotMatch(await failure.text(), /credentials/);
});
