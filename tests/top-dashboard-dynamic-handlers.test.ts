import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';
import { SAXParser } from 'parse5-sax-parser';
import { compileTopDashboardDynamicHandlers } from '../src/shared/lib/topDashboardContentSecurity/dynamicHandlers';
import { collectTopDashboardInlineHashes } from '../src/shared/lib/topDashboardContentSecurity/inlineSources';
import { createHash } from 'node:crypto';

function scripts(html: string) {
  const result: string[] = []; let active = false; let source = '';
  const parser = new SAXParser();
  parser.on('startTag', tag => { if (tag.tagName === 'script') { active = true; source = ''; } });
  parser.on('text', token => { if (active) source += token.text; });
  parser.on('endTag', tag => { if (tag.tagName === 'script' && active) { result.push(source); active = false; } });
  parser.end(html);
  return result;
}

function compiled(script: string, globals: Record<string, unknown> = {}) {
  const result = compileTopDashboardDynamicHandlers(`<script>${script}</script>`);
  const parts = scripts(result.html);
  for (const source of parts) parse(source, { ecmaVersion: 'latest' });
  type Definition = { event: string; factory: (args: unknown[], element: Record<string, unknown>) => (event: unknown) => unknown; kinds: string[]; source: string };
  const definitions = new Map<string, Definition>();
  const invocations: Array<{ id: string; args: unknown[] }> = [];
  const context = vm.createContext({ ...globals });
  for (const source of parts) {
    const key = /^globalThis\.([A-Za-z0-9_]+)\.register/.exec(source)?.[1];
    if (key) {
      context[key] = {
        register(id: string, event: string, factory: Definition['factory'], kinds: string[], body: string) { definitions.set(id, { event, factory, kinds, source: body }); },
        marker(id: string, args: unknown[]) { invocations.push({ id, args: [...args] }); return `data-marker="${invocations.length}"`; },
      };
      vm.runInContext(source, context);
    } else if (!source.startsWith('(function(){\nvar KEY=')) vm.runInContext(source, context);
  }
  return { result, definitions, invocations, context };
}

test('compiles dynamic year/quarter handlers without interpreting the input values as code', () => {
  const hits: unknown[][] = [];
  const script = 'const y="O\'Reilly", q=3; var markup=`<button onclick="choose(\'${y}\',this,event);return false">year</button><button onclick="choose(${q},this,event)">quarter</button>`;';
  const run = compiled(script, { choose(...args: unknown[]) { hits.push(args); } });
  assert.equal(run.result.transformedHandlers, 2);
  assert.equal(run.result.unsupportedHandlers, 0);
  const element = { ownerDocument: {} }; const event = {};
  const first = run.invocations[0]; const firstDefinition = run.definitions.get(first.id)!;
  assert.deepEqual([...firstDefinition.kinds], ['string']);
  assert.deepEqual(first.args, ["O'Reilly"]);
  assert.equal(firstDefinition.factory(first.args, element).call(element, event), false);
  const second = run.invocations[1]; const secondDefinition = run.definitions.get(second.id)!;
  assert.deepEqual([...secondDefinition.kinds], ['primitive']);
  secondDefinition.factory([3], element).call(element, event);
  assert.deepEqual(hits, [["O'Reilly", element, event], [3, element, event]]);
});

test('does not capture shadowed render scope and retains implicit element/form/document scope', () => {
  const hits: unknown[] = [];
  const run = compiled('function make(){const render=()=>{throw Error("wrong local")};return `<input onclick="disabled=true;value=\'changed\';render(event);return false">`;}globalThis.markup=make();', {
    render(event: unknown) { hits.push(event); },
  });
  const definition = run.definitions.get(run.invocations[0].id)!;
  const element = { disabled: false, value: 'old', ownerDocument: {}, form: {} }; const event = { type: 'click' };
  assert.equal(definition.factory([], element).call(element, event), false);
  assert.equal(element.disabled, true); assert.equal(element.value, 'changed');
  assert.deepEqual(hits, [event]);
  assert.equal(run.context.disabled, undefined);
});

test('handler parameters and arguments take precedence over named element properties', () => {
  const hits: unknown[][] = [];
  const run = compiled('var markup=`<button onclick="record(event,arguments.length,this)">go</button>`;', { record(...args: unknown[]) { hits.push(args); } });
  const element = { ownerDocument: {}, event: 'wrong event', arguments: 'wrong arguments' }; const event = {};
  run.definitions.get(run.invocations[0].id)!.factory([], element).call(element, event);
  assert.deepEqual(hits, [[event, 1, element]]);
});

test('keeps strict author scripts and handler directives intact', () => {
  const run = compiled('"use strict";var markup=`<button onclick="\'use strict\';globalThis.hit=1">go</button>`;');
  assert.match(scripts(run.result.html).at(-1)!, /^"use strict";/);
  const definition = run.definitions.get(run.invocations[0].id)!;
  definition.factory([], { ownerDocument: {} }).call({}, {});
  assert.equal(run.context.hit, 1);
});

