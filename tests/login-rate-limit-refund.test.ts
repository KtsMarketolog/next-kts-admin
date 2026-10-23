import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

function harness() {
  let count = 0;
  let window = '2026-10-23 00:00:00.123456+00';
  const queries: string[] = [];
  const code = ts.transpileModule(readFileSync('src/shared/lib/rateLimit.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const modules: Record<string, unknown> = {
    crypto,
    './authSecret': { getAdminSessionSecret: () => 'synthetic-rate-limit-refund-only' },
    './db/schema': { ensureSiteSchema: async () => {} },
    './db/client': { query: async (sql: string, parameters: unknown[]) => {
      queries.push(sql);
      if (sql.startsWith('insert')) return { rows: [{ count: ++count, reset_at: window }] };
      if (sql.startsWith('with reserved')) {
        assert.match(sql, /where rate_limit_buckets.reset_at <= now\(\) or rate_limit_buckets.count < \$3/);
        const admitted = count < Number(parameters[2]);
        if (admitted) count++;
        return { rows: [{ count, reset_at: window, admitted }] };
      }
      assert.match(sql, /^update rate_limit_buckets set count = greatest\(0, count - 1\)/);
      assert.match(sql, /where key = \$1 and reset_at = \$2::timestamptz/);
      if (parameters[1] === window) count = Math.max(0, count - 1);
      return { rows: [] };
    } },
  };
  runInNewContext(code, { exports, console, require: (name: string) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`);
    return modules[name];
  } });
  const limits = exports as typeof import('../src/shared/lib/rateLimit');
  return {
    limits, queries, count: () => count,
    replaceWindow: () => { window = '2026-10-23 00:15:00.000001+00'; count = 5; },
  };
}

test('unconsumed refund is one-shot and subtracts exactly one reservation, preserving other guesses', async () => {
  const h = harness();
  await h.limits.checkDbRateLimit('employee', 8, 900_000);
  const reserved = await h.limits.checkDbRateLimit('employee', 8, 900_000, { refundable: true });
  await h.limits.checkDbRateLimit('employee', 8, 900_000);
  assert.equal(h.count(), 3);
  await Promise.all([reserved.refundUnconsumedAttempt!(), reserved.refundUnconsumedAttempt!()]);
  assert.equal(h.count(), 2);
  assert.equal(h.queries.filter((sql) => sql.startsWith('update')).length, 1);
});

test('refund preserves a replacement window and is unavailable on denied attempts', async () => {
  const h = harness();
  const reserved = await h.limits.checkDbRateLimit('employee', 8, 900_000, { refundable: true });
  h.replaceWindow();
  await reserved.refundUnconsumedAttempt!();
  assert.equal(h.count(), 5);
  const denied = await h.limits.checkDbRateLimit('employee', 1, 900_000, { refundable: true });
  assert.equal(denied.allowed, false);
  assert.equal(denied.refundUnconsumedAttempt, undefined);
  assert.equal(h.count(), 5, 'denied refundable reservations never inflate the bucket');
});
