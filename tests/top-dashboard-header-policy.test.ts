import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCustomRoute } from 'next/dist/server/lib/router-utils/filesystem';
import nextConfig from '../next.config';
import { GLOBAL_CSP_SOURCE } from '../src/shared/lib/topDashboardHeaderPolicy';

// Use Next's own source matcher, not a similar but independently parsed regexp.
const matchesGlobal = buildCustomRoute('header', { source: GLOBAL_CSP_SOURCE }).match;
const reportPath = '/api/admin/top-dashboard/blocks/10/versions/83';

test('only canonical TOP frame/content paths delegate CSP to the authenticated route', () => {
  for (const kind of ['frame', 'content']) {
    for (const trailing of ['', '/']) {
      assert.equal(matchesGlobal(`${reportPath}/${kind}${trailing}`), false);
      assert.equal(matchesGlobal(`/api/admin/top-dashboard/blocks/1/versions/999999/${kind}${trailing}`), false);
    }
  }
});

test('ordinary pages, APIs and lookalike URLs retain the global CSP', () => {
  for (const pathname of [
    '/', '/admin/top/10', '/login', '/api/admin/login', '/api/admin/clients',
    '/api/admin/top-dashboard/blocks/10/data', `${reportPath}/download`,
    `${reportPath}/content/extra`, `${reportPath}/frame/extra`, `${reportPath}/content.json`,
    `${reportPath}/contentx`, `${reportPath}/framex`, `${reportPath}/content//`,
    '/prefix' + reportPath + '/content', `${reportPath}/content%2F`,
    '/api/admin/top-dashboard/blocks/0/versions/83/content',
    '/api/admin/top-dashboard/blocks/01/versions/83/content',
    '/api/admin/top-dashboard/blocks/-1/versions/83/content',
    '/api/admin/top-dashboard/blocks/1/versions/0/content',
    '/api/admin/top-dashboard/blocks/1/versions/08/content',
    '/api/admin/top-dashboard/blocks/x/versions/83/content',
    '/api/admin/top-dashboard/blocks/1/versions/x/content',
    '/api/admin/manager-dashboard/shared/content',
    '/admin/knowledge-base', '/api/admin/knowledge-base/files',
    '/api/admin/knowledge-base/files/7/extra', '/api/admin/knowledge-base/files/7.json',
    '/api/admin/knowledge-base/files/0', '/api/admin/knowledge-base/files/07',
    '/api/admin/knowledge-base/files/-7', '/api/admin/knowledge-base/files/x',
  ]) assert.notEqual(matchesGlobal(pathname), false, pathname);
});

test('canonical knowledge-base file paths retain their exact preview or attachment CSP', () => {
  for (const id of ['1', '7', '999999']) {
    for (const trailing of ['', '/']) assert.equal(matchesGlobal(`/api/admin/knowledge-base/files/${id}${trailing}`), false);
  }
});

test('Next configuration preserves common protection everywhere and does not widen global script permissions', async () => {
  const rules = await nextConfig.headers!();
  const resolved = (pathname: string) => {
    const result = new Map<string, string>();
    for (const rule of rules) {
      if (buildCustomRoute('header', rule).match(pathname) === false) continue;
      for (const { key, value } of rule.headers) result.set(key.toLowerCase(), value);
    }
    return result;
  };
  const normal = resolved('/admin/top/10');
  const globalCsp = normal.get('content-security-policy');
  assert.ok(globalCsp);
  const scriptSrc = globalCsp.split('; ').find(directive => directive.startsWith('script-src '));
  assert.equal(scriptSrc, "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://crm.kts-impex.ru");
  assert.equal(resolved('/api/admin/clients').get('content-security-policy'), globalCsp);
  for (const pathname of [`${reportPath}/frame`, `${reportPath}/content`, `${reportPath}/content/`, '/api/admin/knowledge-base/files/7', '/api/admin/knowledge-base/files/7/']) {
    const headers = resolved(pathname);
    assert.equal(headers.has('content-security-policy'), false);
    for (const key of ['strict-transport-security', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy']) {
      assert.equal(headers.get(key), normal.get(key), `${pathname}: ${key}`);
    }
    assert.equal(headers.get('x-content-type-options'), 'nosniff', 'JSON error responses are never treated as executable HTML');
  }
});
