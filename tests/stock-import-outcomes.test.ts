import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

import type { StockEmailImportResult } from '../src/entities/catalog/api/stockImportTypes';
import { TransactionCommitUnknownError } from '../src/shared/lib/db/transactionOutcome';

const require = createRequire(import.meta.url);
const compiled = new Map<string, Promise<string>>();

async function harness(kind: 'admin' | 'cron', options: { importError?: unknown; failCache?: boolean; failAudit?: boolean } = {}) {
  const path = kind === 'admin' ? '../src/app/api/admin/stock-import/check-email/route.ts' : '../src/app/api/cron/stock-import/route.ts';
  if (!compiled.has(kind)) compiled.set(kind, build({
    entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external', logLevel: 'silent',
    define: { 'process.env.CRON_SECRET': JSON.stringify('synthetic-stock-cron-secret') },
    plugins: [{ name: 'stock-route-faults', setup(builder) {
      builder.onResolve({ filter: /^@\// }, ({ path }) => {
        if (path.endsWith('/postCommitTasks')) return undefined;
        return { path, external: true };
      });
    } }],
  }).then((result) => result.outputFiles[0].text));
  const events: string[] = [];
  const saved: StockEmailImportResult = {
    status: 'completed', processed: 1, checkedMessages: 1,
    skipped: { sender: 0, subject: 0, attachment: 0, samples: [] },
    settings: { allowedFrom: 'synthetic@example.invalid', filePrefix: '', subjectPart: '', scanLimit: 300 },
    result: { saved: true, logId: 12, fileName: 'Synthetic.xlsx', emailFrom: '', emailSubject: '', status: 'success', totalRows: 1, updatedRows: 1, notFoundRows: 0, failedRows: 0, errors: [] },
    warnings: [{ code: 'stock_mail_move_failed', message: 'Сохранено; перенос письма требует повторения.' }],
  };
  const services = {
    async importStockFromEmail() { events.push('import'); if (options.importError) throw options.importError; return saved; },
    revalidatePublicCatalog() { events.push('cache'); if (options.failCache) throw new Error('Synthetic cache failure'); },
    async recordSecurityEvent(event: { eventType: string }, auditOptions?: { required?: boolean }) {
      assert.equal(auditOptions?.required, true, 'the real audit helper otherwise swallows failures before warning handling');
      events.push(event.eventType);
      if (options.failAudit && auditOptions?.required) throw new Error('Synthetic audit failure');
    },
    async requireAdminSession() { return { denied: null, session: { adminUserId: 1, sessionId: 2 } }; },
    enforceSameOriginRequest() { return null; },
    async enforceAdminActionRateLimit() { return null; },
    getClientIp() { return '127.0.0.1'; },
    TransactionCommitUnknownError,
  };
  const loaded = { exports: {} as { POST(request: Request): Promise<Response> } };
  new Function('require', 'module', 'exports', await compiled.get(kind)!)((name: string) => {
    if (name.startsWith('@/')) return services;
    assert.equal(name, 'node:crypto', 'no real mail or database dependency is permitted');
    return require(name);
  }, loaded, loaded.exports);
  return {
    events,
    run: () => loaded.exports.POST(new Request('https://synthetic.example.invalid/api/stock-import', {
      method: 'POST', headers: { authorization: 'Bearer synthetic-stock-cron-secret' },
    })),
  };
}

for (const kind of ['admin', 'cron'] as const) {
  test(`${kind}: committed stock returns success plus warnings when revalidation and security audit fail`, async () => {
    const h = await harness(kind, { failCache: true, failAudit: true });
    const response = await h.run();
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.result.saved, true);
    assert.equal(body.result.logId, 12);
    assert.deepEqual(body.warnings.map((warning: { code: string }) => warning.code), ['stock_mail_move_failed', 'stock_catalog_refresh_failed', 'stock_security_audit_failed']);
    assert.deepEqual(h.events, ['import', 'cache', 'stock_import_check_email']);
  });

  test(`${kind}: precommit failure stays not saved even if failure auditing also fails`, async () => {
    const h = await harness(kind, { importError: new Error('Synthetic log insert failure'), failAudit: true });
    const response = await h.run();
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.saved, false);
    assert.match(body.error, /Synthetic log insert failure/);
    assert.deepEqual(h.events, ['import', 'stock_import_check_email_failed']);
  });

  test(`${kind}: unconfirmed COMMIT is explicitly unknown, never a confirmed failed save`, async () => {
    const h = await harness(kind, { importError: new TransactionCommitUnknownError() });
    const response = await h.run();
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.saved, null);
    assert.equal(body.code, 'COMMIT_OUTCOME_UNKNOWN');
    assert.match(body.error, /журнал/);
    assert.deepEqual(h.events, ['import', 'stock_import_check_email_failed']);
  });
}
