import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { normalizeSessionRole } from '../src/app/admin/adminSessionClient';
import {
  USER_TABS,
  defaultRoleForTab,
  roleOptionsForTab,
  tabForRole,
} from '../src/features/admin/users/AdminUsersConfig';
import { isOperationalEmployeeSessionRole } from '../src/shared/lib/adminAuth';
import {
  buildTopDashboardContentSecurityPolicy,
  isTopDashboardFrameRequest,
} from '../src/shared/lib/topDashboardContentSecurity';

function cspHash(source: string) {
  return `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`;
}

test('top role is preserved client-side and unknown roles fail closed', () => {
  assert.equal(normalizeSessionRole('top'), 'top');
  assert.equal(normalizeSessionRole('admin'), 'admin');
  assert.equal(normalizeSessionRole('manager'), 'manager');
  assert.equal(normalizeSessionRole('unexpected' as never), null);
});

test('top is excluded from operational employee permissions', () => {
  assert.equal(isOperationalEmployeeSessionRole('admin'), true);
  assert.equal(isOperationalEmployeeSessionRole('wholesale_admin'), true);
  assert.equal(isOperationalEmployeeSessionRole('manager'), true);
  assert.equal(isOperationalEmployeeSessionRole('support_manager'), true);
  assert.equal(isOperationalEmployeeSessionRole('top'), false);
  assert.equal(isOperationalEmployeeSessionRole(null), false);
});

test('admin users screen exposes a separate single-role TOP tab', () => {
  assert.deepEqual(USER_TABS.map((tab) => tab.value), ['admin', 'top']);
  assert.equal(tabForRole('top'), 'top');
  assert.equal(defaultRoleForTab('top'), 'top');
  assert.deepEqual(roleOptionsForTab('top'), [{ value: 'top', label: 'TOP' }]);
});

test('dashboard CSP permits only exact uploaded scripts and handlers', () => {
  const script = "document.body.dataset.ready = 'yes';";
  const handler = "document.querySelector('#file').click()";
  const html = `<!doctype html><script>${script}</script><button onclick="${handler}">Открыть</button>`;
  const csp = buildTopDashboardContentSecurityPolicy(html);

  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /sandbox allow-scripts/);
  assert.match(csp, /'unsafe-hashes'/);
  assert.ok(csp.includes(cspHash(script)));
  assert.ok(csp.includes(cspHash(handler)));
  const scriptDirective = csp.split(';').find((directive) => directive.trim().startsWith('script-src')) ?? '';
  assert.doesNotMatch(scriptDirective, /'unsafe-inline'/);
  assert.doesNotMatch(scriptDirective, /'unsafe-eval'/);
});

test('dashboard content is accepted only from its same-origin frame shell', () => {
  const versionId = 42;
  const request = new Request(`https://kts-impex.ru/api/admin/top-dashboard/versions/${versionId}/content`, {
    headers: {
      'sec-fetch-dest': 'iframe',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
      referer: `https://kts-impex.ru/api/admin/top-dashboard/versions/${versionId}/frame?revision=1`,
    },
  });
  assert.equal(isTopDashboardFrameRequest(request, versionId), true);

  const directNavigation = new Request(request.url, {
    headers: {
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
    },
  });
  assert.equal(isTopDashboardFrameRequest(directNavigation, versionId), false);

  const wrongParent = new Request(request.url, {
    headers: {
      'sec-fetch-dest': 'iframe',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
      referer: 'https://kts-impex.ru/admin/top',
    },
  });
  assert.equal(isTopDashboardFrameRequest(wrongParent, versionId), false);
});
