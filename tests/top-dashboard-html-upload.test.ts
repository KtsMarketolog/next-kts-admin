import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as limits from '../src/shared/lib/topDashboardLimits';
import * as standalone from '../src/shared/lib/topDashboardStandalone';
import { detectTopDashboardDataContract } from '../src/shared/lib/topDashboardContentSecurity';

const code = ts.transpileModule(readFileSync('src/app/api/admin/top-dashboard/blocks/routeUtils.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports: { readTopDashboardHtmlUpload?: (request: Request) => Promise<{ upload?: { htmlContent: string; fileSize: number; sha256: string }; error?: Response }> } = {};
runInNewContext(code, { exports, Buffer, File, Response, TextDecoder, setTimeout, clearTimeout,
  require: (name: string) => name === 'crypto' ? { createHash } : name === '@/shared/lib/topDashboardLimits' ? limits
    : name === '@/shared/lib/topDashboardStandalone' ? standalone : assert.fail(name) });
const readUpload = exports.readTopDashboardHtmlUpload!;
function request(bytes: string, name = 'report.html', modes: string[] = []) {
  const form = new FormData(); form.append('file', new File([bytes], name, { type: 'text/html' }));
  for (const mode of modes) form.append('integrationMode', mode);
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

test('unreviewed invoice HTML uploads unchanged but cannot fall through to shared file capture', async () => {
  const candidate = '<!doctype html><html><head><title>Рентабельность счетов</title></head><body><input id="fInv" type="file"><script>const kind="kts-rent-snapshot";</script></body></html>';
  const result = await readUpload(request(candidate));
  assert.equal(result.error, undefined);
  assert.equal(result.upload?.htmlContent, candidate);
  assert.equal(detectTopDashboardDataContract(result.upload!.htmlContent).profile, 'standalone');
  assert.equal(detectTopDashboardDataContract(result.upload!.htmlContent).snapshotFormat, null);
});

test('explicit standalone mode persists metadata, hashes stored bytes and preserves connected default', async () => {
  const source = '<!doctype html><html><head><title>Report</title></head><body><input type="file"><script>const version=999;</script></body></html>';
  for (const modes of [[], ['connected']]) {
    const result = await readUpload(request(source, 'report.html', modes));
    assert.equal(result.error, undefined);
    assert.equal(result.upload?.htmlContent, source);
    assert.equal(detectTopDashboardDataContract(result.upload!.htmlContent).profile, 'generic');
  }
  const result = await readUpload(request(source, 'report.html', ['standalone']));
  assert.equal(result.error, undefined);
  const saved = result.upload!;
  assert.equal(saved.htmlContent.replace(standalone.TOP_DASHBOARD_STANDALONE_MARKER, ''), source);
  assert.equal(saved.fileSize, Buffer.byteLength(saved.htmlContent));
  assert.equal(saved.sha256, createHash('sha256').update(saved.htmlContent).digest('hex'));
  assert.equal(detectTopDashboardDataContract(saved.htmlContent).profile, 'standalone');
  assert.equal(detectTopDashboardDataContract(saved.htmlContent).snapshotFormat, null);
});

test('standalone upload validates mode and cap after metadata insertion; malformed UTF-8 remains rejected', async () => {
  for (const modes of [['other'], ['standalone', 'connected'], ['']]) {
    assert.equal((await readUpload(request('<!doctype html>', 'report.html', modes))).error?.status, 400);
  }
  const prefix = '<!doctype html><html><head></head></html>';
  const source = prefix + ' '.repeat(limits.TOP_DASHBOARD_HTML_MAX_BYTES - Buffer.byteLength(prefix));
  assert.equal((await readUpload(request(source, 'report.html', ['standalone']))).error?.status, 413);
  const form = new FormData();
  form.append('file', new File([new Uint8Array([0xff, 0xff])], 'broken.html'));
  assert.equal((await readUpload(new Request('https://kts.test/upload', {method:'POST', body:form}))).error?.status, 400);
});

test('optional real V19 passes HTML upload without copying business data into the repository', { skip: !process.env.KTS_PROFITABILITY_HTML_FIXTURE }, async () => {
  const html = readFileSync(process.env.KTS_PROFITABILITY_HTML_FIXTURE!, 'utf8');
  const result = await readUpload(request(html));
  assert.equal(result.error, undefined);
  assert.equal(result.upload?.fileSize, Buffer.byteLength(html));
});
