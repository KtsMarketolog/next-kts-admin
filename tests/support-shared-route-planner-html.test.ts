import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSupportSharedRoutePlannerFrame, detectSupportSharedHtmlFormat, injectSupportSharedRoutePlannerAdapter, supportSharedRoutePlannerCsp } from '../src/shared/lib/supportSharedRoutePlannerHtml';
import { readTopDashboardDownloadMessage, TOP_DASHBOARD_DOWNLOAD_MESSAGE_MARKER } from '../src/shared/lib/topDashboardDownloadBridge';
import { SUPPORT_SHARED_JSON_MAX_BYTES } from '../src/shared/lib/supportSharedRoutePlannerLimits';

const fixture = '<html><head></head><body><input id="snapIn" type="file"><script>const S={}; function revive(x){return x;} function loadSnapshot(j){S.orders = revive(j.orders);} function handleFiles(list){} const snapshot={app:"компоновщик"};window.UI = {};</script></body></html>';
test('shared format detector accepts the specific planner contract, not generic HTML or partial marker', () => {
  assert.equal(detectSupportSharedHtmlFormat(fixture), 'route-planner-v1');
  assert.equal(detectSupportSharedHtmlFormat('<html><body>компоновщик</body></html>'), null);
  assert.equal(detectSupportSharedHtmlFormat(fixture.replace('loadSnapshot', 'wrong')), null);
  assert.equal(detectSupportSharedHtmlFormat(fixture.replace('snapIn', 'file')), null);
  assert.throws(() => injectSupportSharedRoutePlannerAdapter('<html></html>'));
});
test('planner adapter leaves calculations intact and injects parse/load and guarded export/print bridges', () => {
  const adapted = injectSupportSharedRoutePlannerAdapter(fixture);
  assert.ok(adapted.includes('function loadSnapshot(j){S.orders = revive(j.orders);}'));
  for (const script of adapted.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) assert.doesNotThrow(() => new Function(script[1]));
  assert.match(adapted, /delete window\.__ktsLoadSharedSnapshot/);
  assert.match(adapted, /event\.source !== window\.parent/);
  assert.match(adapted, /snapshot.*blob instanceof Blob/);
  assert.match(adapted, /type:'print'/);
  assert.match(supportSharedRoutePlannerCsp(adapted), /frame-src 'none'/);
});
test('trusted wrapper pins data IDs, bounds downloads and never gives inner report cabinet origin', () => {
  const result = buildSupportSharedRoutePlannerFrame({versionId: 7, snapshotId: 9, preview: false});
  assert.match(result.html, /shared\/json\?version=7&snapshot=9/);
  assert.match(result.html, /sandbox="allow-scripts"/);
  assert.match(result.html, /event\.origin !== 'null'/);
  assert.match(result.html, /size > 524288000/);
  assert.match(result.html, /pipeThrough\(bounded/);
  assert.doesNotMatch(result.html.slice(result.html.indexOf('else fetch(')), /chunks\.push/);
  assert.match(result.html, /'sandbox','allow-same-origin allow-modals'/);
  assert.match(result.html, /script-src 'none'/);
  assert.match(result.html, /navigator\.userActivation\.isActive/);
  assert.doesNotThrow(() => new Function(result.html.match(/<script>([\s\S]*?)<\/script>/)![1]));
  assert.match(result.csp, /connect-src 'self'/);
});

test('500 MiB exports are scoped to the planner, not all TOP reports', () => {
  const blob = new Blob(['synthetic']);
  Object.defineProperty(blob, 'size', {value: SUPPORT_SHARED_JSON_MAX_BYTES, configurable: true});
  const message = {marker: TOP_DASHBOARD_DOWNLOAD_MESSAGE_MARKER, type:'download-request', name:'snapshot.json', blob};
  assert.equal(readTopDashboardDownloadMessage(message), null);
  assert.ok(readTopDashboardDownloadMessage(message, SUPPORT_SHARED_JSON_MAX_BYTES));
  for (const limit of [0, -1, NaN, Infinity]) assert.equal(readTopDashboardDownloadMessage(message, limit), null);
  Object.defineProperty(blob, 'size', {value: SUPPORT_SHARED_JSON_MAX_BYTES + 1});
  assert.equal(readTopDashboardDownloadMessage(message, SUPPORT_SHARED_JSON_MAX_BYTES), null);
  assert.match(injectSupportSharedRoutePlannerAdapter(fixture), /const DOWNLOAD_MAX_BYTES = 524288000;/);
});

test('administrator preview loads its pinned shared JSON via the explicit preview endpoint', () => {
  const result = buildSupportSharedRoutePlannerFrame({versionId: 7, snapshotId: 9, preview: true});
  assert.match(result.html, /shared\/json\?version=7&snapshot=9&preview=1/);
  assert.match(result.html, /shared\/content\?version=7&amp;preview=1/);
  assert.match(result.html, /hasSnapshot = true/);
  assert.doesNotMatch(result.html, /if \(preview\)/);
  assert.doesNotMatch(result.html, /preview \|\| !sent/);
  assert.match(result.html, /sandbox="allow-scripts"/);
  assert.doesNotThrow(() => new Function(result.html.match(/<script>([\s\S]*?)<\/script>/)![1]));
});

test('preview without a bound JSON explains the missing data and does not start the fetch', () => {
  const result = buildSupportSharedRoutePlannerFrame({versionId: 8, preview: true});
  assert.match(result.html, /hasSnapshot = false/);
  assert.match(result.html, /if \(!hasSnapshot\) status\.textContent = 'Для этой версии HTML общий JSON ещё не опубликован\.';\s+else fetch\(/);
  assert.doesNotMatch(result.html, /без данных менеджеров|snapshot=/);
});

test('Unicode in bundled libraries does not shift the closing-body insertion offset', () => {
  const html = fixture.replace('const S={}', 'const special="İ"; const S={}');
  const adapted = injectSupportSharedRoutePlannerAdapter(html);
  assert.match(adapted, /<script data-kts-shared-route-planner="1">[\s\S]*<\/script><\/body><\/html>$/);
  assert.doesNotMatch(adapted, /<\/b<script/);
  assert.equal([...adapted.matchAll(/<script\b/g)].length, 3);
});
