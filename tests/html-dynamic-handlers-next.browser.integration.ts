/** Synthetic dynamic author HTML, served by the installed Next production
 * runtime with the site's actual header rules. No DB, real snapshots or secrets. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { buildTopDashboardContentSecurityPolicy } from '../src/shared/lib/topDashboardContentSecurity';
import { transformTopDashboardDynamicHandlers } from '../src/shared/lib/topDashboardContentSecurity/dynamicHandlers';
import { knowledgeBaseHtmlPolicy } from '../src/shared/lib/knowledgeBaseStorage';

const require = createRequire(import.meta.url);
const project = path.resolve(import.meta.dirname, '..');
const paths = {
  top: '/api/admin/top-dashboard/blocks/7/versions/51/content',
  kb: '/api/admin/knowledge-base/files/7',
};

// Keep these as ordinary author JavaScript/HTML, without bridge-specific APIs.
// They mirror the report's map/template/innerHTML/re-render patterns.
const authorScript = `
window.hits=[]; window.violations=[]; window.security={};
let revision=0;
function choose(kind,value,element,event){
  window.hits.push({kind,value,id:element.id,type:event.type});
  if(kind==='year') renderFilters();
}
function renderFilters(){
  revision++;
  document.getElementById('filters').innerHTML=
    [2025,2026].map(y=>\`<button id="year-\${y}" onclick="choose('year','\${y}',this,event);return false">\${y}</button>\`).join('')+
    [1,2,3,4].map(q=>\`<button id="quarter-\${q}" onclick="choose('quarter',\${q},this,event)">Q\${q}</button>\`).join('')+
    [1,2].map(m=>\`<button id="month-\${m}" onclick="choose('month',\${m},this,event)">Month \${m}</button>\`).join('')+
    \`<select id="dynamic-select" onchange="choose('value',this.value,this,event)"><option>A</option><option value="B&amp;C">B&amp;C</option></select>\`;
}
function renderAdditional(){
  const label='Кавычки &quot; и &amp;';
  document.getElementById('extra').innerHTML=\`<button id="entity-button" onclick="choose(&quot;entity&quot;,'\${label}',this,event)">Entities</button>\`+
    \`<a id="return-false" href="#should-not-navigate" onclick="choose('cancel',1,this,event);return false">Cancel navigation</a>\`+
    \`<input id="focus-input" onfocus="choose('focus',this.value,this,event)" value="synthetic">\`+
    \`<img id="error-image" onerror="choose('error',this.id,this,event)">\`+
    \`<input id="implicit-scope" value="before" onclick="disabled=true;value='changed';choose('implicit',value,this,event)">\`+
    \`<button id="event-shadow" onclick="choose('event-shadow',event.type,this,event)">Event parameter</button>\`;
  const adjacent=3;
  document.getElementById('extra').insertAdjacentHTML('beforeend',\`<button id="adjacent" onclick="choose('adjacent',\${adjacent},this,event)">Adjacent</button>\`);
  const template=document.createElement('template');
  const fragmentValue=4;
  template.innerHTML=\`<button id="fragment" onclick="choose('fragment',\${fragmentValue},this,event)">Fragment</button>\`;
  document.getElementById('extra').append(template.content.cloneNode(true));
}
function synchronousClick(){
  const n=9;
  document.getElementById('synchronous').innerHTML=\`<button id="sync-button" onclick="choose('sync',\${n},this,event)">Synchronous</button>\`;
  document.getElementById('sync-button').click();
}
const cachedValue=8;
const cachedHtml=\`<button id="cached-button" onclick="choose('cached',\${cachedValue},this,event)">Cached</button>\`;
function reuseCached(){
  document.getElementById('cached').innerHTML=cachedHtml;
  document.getElementById('cached-button').click();
}
function matchHtml(value){
  return {equals:value==='<button onclick="window.badMatcher=1">inert</button>',
    includes:value.includes('<button onclick="window.badMatcher=1">')};
}
function renderUntrusted(value){document.getElementById('untrusted').innerHTML=value;}
function renderUntrustedArgument(value){
  document.getElementById('argument').innerHTML=\`<button id="argument-button" onclick="choose('argument',\${value},this,event)">Argument</button>\`;
}
function renderQuotedArgument(value){
  document.getElementById('quoted-argument').innerHTML=\`<button id="quoted-argument-button" onclick="choose('quoted','\${value}',this,event)">Quoted argument</button>\`;
}
document.addEventListener('securitypolicyviolation',event=>window.violations.push(event.effectiveDirective));
try{window.security.parentReadable=Boolean(parent.document.body)}catch{window.security.parentBlocked=true}
try{document.cookie='synthetic_author=1';window.security.cookieReadable=true}catch{window.security.cookieBlocked=true}
try{localStorage.setItem('synthetic_author','1');window.security.storageReadable=true}catch{window.security.storageBlocked=true}
fetch('/api/synthetic-leak').then(()=>window.security.fetchBlocked=false).catch(()=>window.security.fetchBlocked=true);
fetch('https://invalid.example/synthetic-leak').then(()=>window.security.externalBlocked=false).catch(()=>window.security.externalBlocked=true);
renderFilters();renderAdditional();synchronousClick();
`;
const authorHtml = '<!doctype html><html><head><meta charset="utf-8"><title>Synthetic dynamic handlers</title>'
  + '<style>body{font:16px sans-serif}button,input,select,a{display:inline-block;margin:4px;padding:8px}</style></head><body>'
  + '<button id="static-control" onclick="choose(\'static\',1,this,event)">Static control</button>'
  + '<div id="filters"></div><div id="extra"></div><div id="synchronous"></div>'
  + '<div id="untrusted"></div><div id="argument"></div><div id="quoted-argument"></div><div id="cached"></div>'
  + '<!-- <button onclick="window.badComment=1">Not an author element</button> -->'
  + '<script type="application/json" id="inert-data">{"html":"onclick=\\"window.badJson=1\\""}</script>'
  + '<template id="inert-template"><script>window.inertScriptRan=1;document.body.innerHTML=`<button onclick="window.badInertTemplate=1">Inert</button>`;</script></template>'
  + '<script>' + authorScript + '</script></body></html>';

async function realHeaderRules() {
  const compiled = await build({ entryPoints: [path.join(project, 'next.config.ts')], absWorkingDir: project,
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' });
  const configModule = { exports: {} as { default: { headers(): Promise<unknown> } } };
  // Host-only loading of the repository's configuration, never author code.
  new Function('module', 'exports', 'require', '__dirname', '__filename', compiled.outputFiles[0].text)(
    configModule, configModule.exports, require, project, path.join(project, 'next.config.ts'));
  return configModule.exports.default.headers();
}

async function freePort() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const address = socket.address(); assert.ok(address && typeof address === 'object');
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return address.port;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>(resolve => {
    const deadline = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(deadline); resolve(); });
  });
}

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kts-html-dynamic-next-'));
  const sourceFile = path.join(directory, 'original-author.html');
  await writeFile(sourceFile, authorHtml);
  const transformed = transformTopDashboardDynamicHandlers(await readFile(sourceFile, 'utf8'));
  assert.notEqual(transformed, authorHtml, 'the dynamic author handlers need a preview transformation');
  assert.equal(await readFile(sourceFile, 'utf8'), authorHtml, 'the stored original is never rewritten');
  const policies = { top: buildTopDashboardContentSecurityPolicy(transformed), kb: knowledgeBaseHtmlPolicy(transformed) };
  const rawPolicies = { top: buildTopDashboardContentSecurityPolicy(authorHtml), kb: knowledgeBaseHtmlPolicy(authorHtml) };
  const app = path.join(directory, 'app');
  const headers = await realHeaderRules();
  await mkdir(app, { recursive: true });
  await symlink(path.join(project, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'kts-synthetic-html-dynamic', private: true,
    dependencies: { next: require('next/package.json').version, react: require('react/package.json').version, 'react-dom': require('react-dom/package.json').version } }));
  await writeFile(path.join(directory, 'next.config.mjs'), `export default {poweredByHeader:false,experimental:{cpus:1},headers:async()=>${JSON.stringify(headers)}};`);
  await writeFile(path.join(app, 'layout.js'), 'export default function Layout({children}){return <html><body>{children}</body></html>}');
  await writeFile(path.join(app, 'page.js'), `export default async function Page({searchParams}){const params=await searchParams;const surface=params.surface==='kb'?'kb':'top';const src=${JSON.stringify(paths)}[surface]+'?mode=preview&raw='+(params.raw==='1'?'1':'0');return <iframe id="author" title="Synthetic author HTML" src={src} sandbox={surface==='kb'?'allow-scripts':'allow-scripts allow-popups'} style={{width:'100%',height:'95vh',border:0}}/>;}`);
  for (const surface of ['top', 'kb'] as const) {
    const dataFile = path.join(directory, `${surface}.json`);
    await writeFile(dataFile, JSON.stringify({ html: transformed, raw: authorHtml, policy: policies[surface], rawPolicy: rawPolicies[surface] }));
    await mkdir(path.join(app, paths[surface]), { recursive: true });
    await writeFile(path.join(app, paths[surface], 'route.js'), `import {readFile} from 'node:fs/promises';export const dynamic='force-dynamic';export async function GET(request){const data=JSON.parse(await readFile(${JSON.stringify(dataFile)},'utf8'));const raw=new URL(request.url).searchParams.get('raw')==='1';return new Response(raw?data.raw:data.html,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':raw?data.rawPolicy:data.policy,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}})}`);
  }
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: homedir(), TMPDIR: tmpdir(), NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' };
  const cli = require.resolve('next/dist/bin/next');
  let log = '';
  const launch = (args: string[]) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', chunk => { log += String(chunk); }); child.stderr?.on('data', chunk => { log += String(chunk); });
    return child;
  };
  console.log(`Synthetic Next dynamic fixtures: ${directory}`);
  const builder = launch(['build', '--webpack']);
  const exit = await new Promise<number | null>((resolve, reject) => { builder.once('error', reject); builder.once('exit', resolve); });
  await writeFile(path.join(directory, 'next-runtime.log'), log);
  assert.equal(exit, 0, `Synthetic Next build failed: ${directory}/next-runtime.log`);
  const port = await freePort(); const origin = `http://127.0.0.1:${port}`;
  const server = launch(['start', '--hostname', '127.0.0.1', '--port', String(port)]);
  try {
    const deadline = Date.now() + 30_000;
    while (true) {
      try { if ((await fetch(origin, { signal: AbortSignal.timeout(2000) })).ok) break; } catch { /* Startup only. */ }
      assert.ok(Date.now() < deadline && server.exitCode === null, 'Synthetic Next did not become ready');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    for (const surface of ['top', 'kb'] as const) {
      const response = await fetch(`${origin}${paths[surface]}?mode=preview`);
      assert.equal(response.status, 200);
      const actual = response.headers.get('content-security-policy');
      assert.equal(actual, policies[surface], `${surface}: real Next preserves the generated HTML policy`);
      assert.match(actual, /connect-src 'none'/);
      assert.doesNotMatch(actual.match(/(?:^|; )script-src ([^;]+)/)?.[1] ?? '', /unsafe-inline|unsafe-eval/);
      assert.equal(await (await fetch(`${origin}${paths[surface]}?raw=1`)).text(), authorHtml, 'the original remains available unchanged');
    }
    assert.match((await fetch(origin)).headers.get('content-security-policy') ?? '', /default-src 'self'/);
    const runtime = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
    const playwright = await import(pathToFileURL(path.join(runtime, 'index.mjs')).href);
    for (const engine of ['chromium', 'webkit']) {
      const browser = await playwright[engine].launch({ headless: true });
      try {
        for (const surface of ['top', 'kb'] as const) {
          const context = await browser.newContext();
          const forbiddenRequests: string[] = [];
          await context.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => {
            const url = new URL(route.request().url());
            if (url.origin !== origin || /synthetic-leak|external-/.test(url.pathname)) {
              forbiddenRequests.push(url.href); return route.abort();
            }
            return route.continue();
          });
          const page = await context.newPage();
          await page.goto(`${origin}/?surface=${surface}&raw=1`);
          const raw = page.frames().find((frame: { url(): string }) => frame.url().startsWith(origin + paths[surface]));
          assert.ok(raw);
          await raw.locator('#static-control').click();
          assert.equal(await raw.evaluate('window.hits.filter(h=>h.kind==="static").length'), 1);
          await raw.locator('#year-2025').click();
          assert.equal(await raw.evaluate('window.hits.filter(h=>h.kind==="year").length'), 0, 'untransformed runtime interpolation reproduces the blocked report filter');

          await page.goto(`${origin}/?surface=${surface}`);
          const author = page.frames().find((frame: { url(): string }) => frame.url().startsWith(origin + paths[surface]));
          assert.ok(author);
          await author.waitForFunction('window.security.fetchBlocked && window.security.externalBlocked');
          assert.equal(await author.evaluate('window.inertScriptRan'), undefined, 'an earlier script inside an inert template neither executes nor consumes the runtime insertion point');
          assert.deepEqual(await author.evaluate('window.hits'), [{kind:'sync', value:9, id:'sync-button', type:'click'}], 'innerHTML followed immediately by click works without a mutation-observer delay');
          const expected: Array<{kind:string; value:string|number; id:string; type:string}> = [{kind:'sync', value:9, id:'sync-button', type:'click'}];
          for (const [id, kind, value] of [
            ['year-2025', 'year', '2025'], ['year-2026', 'year', '2026'],
            ['quarter-2', 'quarter', 2], ['month-1', 'month', 1],
            ['adjacent', 'adjacent', 3], ['fragment', 'fragment', 4],
            ['entity-button', 'entity', 'Кавычки " и &'],
          ] as const) {
            await author.locator('#' + id).click(); expected.push({kind,value,id,type:'click'});
            assert.deepEqual(await author.evaluate('window.hits'), expected, `${engine}/${surface}/${id}: author handler, arguments, this and event survive re-rendering`);
          }
          await author.locator('#dynamic-select').selectOption('B&C');
          assert.deepEqual(await author.evaluate('window.hits.at(-1)'), {kind:'value',value:'B&C',id:'dynamic-select',type:'change'});
          const beforeHash = author.url();
          await author.locator('#return-false').click();
          assert.equal(author.url(), beforeHash, 'return false cancels the default link navigation');
          await author.locator('#focus-input').focus();
          assert.deepEqual(await author.evaluate('window.hits.at(-1)'), {kind:'focus',value:'synthetic',id:'focus-input',type:'focus'}, 'non-bubbling focus dispatch works');
          await author.locator('#error-image').evaluate((el: Element) => el.dispatchEvent(new Event('error', {bubbles:false})));
          assert.deepEqual(await author.evaluate('window.hits.at(-1)'), {kind:'error',value:'error-image',id:'error-image',type:'error'}, 'non-bubbling error dispatch works');
          await author.locator('#implicit-scope').click();
          assert.deepEqual(await author.evaluate('window.hits.at(-1)'), {kind:'implicit',value:'changed',id:'implicit-scope',type:'click'}, 'native inline handlers resolve bare disabled/value against the element');
          assert.equal(await author.locator('#implicit-scope').isDisabled(), true);
          assert.equal(await author.locator('#implicit-scope').inputValue(), 'changed');
          await author.evaluate(`document.getElementById('event-shadow').event={type:'wrong'}`);
          await author.locator('#event-shadow').click();
          assert.deepEqual(await author.evaluate('window.hits.at(-1)'), {kind:'event-shadow',value:'click',id:'event-shadow',type:'click'}, 'the event parameter takes precedence over an element property named event');
          await author.evaluate('reuseCached();reuseCached()');
          assert.deepEqual(await author.evaluate('window.hits.slice(-2)'), [
            {kind:'cached',value:8,id:'cached-button',type:'click'},
            {kind:'cached',value:8,id:'cached-button',type:'click'},
          ], 'cached generated markup can be inserted more than once');
          await author.evaluate(`
            const copied=document.getElementById('cached-button').cloneNode(true);
            copied.id='cached-clone';document.getElementById('cached').append(copied);copied.click();
            const input=document.getElementById('implicit-scope').cloneNode(true);
            input.id='implicit-clone';input.disabled=false;input.value='clone before';
            document.getElementById('extra').append(input);input.click();
          `);
          assert.deepEqual(await author.evaluate('window.hits.slice(-2)'), [
            {kind:'cached',value:8,id:'cached-clone',type:'click'},
            {kind:'implicit',value:'changed',id:'implicit-clone',type:'click'},
          ], 'cloned nodes retain handlers with their own this/implicit element scope');
          assert.equal(await author.locator('#implicit-clone').isDisabled(), true);
          assert.equal(await author.locator('#implicit-clone').inputValue(), 'changed');
          await author.evaluate(`document.getElementById('cached').replaceChildren()`);
          if (engine === 'chromium') {
            const cdp = await context.newCDPSession(page);
            await cdp.send('HeapProfiler.collectGarbage');
            await cdp.detach();
          }
          await author.evaluate('reuseCached()');
          assert.deepEqual(await author.evaluate('window.hits.at(-1)'), {kind:'cached',value:8,id:'cached-button',type:'click'}, 'cached HTML survives removal of all its nodes and garbage collection');
          assert.deepEqual(await author.evaluate(`matchHtml('<button onclick="window.badMatcher=1">inert</button>')`), {equals:true,includes:true}, 'HTML-looking matcher literals preserve equality/includes semantics');

          // Runtime data is not JavaScript source, even if interpolated into a
          // numeric argument by the author. Never authorize arbitrary handlers.
          await author.evaluate(`renderUntrustedArgument('1);window.syntheticInjectedData=1;//')`);
          await author.locator('#argument-button').click();
          assert.equal(await author.evaluate('window.syntheticInjectedData'), undefined);
          await author.evaluate(`renderQuotedArgument("O'Reilly &quot; &amp;")`);
          await author.locator('#quoted-argument-button').click();
          assert.deepEqual(await author.evaluate('window.hits.at(-1)'), {kind:'quoted',value:'O\'Reilly " &',id:'quoted-argument-button',type:'click'});
          for (const key of ['badUnknown', 'badComment', 'badJson', 'badMatcher', 'badInertTemplate']) {
            await author.evaluate((name: string) => {
              const host = document.getElementById('untrusted')!;
              host.innerHTML = '<button id="injected" onclick="window.' + name + '=1">Untrusted</button>';
              (host.firstElementChild as HTMLElement).click();
            }, key);
            assert.equal(await author.evaluate((name: string) => (window as unknown as Record<string, unknown>)[name], key), undefined);
          }
          await author.evaluate(() => {
            const inline = document.createElement('script'); inline.textContent = 'window.syntheticInjectedScript=1'; document.body.append(inline);
            const external = document.createElement('script'); external.src = '/external-script.js'; document.body.append(external);
            const image = document.createElement('img'); image.src = 'https://invalid.example/external-image.png'; document.body.append(image);
          });
          await page.waitForTimeout(100);
          assert.equal(await author.evaluate('window.syntheticInjectedScript'), undefined);
          for (const key of ['parentBlocked', 'cookieBlocked', 'storageBlocked', 'fetchBlocked', 'externalBlocked']) {
            assert.equal(await author.evaluate((name: string) => (window as unknown as {security: Record<string,boolean>}).security[name], key), true, key);
          }
          assert.deepEqual(forbiddenRequests, [], 'CSP stops blocked requests before network dispatch');
          await page.goto(origin + paths[surface] + '?mode=preview');
          await page.waitForFunction('window.security.cookieBlocked && window.security.storageBlocked');
          assert.equal(await page.evaluate('window.security.cookieBlocked && window.security.storageBlocked'), true, 'direct content URLs retain the opaque sandbox');
          await context.close();
          console.log(`PASS ${engine}/${surface}: dynamic controls, synchronous/non-bubbling events, arguments and security isolation`);
        }
      } finally { await browser.close(); }
    }
  } finally {
    await stop(server);
    await writeFile(path.join(directory, 'next-runtime.log'), log);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
