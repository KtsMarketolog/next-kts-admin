import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSupportSharedRoutePlannerFrame, detectSupportSharedHtmlFormat, injectSupportSharedRoutePlannerAdapter, supportSharedRoutePlannerCsp } from '../src/shared/lib/supportSharedRoutePlannerHtml';

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
  assert.match(result.html, /size > 104857600/);
  assert.match(result.html, /'sandbox','allow-same-origin allow-modals'/);
  assert.match(result.html, /script-src 'none'/);
  assert.match(result.html, /navigator\.userActivation\.isActive/);
  assert.doesNotThrow(() => new Function(result.html.match(/<script>([\s\S]*?)<\/script>/)![1]));
  assert.match(result.csp, /connect-src 'self'/);
});

test('Unicode in bundled libraries does not shift the closing-body insertion offset', () => {
  const html = fixture.replace('const S={}', 'const special="İ"; const S={}');
  const adapted = injectSupportSharedRoutePlannerAdapter(html);
  assert.match(adapted, /<script data-kts-shared-route-planner="1">[\s\S]*<\/script><\/body><\/html>$/);
  assert.doesNotMatch(adapted, /<\/b<script/);
  assert.equal([...adapted.matchAll(/<script\b/g)].length, 3);
});
