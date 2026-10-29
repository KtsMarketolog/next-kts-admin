import assert from 'node:assert/strict';
import { Script, runInNewContext } from 'node:vm';
import test from 'node:test';
import { personalDashboardFramePrintScript, personalDashboardPrintAdapterScript } from '../src/shared/lib/managerDashboardPrint';
import { buildPersonalDashboardFrame, buildPersonalDashboardOwnFrame, buildPersonalDashboardReviewFrame, buildSupportSharedDashboardFrame, personalHtmlCsp } from '../src/shared/lib/managerDashboardHtml';
import { TOP_DASHBOARD_PRINT_MAX_CHARS } from '../src/shared/lib/topDashboardContentSecurity/printProtocol';

test('personal print scripts compile and reuse a source-checked inert sanitizer without relaxing author sandbox', () => {
  new Script(personalDashboardPrintAdapterScript());
  new Script(personalDashboardFramePrintScript());
  const receiver = personalDashboardFramePrintScript();
  assert.match(receiver, /event\.source !== iframe\.contentWindow/);
  assert.match(receiver, /event\.origin !== 'null'/);
  assert.match(receiver, /navigator\.userActivation\?\.isActive/);
  assert.match(receiver, /sandbox', 'allow-same-origin allow-modals'/);
  assert.match(receiver, /script-src 'none'/);
  assert.match(receiver, /connect-src 'none'/);
  assert.doesNotMatch(receiver, /allow-scripts|fetch\(|XMLHttpRequest/);
  assert.match(personalHtmlCsp('<html></html>'), /(?:^|; )sandbox allow-scripts(?:;|$)/);
  assert.doesNotMatch(personalHtmlCsp('<html></html>'), /allow-same-origin|allow-popups|allow-modals/);
});

test('all personal wrapper modes install printing and a visible status while content stays opaque', () => {
  const frames = [
    buildPersonalDashboardFrame({ versionId: 1, preview: false, audience: 'development' }),
    buildPersonalDashboardFrame({ versionId: 1, preview: false, audience: 'support' }),
    buildPersonalDashboardFrame({ versionId: 1, preview: true }),
    buildPersonalDashboardOwnFrame({ versionId: 1 }),
    buildPersonalDashboardReviewFrame({ versionId: 1, managerId: 7 }),
    buildSupportSharedDashboardFrame({ versionId: 1, preview: false }),
  ];
  for (const frame of frames) {
    assert.match(frame.html, /id="print-notice" role="alert" hidden/);
    assert.match(frame.html, /id="personal"[^>]*sandbox="allow-scripts"/);
    assert.match(frame.html, /const PRINT_MARKER = 'kts-top-dashboard-print-v1'/);
    assert.match(frame.csp, /script-src 'sha256-/);
    assert.doesNotMatch(frame.csp, /script-src 'unsafe-inline'|unsafe-eval/);
  }
});

function popupHarness() {
  const messages: Record<string, unknown>[] = [];
  const forwarded: unknown[][] = [];
  const listeners = new Map<string, (event: { source?: unknown; data?: Record<string, unknown> }) => void>();
  const navigator = { userActivation: { isActive: true } };
  const parent = { postMessage: (message: Record<string, unknown>) => messages.push(message) };
  const window = {
    parent, open: (...args: unknown[]) => { forwarded.push(args); return null; },
    addEventListener: (type: string, listener: (event: { source?: unknown; data?: Record<string, unknown> }) => void) => listeners.set(type, listener),
    setTimeout: () => 1,
  };
  runInNewContext(personalDashboardPrintAdapterScript(), { window, navigator, crypto: { randomUUID: () => 'synthetic-id' }, clearTimeout() {}, document: {} });
  type Virtual = { document: { write(...parts: unknown[]): void; writeln(...parts: unknown[]): void; close(): void; open(): void }; closed: boolean; close(): void };
  const open = (...args: unknown[]) => window.open(...args) as unknown as Virtual | null;
  return { open, messages, forwarded, navigator, listeners, parent };
}

test('virtual print window never navigates, retains only one bounded card, and closes cleanly', () => {
  const h = popupHarness();
  const first = h.open('', '_blank')!;
  assert.equal(first.closed, false);
  first.document.write('one'); first.document.close();
  assert.equal(first.closed, false, 'document.close is not window.close');
  const second = h.open('about:blank', '_blank')!;
  assert.equal(first.closed, true, 'previous source markup is discarded');
  second.document.write('x'.repeat(TOP_DASHBOARD_PRINT_MAX_CHARS));
  second.document.write('x');
  assert.equal(second.closed, true);
  assert.equal(h.messages[0]?.type, 'print-error');
  assert.equal(h.forwarded.length, 0, 'blank printing never opens a real popup');
  const third = h.open('', '_blank')!;
  third.document.write('x'.repeat(TOP_DASHBOARD_PRINT_MAX_CHARS));
  third.document.writeln();
  assert.equal(third.closed, true, 'an argument-free newline must also obey the source limit');
  const fourth = h.open('', '_blank')!;
  h.listeners.get('pagehide')!({});
  assert.equal(fourth.closed, true);
});

test('virtual print creation needs user activation and does not replace navigation semantics', () => {
  const h = popupHarness();
  h.navigator.userActivation.isActive = false;
  assert.equal(h.open('', '_blank'), null);
  assert.equal(h.messages[0]?.type, 'print-error');
  assert.equal(h.open('https://outside.invalid/', '_blank'), null);
  assert.equal(h.open('', '_self'), null);
  assert.equal(h.forwarded.length, 2);
});
