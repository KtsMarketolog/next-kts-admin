import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { injectSalesOfficeView, supportsSalesOfficeView } from '../src/shared/lib/dashboardOfficeView';
import { buildTopDashboardContentSecurityPolicy } from '../src/shared/lib/topDashboardContentSecurity';

const html = '<!doctype html><html><head><title>Продажи</title></head><body><div id="tvbox" hidden></div><script>function openTv(){} function renderTv(){}</script>Экран для офиса</body></html>';

function officeHarness(options: { loading?: boolean; supported?: boolean } = {}) {
  type OfficeEvent = { detail?: { restoreId?: number } };
  type OpenResult = 'success' | 'missing-body' | 'hidden' | 'missing-box' | 'throws';
  const listeners = new Map<string, Array<(event: OfficeEvent) => void>>();
  const timers = new Map<number, { at: number; callback: () => void }>();
  let now = 0, timerId = 0, openCalls = 0, openResult: OpenResult = 'success';
  let notice: { id: string; hidden: boolean; textContent: string; setAttribute(): void } | undefined;
  let domReady: (() => void) | undefined;
  const box = { hidden: true, hasBody: false, querySelector: () => box.hasBody ? {} : null };
  const tvEsc = () => {};
  const removedListeners: unknown[][] = [];
  const window = {
    addEventListener(type: string, callback: (event: OfficeEvent) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), callback]);
    },
    openTv() {
      openCalls += 1;
      box.hidden = openResult === 'hidden';
      box.hasBody = openResult === 'success';
      if (openResult === 'throws') throw new Error('Synthetic render failure');
    },
    renderTv() {},
    tvEsc,
  };
  const document = {
    readyState: options.loading ? 'loading' : 'complete',
    body: { appendChild(element: NonNullable<typeof notice>) { notice = element; } },
    createElement: () => ({ id: '', hidden: false, textContent: '', setAttribute() {} }),
    getElementById: (id: string) => id === 'tvbox' && openResult !== 'missing-box' ? box : null,
    addEventListener(type: string, callback: () => void) { if (type === 'DOMContentLoaded') domReady = callback; },
    removeEventListener(...args: unknown[]) { removedListeners.push(args); },
  };
  const script = /<script data-kts-office-view>([\s\S]*?)<\/script>/.exec(injectSalesOfficeView(options.supported === false ? '<html><body></body></html>' : html))?.[1];
  assert.ok(script);
  runInNewContext(script, {
    window, document,
    setTimeout(callback: () => void, delay: number) { timers.set(++timerId, { at: now + delay, callback }); return timerId; },
    clearTimeout(id: number) { timers.delete(id); },
  });
  return {
    box, removedListeners, tvEsc,
    get notice() { assert.ok(notice); return notice; },
    get openCalls() { return openCalls; },
    get timerCount() { return timers.size; },
    setOpenResult(result: OpenResult) { openResult = result; },
    finishLoading() { document.readyState = 'complete'; domReady?.(); domReady = undefined; },
    dispatch(type: 'start' | 'ready' | 'error', restoreId?: number) {
      const name = type === 'start' ? 'kts-top-dashboard-restore-start' : `kts-top-dashboard-data-${type}`;
      for (const listener of listeners.get(name) ?? []) listener(restoreId === undefined ? {} : { detail: { restoreId } });
    },
    advance(milliseconds = 0) {
      const end = now + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = end;
    },
  };
}

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
  assert.match(result,/kts-top-dashboard-restore-start/);
  assert.match(result,/kts-top-dashboard-data-error/);
  assert.match(result,/window\.openTv\(\)/);
  assert.doesNotMatch(result,/window\.open\(/);
  assert.match(result,/body > :not\(#tvbox\):not\(#kts-office-notice\)/);
  assert.match(result,/#tvbox > \.tv-bar,#tvbox > \.tvbar\{display:none!important\}/);
  assert.match(buildTopDashboardContentSecurityPolicy(result),/sandbox allow-scripts allow-popups/);
  assert.match(buildTopDashboardContentSecurityPolicy(result),/sha256-/);
});

test('office waits for current restore and hides the previous screen during a refresh', () => {
  const view = officeHarness();
  assert.match(view.notice.textContent, /Загружаем/);
  assert.equal(view.openCalls, 0);
  view.dispatch('start', 1);
  view.dispatch('ready', 2);
  view.dispatch('ready');
  view.advance();
  assert.equal(view.openCalls, 0, 'unrelated and unscoped ready events must not open the office screen');
  view.dispatch('ready', 1);
  view.advance();
  assert.equal(view.openCalls, 1);
  assert.equal(view.notice.hidden, true);
  assert.equal(view.box.hidden, false);
  assert.ok(view.removedListeners.some(([type, callback]) => type === 'keydown' && callback === view.tvEsc));
  assert.equal(view.timerCount, 0);

  view.dispatch('start', 2);
  assert.equal(view.box.hidden, true);
  assert.equal(view.notice.hidden, false);
  assert.match(view.notice.textContent, /Загружаем/);
  view.dispatch('error', 1);
  view.dispatch('error');
  view.dispatch('ready', 1);
  view.advance();
  assert.equal(view.openCalls, 1);
  assert.match(view.notice.textContent, /Загружаем/);
  view.dispatch('ready', 2);
  view.advance();
  assert.equal(view.openCalls, 2);
  assert.equal(view.box.hidden, false);
});

test('a newer restore cancels an already queued office render', () => {
  const view = officeHarness();
  view.dispatch('start', 1);
  view.dispatch('ready', 1);
  view.dispatch('start', 2);
  view.advance();
  assert.equal(view.openCalls, 0);
  assert.equal(view.notice.hidden, false);
  view.dispatch('ready', 2);
  view.advance();
  assert.equal(view.openCalls, 1);
});

test('restore errors stop loading, hide stale content and allow a later restore', () => {
  const view = officeHarness();
  view.dispatch('start', 1);
  view.dispatch('ready', 1);
  view.advance();
  view.dispatch('start', 2);
  view.dispatch('error', 2);
  assert.equal(view.notice.hidden, false);
  assert.equal(view.box.hidden, true);
  assert.match(view.notice.textContent, /Не удалось загрузить данные/);
  assert.equal(view.timerCount, 0);
  view.advance(120000);
  assert.match(view.notice.textContent, /Не удалось загрузить данные/);
  view.dispatch('ready', 2);
  view.advance();
  assert.equal(view.openCalls, 1, 'a late ready event cannot reopen the failed restore');
  for (const restoreId of [undefined, 0, -1, 1.5, 1, 2]) {
    view.dispatch('start', restoreId);
    view.dispatch('ready', 2);
    view.advance();
    assert.equal(view.openCalls, 1);
    assert.match(view.notice.textContent, /Не удалось загрузить данные/);
    assert.equal(view.timerCount, 0);
  }
  view.dispatch('start', 3);
  assert.match(view.notice.textContent, /Загружаем/);
  view.dispatch('ready', 3);
  view.advance();
  assert.equal(view.notice.hidden, true);
  assert.equal(view.box.hidden, false);
});

test('restore events arriving before DOMContentLoaded keep their current state', () => {
  const ready = officeHarness({ loading: true });
  ready.dispatch('start', 1);
  assert.equal(ready.timerCount, 0, 'the initial wait starts once the notice exists');
  ready.dispatch('ready', 1);
  ready.advance();
  ready.finishLoading();
  assert.equal(ready.openCalls, 1);
  assert.equal(ready.notice.hidden, true);

  const queued = officeHarness({ loading: true });
  queued.dispatch('ready');
  queued.finishLoading();
  queued.advance();
  assert.equal(queued.openCalls, 1, 'DOMContentLoaded must not duplicate a queued ready render');

  const failed = officeHarness({ loading: true });
  failed.dispatch('start', 1);
  failed.dispatch('error', 1);
  failed.finishLoading();
  assert.equal(failed.openCalls, 0);
  assert.match(failed.notice.textContent, /Не удалось загрузить данные/);
  assert.equal(failed.timerCount, 0);
});

test('office displays an immediate render failure when ready data cannot produce the office screen', () => {
  for (const result of ['missing-body', 'hidden', 'missing-box', 'throws'] as const) {
    const view = officeHarness();
    view.setOpenResult(result);
    view.dispatch('ready');
    view.advance();
    assert.equal(view.openCalls, 1);
    assert.equal(view.notice.hidden, false);
    assert.match(view.notice.textContent, /Не удалось открыть/, result);
    if (result !== 'missing-box') assert.equal(view.box.hidden, true);
    assert.equal(view.timerCount, 0);
    view.advance(120000);
    assert.match(view.notice.textContent, /Не удалось открыть/, result);
  }
});

test('office timeout resets for a new restore and unsupported HTML fails immediately', () => {
  const view = officeHarness();
  view.advance(119999);
  view.dispatch('start', 1);
  view.advance(1);
  assert.match(view.notice.textContent, /Загружаем/);
  view.advance(119999);
  assert.match(view.notice.textContent, /Данные для экрана офиса не загружены/);
  assert.equal(view.box.hidden, true);
  assert.equal(view.timerCount, 0);
  view.dispatch('ready', 1);
  view.advance();
  assert.equal(view.openCalls, 0, 'a late ready event cannot reopen the timed out restore');
  assert.match(view.notice.textContent, /Данные для экрана офиса не загружены/);
  view.dispatch('start', 2);
  view.dispatch('ready', 2);
  view.advance();
  assert.equal(view.openCalls, 1);
  assert.equal(view.notice.hidden, true);

  const unsupported = officeHarness({ supported: false });
  assert.match(unsupported.notice.textContent, /не поддерживает/);
  assert.equal(unsupported.timerCount, 0);
  assert.equal(unsupported.openCalls, 0);
});

test('pair office frame keeps normal report ACL and forces read-only data adapters', () => {
  for (const file of ['frame','content']) {
    const source=readFileSync(`src/app/api/admin/top-dashboard/blocks/[blockId]/versions/[versionId]/${file}/route.ts`,'utf8');
    assert.match(source,/canReadTopDashboardBlock\(session, blockId\)/);
    assert.match(source,/searchParams\.get\('view'\) === 'sales-office'/);
    assert.match(source,/const canManage = isTopDashboardManagementSession\(session\)/);
    assert.match(source,file==='frame' ? /canManage && !officeView/ : /readOnly: officeView \|\| !canManage/);
  }
});
