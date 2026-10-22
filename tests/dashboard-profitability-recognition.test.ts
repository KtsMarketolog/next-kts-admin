import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as parse5 from 'parse5';
import * as sax from 'parse5-sax-parser';
import ts from 'typescript';
import * as inlineSources from '../src/shared/lib/topDashboardContentSecurity/inlineSources';
import { scanProfitabilityHtml, hasProfitabilityInvoiceInput } from '../src/shared/lib/dashboardProfitabilityRecognition';
import { declaresDashboardInvoiceAudit, isProfitabilityHtmlCandidate, isSupportedProfitabilityHtml, supportsDashboardInvoiceAudit } from '../src/shared/lib/dashboardProfitabilityHtml';

const optIn = '<meta name="kts-dashboard-audit" content="invoice-v1">';

test('recognition preserves original offsets, CRLF, surrogate pairs, NUL and raw script entities', () => {
  const source = '\r\nconst x="😀&quot;\u0000";\r\n';
  const prefix = '<!doctype html>\r\n<html data-note=">😀"><head><title>😀</title></head><body>';
  const html = prefix + '<script>' + source + '</script></body></html>';
  const spans: Array<{ start: number; contentStart: number; contentEnd: number; end: number }> = [];
  scanProfitabilityHtml(html, span => spans.push(span));
  assert.equal(spans.length, 1);
  assert.equal(spans[0].start, prefix.length);
  assert.equal(html.slice(spans[0].contentStart, spans[0].contentEnd), source);
  assert.equal(html.slice(spans[0].start, spans[0].end), '<script>' + source + '</script>');
});

test('comments, raw text, templates and incomplete scripts cannot become reviewed applications', () => {
  const spans: string[] = [];
  const real = '<!--<script>double escaped</script>still script-->last';
  const html = '<head></head><body><!--<script>comment</script>--><textarea><script>text</script></textarea>'
    + '<template><script>inert</script></template><script>' + real + '</script><script>unfinished';
  scanProfitabilityHtml(html, span => spans.push(html.slice(span.contentStart, span.contentEnd)));
  assert.deepEqual(spans, [real]);
});

test('original script spans remain exact after tokenizer buffer drops and quoted large attributes', () => {
  const prefix = '<head></head><body><!--' + '😀\r\n'.repeat(30_000) + '--><div data-note="' + '>'.repeat(80_000) + '"></div>';
  const application = '<script>\r\nwindow.example="😀";\r\n</script>';
  let found = '';
  scanProfitabilityHtml(prefix + application + '</body>', span => {
    assert.equal(span.start, prefix.length);
    found = (prefix + application).slice(span.start, span.end);
  });
  assert.equal(found, application);
});

test('explicit audit head parsing is quote-aware and ignores inert markup without losing following meta', () => {
  const html = '<!-- prefix --><!doctype html><html title="a > b"><head data-note="<head>">'
    + '<template><svg/><math/></template>' + optIn + '</head><body></body></html>';
  assert.equal(declaresDashboardInvoiceAudit(html), true);
  assert.equal(declaresDashboardInvoiceAudit(html.replace(optIn, '<!-- ' + optIn + ' -->')), false);
  assert.equal(declaresDashboardInvoiceAudit(html.replace(optIn, '<textarea>' + optIn + '</textarea>')), false);
  assert.equal(declaresDashboardInvoiceAudit('<head data-note="unterminated ' + optIn), false);
  const encodedMarker = '<head><meta name="kts&#45;dashboard&#45;audit" content="invoice-v1"></head>';
  assert.equal(declaresDashboardInvoiceAudit(encodedMarker), false);
  assert.equal(supportsDashboardInvoiceAudit(encodedMarker), false, 'Preserve the existing literal author marker requirement');
});

test('candidate recognition retains conservative privacy matching across malformed input tags', () => {
  const prefix = 'kts-rent-snapshot Рентабельность счетов ';
  assert.equal(isProfitabilityHtmlCandidate(prefix + '<input '.repeat(100_000) + 'id="fInv"'), true);
  assert.equal(hasProfitabilityInvoiceInput('<input id="different"><input id="fInv">'), true);
  assert.equal(hasProfitabilityInvoiceInput('<input '.repeat(100_000)), false);
  const invoiceAnchor = "S.log.push({ file: f.name, kind: inv.docType + ' · ' + r.kind, ok: true, id: inv.id, msg });";
  const snapshotAnchor = "S.log.push({ file: f.name, kind: 'снимок', ok: true, msg: 'счетов: ' + d.invs.length + ', сохранён ' + dtstr(new Date(d.saved)) });";
  assert.equal(isSupportedProfitabilityHtml('<script>' + invoiceAnchor + snapshotAnchor + '<script>'.repeat(131_072)), false);
});

test('legitimate nested templates do not acquire an unrelated fixed depth restriction', () => {
  const html = '<head>' + '<template>'.repeat(400) + 'example' + '</template>'.repeat(400) + optIn + '</head>';
  assert.equal(declaresDashboardInvoiceAudit(html), true);
});

test('monotonic deadline interrupts an unfinished token synchronously instead of declaring generic HTML', () => {
  const exports: Record<string, unknown> = {};
  const source = ts.transpileModule(readFileSync('src/shared/lib/dashboardProfitabilityRecognition.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let clockCalls = 0;
  vm.runInNewContext(source, { exports, require(name: string) {
    if (name === 'parse5') return parse5;
    if (name === 'parse5-sax-parser') return sax;
    if (name === './topDashboardContentSecurity/inlineSources') return inlineSources;
    assert.equal(name, 'node:perf_hooks');
    return { performance: { now: () => clockCalls++ === 0 ? 0 : 2_001 } };
  } });
  const scan = exports.scanProfitabilityHtml as typeof scanProfitabilityHtml;
  assert.throws(() => scan('<script>' + 'x'.repeat(64 * 1024), () => assert.fail('No completed application')), {
    name: 'ProfitabilityHtmlAnalysisLimitError',
    message: /HTML слишком сложен/,
  });
  assert.ok(clockCalls >= 2);
});

test('20 MiB ordinary embedded script, attribute and comment remain bounded and recognized without truncation', { timeout: 60_000 }, () => {
  const script = String.raw`
    import assert from 'node:assert/strict';
    import { scanProfitabilityHtml } from './src/shared/lib/dashboardProfitabilityRecognition.ts';
    const payload = 'x'.repeat(20 * 1024 * 1024);
    const meta = '<meta name="kts-dashboard-audit" content="invoice-v1">';
    for (const kind of ['script', 'attribute', 'comment']) {
      let seen = false;
      const body = kind === 'script' ? '<script>' + payload + '</script>'
        : kind === 'attribute' ? '<img src="data:image/png;base64,' + payload + '">'
        : '<!--' + payload + '-->';
      const html = '<html><head>' + meta + '</head><body>' + body + '</body></html>';
      const result = scanProfitabilityHtml(html, span => {
        assert.equal(html.slice(span.contentStart, span.contentEnd), payload);
        seen = true;
      });
      assert.equal(result.declaresInvoiceAudit, true);
      assert.equal(seen, kind === 'script');
      global.gc();
    }
  `;
  execFileSync(process.execPath, ['--max-old-space-size=256', '--expose-gc', '--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(), timeout: 55_000, maxBuffer: 64 * 1024, stdio: 'pipe',
  });
});