test('allows whole dynamic assignment keys, never composite properties or dynamic callees/code bodies', () => {
  const source = 'const key="gran"; var markup=`<button onclick="S.opts.${key}=\'month\';render()">ok</button><button onclick="S.__${key}__={x:1}">bad</button><button onclick="window.${key}()">bad</button><button onclick="${key}">bad</button>`;';
  const run = compiled(source, { S: { opts: {} }, render() {} });
  assert.equal(run.result.transformedHandlers, 1);
  assert.equal(run.result.unsupportedHandlers, 3);
  const definition = run.definitions.get(run.invocations[0].id)!;
  assert.deepEqual([...definition.kinds], ['key']);
  definition.factory(['gran'], { ownerDocument: {} }).call({}, {});
  assert.deepEqual(run.context.S, { opts: { gran: 'month' } });
});

test('quoted computed keys use the same key guard; composite keys, callees and object key syntax stay blocked', () => {
  const source = 'const key="gran";var markup=`<button onclick="S[\'${key}\']=1">ok</button><button onclick="S[\'con${key}or\']=1">bad</button><button onclick="S[\'${key}\']()">bad</button><button onclick="use({\'${key}\':1})">bad</button>`;';
  const run = compiled(source, { S: {} });
  assert.equal(run.result.transformedHandlers, 1); assert.equal(run.result.unsupportedHandlers, 3);
  assert.deepEqual([...run.definitions.get(run.invocations[0].id)!.kinds], ['key']);
});

test('compiled callbacks do not authorize the corresponding raw inline attribute', () => {
  const html = '<script>const example=`<button onclick="window.privateValue=1">go</button>`;</script>';
  const result = compileTopDashboardDynamicHandlers(html);
  const sources = collectTopDashboardInlineHashes(result.html);
  const unsafeHash = `'sha256-${createHash('sha256').update('window.privateValue=1').digest('base64')}'`;
  assert.ok(!sources.eventHandlerHashes.includes(unsafeHash));
  assert.ok(!sources.scriptHashes.includes(unsafeHash));
  assert.doesNotMatch(result.html, /\beval\s*\(|new Function\s*\(/);
});

test('generated callbacks cannot terminate the containing script element', () => {
  const source = 'var markup=`<button onclick="globalThis.value=\'&lt;/script>&lt;script>attack()&lt;/script>\'">go</button>`;';
  const run = compiled(source);
  assert.equal(scripts(run.result.html).length, 3);
  run.definitions.get(run.invocations[0].id)!.factory([], { ownerDocument: {} }).call({}, {});
  assert.equal(run.context.value, '</script><script>attack()</script>');
});

test('nested template expressions preserve compiled child handlers and original string order', () => {
  const run = compiled('const n=3;var markup=`<div onclick="parentFn()">${`<button onclick="childFn(${n})">child</button>`}</div>`;', { parentFn() {}, childFn() {} });
  assert.equal(run.result.transformedHandlers, 2);
  assert.equal(run.invocations.length, 2);
  assert.match(String(run.context.markup), /^<div data-marker="1"><button data-marker="2">child<\/button><\/div>$/);
});

test('inert template scripts cannot capture the active bootstrap location', () => {
  const html = '<template><script>const never=`<button onclick="inactive()">no</button>`;</script></template><script>var markup=`<button onclick="active()">yes</button>`;</script>';
  const result = compileTopDashboardDynamicHandlers(html);
  assert.equal(result.transformedHandlers, 1);
  assert.ok(result.html.indexOf('var KEY=') > result.html.indexOf('</template>'));
});

test('does not rewrite comparison needles, string-method arguments, object data or text sinks', () => {
  const source = [
    'globalThis.equal=input===\'<button onclick="hit()">x</button>\';',
    'globalThis.found=input.includes(\'<button onclick="hit()">x</button>\');',
    'globalThis.replaced=input.replace(\'<button onclick="hit()">x</button>\',"ok");',
    'globalThis.data={example:\'<button onclick="hit()">x</button>\'};',
    'const needle=\'<button onclick="hit()">x</button>\';globalThis.aliasFound=input.includes(needle);',
    'target.textContent=`<button onclick="hit()">x</button>`;',
  ].join('\n');
  const target = { textContent: '' };
  const run = compiled(source, { input: '<button onclick="hit()">x</button>', target });
  assert.equal(run.result.transformedHandlers, 0);
  assert.equal(run.context.equal, true); assert.equal(run.context.found, true); assert.equal(run.context.replaced, 'ok');
  assert.equal(run.context.aliasFound, true);
  assert.equal(target.textContent, '<button onclick="hit()">x</button>');
});

test('20 MiB raw script and pathological attributes stay within the protected heap', { timeout: 20_000 }, () => {
  for (const mode of ['script', 'attributes']) {
    const child = spawnSync(process.execPath, ['--max-old-space-size=256', '--import', 'tsx', '--input-type=module', '-e', `
      import {compileTopDashboardDynamicHandlers as compile} from ${JSON.stringify(new URL('../src/shared/lib/topDashboardContentSecurity/dynamicHandlers.ts', import.meta.url).href)};
      const mode=${JSON.stringify(mode)};
      const ending=${JSON.stringify(';const html=\'<button onclick="hit()">x</button>\';</script>')};
      const body=mode==='script' ? '<script>const large="'+'x'.repeat(20*1024*1024)+'"'+ending : '<div '+Array.from({length:150000},(_,i)=>'data-'+i+'=x').join(' ')+'></div><script>'+ending;
      const result=compile(body);if(result.html!==body||!result.skippedScripts)process.exitCode=2;else console.log('bounded');
    `], { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 });
    assert.equal(child.status, 0, `${mode}: ${child.error?.message ?? ''}\n${child.stderr}`);
    assert.match(child.stdout, /bounded/);
  }
});
