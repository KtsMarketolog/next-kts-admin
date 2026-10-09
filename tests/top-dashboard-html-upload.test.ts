import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as limits from '../src/shared/lib/topDashboardLimits';
import * as profitability from '../src/shared/lib/dashboardProfitabilityHtml';

const code = ts.transpileModule(readFileSync('src/app/api/admin/top-dashboard/blocks/routeUtils.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports: { readTopDashboardHtmlUpload?: (request: Request) => Promise<{ upload?: { fileSize: number; sha256: string }; error?: Response }> } = {};
runInNewContext(code, { exports, Buffer, File, Response, TextDecoder, setTimeout, clearTimeout,
  require: (name: string) => name === 'crypto' ? { createHash } : name === '@/shared/lib/topDashboardLimits' ? limits
    : name === '@/shared/lib/dashboardProfitabilityHtml' ? profitability : assert.fail(name) });
const readUpload = exports.readTopDashboardHtmlUpload!;
function request(bytes: string, name = 'report.html') {
  const form = new FormData(); form.append('file', new File([bytes], name, { type: 'text/html' }));
  return new Request('https://kts.test/upload', { method: 'POST', body: form });
}
test('TOP accepts self-contained 13MiB HTML but keeps bounded 20MiB cap', async () => {
  const html = '<!doctype html><html>' + ' '.repeat(13 * 1024 * 1024) + '</html>';
  const result = await readUpload(request(html));
  assert.equal(result.error, undefined); assert.equal(result.upload?.fileSize, Buffer.byteLength(html));
  assert.equal(result.upload?.sha256, createHash('sha256').update(html).digest('hex'));
  const oversized = await readUpload(request('<!doctype html>' + ' '.repeat(limits.TOP_DASHBOARD_HTML_MAX_BYTES)));
  assert.equal(oversized.error?.status, 413);
});
test('TOP rejects oversized chunked multipart before parsing without trusted Content-Length', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(limits.TOP_DASHBOARD_HTML_MAX_BYTES + 1024 * 1024)); },
    cancel() { cancelled = true; return new Promise<void>(() => {}); },
  });
  const result = await readUpload(new Request('https://kts.test/upload', { method: 'POST', body: stream, duplex: 'half', headers: { 'content-type': 'multipart/form-data; boundary=synthetic', 'content-length': '0' } } as RequestInit));
  assert.equal(result.error?.status, 413); assert.equal(cancelled, true); assert.equal(stream.locked, false);
});
test('TOP still rejects wrong format, missing HTML and null bytes', async () => {
  for (const [html, name] of [['<!doctype html>', 'report.txt'], ['only text', 'report.html'], ['<!doctype html>\0', 'report.html'], ['', 'report.html']]) {
    const result = await readUpload(request(html, name)); assert.equal(result.error?.status, 400);
  }
});

test('unreviewed invoice HTML is rejected instead of falling through to shared file capture', async () => {
  const candidate = '<!doctype html><html><head><title>Рентабельность счетов</title></head><body><input id="fInv" type="file"><script>const kind="kts-rent-snapshot";</script></body></html>';
  assert.equal(profitability.isProfitabilityHtmlCandidate(candidate), true);
  const result = await readUpload(request(candidate));
  assert.equal(result.error?.status, 400);
  assert.match(await result.error!.text(), /ещё не подключён журнал детализации/);
});

test('optional real V19 passes HTML upload without copying business data into the repository', { skip: !process.env.KTS_PROFITABILITY_HTML_FIXTURE }, async () => {
  const html = readFileSync(process.env.KTS_PROFITABILITY_HTML_FIXTURE!, 'utf8');
  const result = await readUpload(request(html));
  assert.equal(result.error, undefined);
  assert.equal(result.upload?.fileSize, Buffer.byteLength(html));
});
