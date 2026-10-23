import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { instrumentReviewedDashboardUsage, withCompiledDashboardHandlerSelectors } from '../src/shared/lib/dashboardUsageProfiles';
import { dashboardUsageAdapterScript } from '../src/shared/lib/dashboardUsageBridge';

const marker = 'kts-dashboard-usage-v1';
const nonce = '12345678901234567890123456789012';
const profile = { id: 'fixture', tabs: '.actual-tab', filterClicks: '.actual-filter', filterInputs: '.actual-input', calculationInputs: '.actual-calculation' };

test('reviewed selectors retain static controls and recognize compiled handlers without mixing event types', () => {
  assert.equal(withCompiledDashboardHandlerSelectors('.yr,#gran'), '.yr,#gran');
  assert.equal(withCompiledDashboardHandlerSelectors('button[onclick^="setView("],input[oninput^="S.q="]'),
    'button[onclick^="setView("],input[oninput^="S.q="],button[data-kts-handler-onclick^="setView("],input[data-kts-handler-oninput^="S.q="]');
});
function fixture(autoInit = true) {
  const docEvents = new Map<string, Array<(event: object) => void>>();
  const winEvents = new Map<string, Array<(event: object) => void>>();
  const messages: Array<{ action?: string; upload?: {name: string;size: number} }> = [];
  const on = (map: typeof docEvents) => (name: string, fn: (event: object) => void) => map.set(name, [...(map.get(name) ?? []), fn]);
  let now = 100000;
  class Element {
    constructor(readonly selector: string) {}
    matches(selector: string) { return selector.split(',').includes(this.selector); }
    closest(selector: string) { return this.matches(selector) ? this : null; }
  }
  const parent = { postMessage: (value: { action?: string }) => messages.push(value) };
  const window = { parent, addEventListener: on(winEvents) } as unknown as {
    parent: typeof parent;
    __ktsDashboardUsage: { configure(value: object): void; beginRender(): null | ((calculated?: boolean) => void); record(action:string,metadata?:object):void };
  };
  const document = { hidden: false, addEventListener: on(docEvents) };
  vm.runInNewContext(dashboardUsageAdapterScript(), { window, document, Element, Date: { now: () => now } });
  const init = () => winEvents.get('message')!.forEach(fn => fn({ source: parent, data: { marker, type: 'init', nonce } }));
  if (autoInit) init();
  const fire = (type: string, selector: string, isTrusted = true) => docEvents.get(type)?.forEach(fn => fn({ type, isTrusted, target: new Element(selector) }));
  const actions = () => messages.map(m => m.action).filter(Boolean);
  return { window, document, fire, actions, messages, init, advance: (ms: number) => { now += ms; } };
}

test('explicit successful upload metadata is bounded, preserves separate pre-handshake imports, and never accepts arbitrary fields', () => {
  const f = fixture(false);
  const record = f.window.__ktsDashboardUsage.record;
  record('data_loaded', {upload:{name:'first.json',size:12}});
  record('data_loaded', {upload:{name:'second.json',size:20}});
  for (const upload of [{name:'../private.json',size:1},{name:'a\\b.json',size:1},{name:'\u202eexe.json',size:1},
    {name:'a.json',size:1,content:'private'},{name:'a.json',size:2147483649},{name:'.',size:1}]) record('data_loaded',{upload});
  record('filter_changed', {upload:{name:'bad.json',size:1}});
  record('data_loaded', {upload:{name:'bad.json',size:1},value:'private'});
  f.document.hidden = true;
  record('data_loaded',{upload:{name:'completed-while-hidden.json',size:15}});
  f.init();
  assert.deepEqual(f.actions(),['report_open','data_loaded','data_loaded','data_loaded']);
  const uploads = f.messages.filter(message=>message.upload).map(message=>JSON.parse(JSON.stringify(message.upload)));
  assert.deepEqual(uploads,[{name:'first.json',size:12},{name:'second.json',size:20},{name:'completed-while-hidden.json',size:15}]);
});

