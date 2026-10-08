import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { injectSalesOfficeView, supportsSalesOfficeView } from '../src/shared/lib/dashboardOfficeView';
import { buildTopDashboardContentSecurityPolicy } from '../src/shared/lib/topDashboardContentSecurity';

const html = '<!doctype html><html><head><title>Продажи</title></head><body><div id="tvbox" hidden></div><script>function openTv(){} function renderTv(){}</script>Экран для офиса</body></html>';

test('office adapter requires the known in-page office capability', () => {
  assert.equal(supportsSalesOfficeView(html),true);
  assert.equal(supportsSalesOfficeView(html.replace('openTv','openTvWindow')),false);
  assert.equal(supportsSalesOfficeView(html.replace('tvbox','other')),false);
  assert.equal(supportsSalesOfficeView('<h1>Экран для офиса</h1>'),false);
});

test('office subview is isolated, waits for restored data, never opens a new window and stays within CSP', () => {
  const result = injectSalesOfficeView(html);
  assert.ok(result.indexOf('data-kts-office-view') < result.indexOf('<title>'));
  assert.match(result,/kts-top-dashboard-data-ready/);
  assert.match(result,/window\.openTv\(\)/);
  assert.doesNotMatch(result,/window\.open\(/);
  assert.match(result,/body > :not\(#tvbox\):not\(#kts-office-notice\)/);
  assert.match(buildTopDashboardContentSecurityPolicy(result),/sandbox allow-scripts allow-popups/);
  assert.match(buildTopDashboardContentSecurityPolicy(result),/sha256-/);
});

test('pair office frame keeps normal report ACL and forces read-only data adapters', () => {
  for (const file of ['frame','content']) {
    const source=readFileSync(`src/app/api/admin/top-dashboard/blocks/[blockId]/versions/[versionId]/${file}/route.ts`,'utf8');
    assert.match(source,/canReadTopDashboardBlock\(session, blockId\)/);
    assert.match(source,/searchParams\.get\('view'\) === 'sales-office'/);
    assert.match(source,file==='frame' ? /isTopDashboardManagementSession\(session\) && !officeView/ : /readOnly: officeView \|\| !isTopDashboardManagementSession\(session\)/);
  }
});
