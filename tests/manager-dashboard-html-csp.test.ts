import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { personalHtmlCsp } from '../src/shared/lib/managerDashboardHtml';

const hash = (source: string) => `'sha256-${createHash('sha256').update(source).digest('base64')}'`;

test('personal v12 CSP allows only the finite concrete generated navigation and dimension handlers', () => {
  const csp = personalHtmlCsp('<html><script>function render() {}</script></html>');
  const scripts = csp.split('; ').find((directive) => directive.startsWith('script-src '))!;
  const handlers = [
    ...['summary', 'yoy', 'clients', 'goods', 'kp', 'lost', 'disc'].map((tab) => `U.tab='${tab}';render()`),
    ...['tm', 'vid', 'grp', 'nom', 'cg'].map((dimension) => `U.goodsDim='${dimension}';render()`),
    ...['mk', 'partner', 'grp', 'vid', 'tm', 'cg'].map((dimension) => `U.kpDim='${dimension}';render()`),
    "U.years=[D.years[D.years.length-1]];U.qs=[];U.ms=[];Object.keys(U.gf).forEach(k=>U.gf[k]=[]);U.s='';render()",
    'GOODS_KEYS.forEach(k=>U.gf[k]=[]);render()',
  ];
  for (const handler of handlers) assert.ok(scripts.includes(hash(handler)), handler);
  for (const handler of ["U.tab='unrecognized';render()", "U.goodsDim='email';render()", "fetch('/api/private')", 'alert(document.cookie)']) {
    assert.equal(scripts.includes(hash(handler)), false, handler);
  }
  assert.doesNotMatch(scripts, /'unsafe-inline'|'unsafe-eval'|'self'|https?:/);
  assert.match(scripts, /'unsafe-hashes'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /(?:^|; )sandbox allow-scripts(?:;|$)/);
  assert.doesNotMatch(csp, /allow-same-origin|allow-popups/);
});