test('reviewed controls log only completed work, with no field values or background render events', () => {
  const f = fixture(); f.window.__ktsDashboardUsage.configure(profile);
  f.fire('click', '.actual-tab');
  assert.deepEqual(f.actions(), ['report_open'], 'a click is not completed work');
  f.window.__ktsDashboardUsage.beginRender()!(true);
  assert.deepEqual(f.actions(), ['report_open', 'tab_changed', 'calculation_completed']);
  assert.equal(f.window.__ktsDashboardUsage.beginRender(), null, 'background rerender has no intent');
  f.fire('input', '.actual-input'); f.advance(350);
  const complete = f.window.__ktsDashboardUsage.beginRender()!;
  f.advance(31000); complete(true); complete(true);
  assert.deepEqual(f.actions().slice(-2), ['filter_changed', 'calculation_completed'], 'long successful calculation counts once');
  f.fire('change', '[type="password"]'); assert.equal(f.window.__ktsDashboardUsage.beginRender(), null);
  f.fire('change', '[type="file"]'); assert.equal(f.window.__ktsDashboardUsage.beginRender(), null);
  f.fire('input', '.actual-input', false); assert.equal(f.window.__ktsDashboardUsage.beginRender(), null);
  f.document.hidden = true; f.fire('click', '.actual-tab'); assert.equal(f.window.__ktsDashboardUsage.beginRender(), null);
});

test('failed renders, stale intents and ordinary panel clicks do not fabricate successful calculations or tab changes', () => {
  const f = fixture();
  f.fire('click', '.tab'); assert.deepEqual(f.actions(), ['report_open'], 'a tab panel is not a navigation control');
  f.window.__ktsDashboardUsage.configure(profile);
  f.fire('click', '.actual-filter');
  f.window.__ktsDashboardUsage.beginRender(); // author code failed and never calls completion
  assert.deepEqual(f.actions(), ['report_open']);
  f.fire('change', '.actual-input'); f.advance(1001); assert.equal(f.window.__ktsDashboardUsage.beginRender(), null);
  f.fire('change', '.actual-input'); f.fire('click', '.unrelated'); assert.equal(f.window.__ktsDashboardUsage.beginRender(), null);
  f.fire('click', '.actual-tab'); f.window.__ktsDashboardUsage.beginRender()!(false);
  assert.deepEqual(f.actions(), ['report_open', 'tab_changed'], 'empty/load tabs are not calculations');
});

test('unknown HTML remains byte-for-byte identical; a title alone never grants reviewed hooks', () => {
  for (const html of ['<html><script>function render(){return 42}</script></html>', '<html><title>Аналитика продаж v98</title><script>function render(){throw Error()}</script></html>']) {
    assert.equal(instrumentReviewedDashboardUsage(html), html);
  }
});

const fixtureDir = process.env.KTS_USAGE_HTML_FIXTURES;
test('actual published author versions have exact reviewed bodies; wrappers parse and never alter original imports/exports/formulas', {
  skip: !fixtureDir || !existsSync(fixtureDir),
}, () => {
  const expected = new Set(['personal-sales-v34', 'sales-analytics-v98', 'assortment-v96', 'purchases-v55', 'strategy-v24', 'route-planner-v26']);
  const seen = new Set<string>();
  for (const file of readdirSync(fixtureDir!).filter(name => name.endsWith('.html'))) {
    const original = readFileSync(path.join(fixtureDir!, file), 'utf8');
    const adapted = instrumentReviewedDashboardUsage(original);
    const id = /configure\(\{"id":"([^"]+)"/.exec(adapted)?.[1];
    assert.ok(id, `unreviewed fixture ${file}`); seen.add(id);
    assert.equal(instrumentReviewedDashboardUsage(adapted), adapted, 'idempotent');
    const originalScripts = [...original.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(m => m[1]);
    const adaptedScripts = [...adapted.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map(m => m[1]);
    assert.equal(originalScripts.length, adaptedScripts.length);
    let changed = 0;
    for (let i = 0; i < originalScripts.length; i++) {
      if (originalScripts[i] === adaptedScripts[i]) continue;
      changed++;
      assert.equal(adaptedScripts[i].slice(0, 30), originalScripts[i].slice(0, 30), 'author directive prologue remains in place');
      const ast = ts.createSourceFile('author.js', adaptedScripts[i], ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      assert.equal((ast as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length, 0);
      assert.match(adaptedScripts[i], /beginRender\(\)/);
      if (id === 'sales-analytics-v98') assert.match(adaptedScripts[i], /catch \(err\)\{\s*__ktsUsageFailed = true;/);
      // A changed author function must fail the whole-script fingerprint, not partially patch a new version.
      const changedAuthor = original.replace(originalScripts[i], originalScripts[i] + '\n/*new version*/');
      assert.equal(instrumentReviewedDashboardUsage(changedAuthor), changedAuthor);
    }
    assert.equal(changed, 1);
  }
  assert.deepEqual(seen, expected);
});
