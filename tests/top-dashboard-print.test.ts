import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { framePrintScript } from '../src/shared/lib/topDashboardContentSecurity/frame/print';
import { sandboxPrintScript } from '../src/shared/lib/topDashboardContentSecurity/sandbox/print';
import { buildTopDashboardContentSecurityPolicy, buildTopDashboardFrameSecurityPolicy } from '../src/shared/lib/topDashboardContentSecurity/policy';

test('both generated print bridge fragments compile without changing author sandbox permissions', () => {
  assert.doesNotThrow(() => new Script(sandboxPrintScript()));
  assert.doesNotThrow(() => new Script(framePrintScript()));
  const authorPolicy = buildTopDashboardContentSecurityPolicy('<script>window.print()</script>', { allowBlobModules: true });
  assert.match(authorPolicy, /sandbox allow-scripts allow-popups$/);
  assert.doesNotMatch(authorPolicy, /allow-modals|allow-same-origin|allow-popups-to-escape-sandbox/);
  assert.match(authorPolicy, /connect-src 'none'/);
  const trustedPolicy = buildTopDashboardFrameSecurityPolicy(framePrintScript());
  assert.match(trustedPolicy, /script-src 'sha256-/);
  assert.doesNotMatch(trustedPolicy, /unsafe-eval|script-src 'unsafe-inline'/);
});

test('print document is inert, bounded, sender-checked and never persisted', () => {
  const script = framePrintScript();
  assert.match(script, /event\.source !== iframe\.contentWindow/);
  assert.match(script, /event\.origin !== 'null'/);
  assert.match(script, /navigator\.userActivation\?\.isActive/);
  assert.match(script, /createElement\('template'\)/);
  assert.match(script, /nodes\.length > 50000/);
  assert.match(script, /sandbox', 'allow-same-origin allow-modals'/);
  assert.match(script, /script-src 'none'/);
  assert.match(script, /connect-src 'none'/);
  assert.match(script, /css\.replace\(/);
  assert.doesNotMatch(script, /fetch\(|XMLHttpRequest|localStorage|sessionStorage|allow-scripts/);
  assert.match(sandboxPrintScript(), /querySelectorAll\('script,iframe,object,embed,link,base,meta'\)/);
  assert.match(sandboxPrintScript(), /\['password', 'file', 'hidden'\]\.includes\(original\.type\) \? ''/);
});

test('all TOP embedding modes permit the trusted print child without widening author privileges', () => {
  for (const file of [
    'top-dashboard/TopDashboardViewer.tsx',
    'top-dashboard/TopDashboardManagementPreview.tsx',
    'dashboard-pair/DashboardPair.tsx',
  ]) {
    const source = readFileSync(new URL('../src/features/admin/' + file, import.meta.url), 'utf8');
    assert.match(source, /sandbox="allow-scripts allow-same-origin allow-popups allow-modals"/);
    assert.doesNotMatch(source, /allow-popups-to-escape-sandbox/);
  }
});
