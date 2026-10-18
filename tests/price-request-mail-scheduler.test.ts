import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const script = readFileSync('scripts/price-request-mail-drain.mjs', 'utf8');
const secret = 'synthetic-price-mail-scheduler-secret';
async function harness(input: { url?: string; body?: unknown; redirect?: boolean; huge?: boolean } = {}) {
  const messages: string[] = [];
  let calls = 0;
  const process = { env: { PRICE_REQUEST_MAIL_CRON_SECRET: secret, PRICE_REQUEST_MAIL_CRON_URL: input.url }, exitCode: 0 };
  const outcome = runInNewContext(`(async()=>{${script.replace(/^#![^\n]*\n/, '')}})()`, {
    process, Buffer, URL, AbortSignal, Response,
    console: { log: (value: string) => messages.push(value), error: (value: string) => messages.push(value) },
    fetch: async (_url: URL, options: RequestInit) => {
      calls++;
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(new Headers(options.headers).get('authorization'), `Bearer ${secret}`);
      assert.ok(options.signal);
      if (input.redirect) throw new Error('Redirect refused');
      return Response.json(input.huge ? { data: 'x'.repeat(5000) } : input.body ?? { sent: 0, deferred: 1, pending: 2, failed: 0 });
    },
  });
  return { outcome, messages, calls: () => calls, process };
}

test('mail scheduler accepts pending retries without treating SMTP outage as failed deployment', async () => {
  const h = await harness(); await h.outcome;
  assert.equal(h.calls(), 1); assert.equal(h.process.exitCode, 0);
  assert.deepEqual(JSON.parse(h.messages[0]), { sent: 0, deferred: 1, pending: 2, failed: 0 });
});
test('scheduler never forwards credentials to an external host, changed path or redirect', async () => {
  for (const url of ['https://example.test/api/cron/price-request-mail', 'http://127.0.0.1:3000/other',
    'http://name:pass@localhost/api/cron/price-request-mail', 'http://localhost/api/cron/price-request-mail?token=x']) {
    const h = await harness({ url }); await assert.rejects(h.outcome);
    assert.equal(h.calls(), 0);
  }
  const h = await harness({ redirect: true }); await h.outcome;
  assert.equal(h.process.exitCode, 1);
  assert.ok(h.messages.every((value) => !value.includes(secret)));
});
test('scheduler validates bounded aggregate results and ignores other fields', async () => {
  for (const options of [{ huge: true }, { body: { sent: -1, deferred: 0, pending: 0, failed: 0 } },
    { body: { sent: 6, deferred: 0, pending: 0, failed: 0 } }]) {
    const h = await harness(options); await h.outcome; assert.equal(h.process.exitCode, 1);
  }
  const h = await harness({ body: { sent: 0, deferred: 0, pending: 2, failed: 2, private: 'must-not-log' } });
  await h.outcome; assert.equal(h.process.exitCode, 0);
  assert.ok(h.messages.includes('PRICE_REQUEST_MAIL_REQUIRES_ATTENTION'));
  assert.ok(h.messages.every((value) => !value.includes('must-not-log')));
});
test('release packages and configures scheduler before canary; enables after complete activation', () => {
  const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
  assert.match(workflow, /cp scripts\/price-request-mail-drain\.mjs deploy-artifact\/scripts\//);
  assert.match(workflow, /ops\/price-request-mail\/kts-price-request-mail\.timer deploy-artifact\/ops\/price-request-mail\//);
  const backup = workflow.indexOf('if ! "$BACKUP_RUNNER" predeploy; then');
  const install = workflow.indexOf('node "$RELEASE/ops/price-request-mail/install.mjs" --app-env "$BASE/.env.local" --apply');
  const canary = workflow.indexOf('KTS_PM2_CANARY=1 KTS_PM2_PORT=3001');
  const ready = workflow.indexOf('if ! wait_for_release_workers');
  const committed = workflow.indexOf('ACTIVATION_STARTED=0\n          trap - EXIT', ready);
  const drain = workflow.indexOf('systemctl --user start kts-price-request-mail.service');
  assert.ok(backup >= 0 && backup < install && install < canary && canary < ready && ready < committed && committed < drain);
  assert.match(workflow, /systemctl --user is-active --quiet kts-price-request-mail\.timer/);
});
