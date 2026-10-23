import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { prepareInteractiveDashboardHtml } from '../src/shared/lib/topDashboardContentSecurity/preparedHtml';

function html(id: string) {
  return `<!doctype html><html><body><div id="target"></div><script>
function hit(value){window.selected=value}
const year=${JSON.stringify(id)};
document.getElementById('target').innerHTML=\`<button onclick="hit('\${year}')">Year</button>\`;
</script></body></html>`;
}

test('derived HTML is cached by the full source, without modifying its original', () => {
  const original = html('2042');
  const prepared = prepareInteractiveDashboardHtml(original);
  assert.notEqual(prepared, original);
  assert.equal(prepareInteractiveDashboardHtml(original), prepared);
  assert.equal(original, html('2042'));
  assert.notEqual(prepareInteractiveDashboardHtml(html('2043')), prepared);
  assert.equal(prepareInteractiveDashboardHtml('<h1>Static report</h1>'), '<h1>Static report</h1>');
});

test('derived HTML cache evicts old entries and expires without caching authorization', t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const original = html('cache-test');
  const first = prepareInteractiveDashboardHtml(original);
  for (let index = 0; index < 9; index++) prepareInteractiveDashboardHtml(html(`eviction-${index}`));
  const second = prepareInteractiveDashboardHtml(original);
  assert.notEqual(second, first, 'new opaque runtime after bounded entry eviction');
  assert.equal(prepareInteractiveDashboardHtml(original), second);
  now += 5 * 60 * 1000 + 1;
  assert.notEqual(prepareInteractiveDashboardHtml(original), second);
});

test('preview routes prepare only authorized response bytes; original KB download stays untouched', () => {
  const top = readFileSync(new URL('../src/app/api/admin/top-dashboard/blocks/[blockId]/versions/[versionId]/content/route.ts', import.meta.url), 'utf8');
  assert.ok(top.indexOf('canReadTopDashboardBlock(session, blockId)') < top.indexOf('prepareInteractiveDashboardHtml(viewHtml)'));
  assert.ok(top.includes('buildTopDashboardContentSecurityPolicy(htmlContent,'));
  const kb = readFileSync(new URL('../src/app/api/admin/knowledge-base/files/[id]/route.ts', import.meta.url), 'utf8');
  assert.ok(kb.indexOf('getKnowledgeBaseFileForRead(session, id)') < kb.indexOf('prepareInteractiveDashboardHtml(original)'));
  assert.ok(kb.includes("if (inline && type.mimeType === 'text/html')"));
  assert.ok(kb.includes("headers.set('Content-Length', String(html.length))"));
  assert.ok(kb.includes('knowledgeBaseHtmlPolicy(prepared)'));
  assert.ok(kb.includes('knowledgeBaseFileStream(file)'));
  assert.doesNotMatch(top + kb, /writeFile|activateVersion|UPDATE\s|INSERT\s|DELETE\s/);
});
