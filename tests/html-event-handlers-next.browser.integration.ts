/** Synthetic author HTML through installed Next production HTTP + real site
 * header rules. No production DB, credentials, documents or network services. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { buildTopDashboardContentSecurityPolicy } from '../src/shared/lib/topDashboardContentSecurity';
import { knowledgeBaseHtmlPolicy } from '../src/shared/lib/knowledgeBaseStorage';

const require = createRequire(import.meta.url);
const project = path.resolve(import.meta.dirname, '..');
const paths = {
  top: '/api/admin/top-dashboard/blocks/7/versions/51/content',
  kb: '/api/admin/knowledge-base/files/7',
};
const handlers = [
  ['quoted', '<button id="quoted" onclick="record(&quot;quoted&quot;)">Named quotes</button>', 'quoted'],
  ['apos', "<button id=\"apos\" onclick='record(&apos;apos&apos;)'>Named apostrophes</button>", 'apos'],
  ['decimal', '<button id="decimal" onclick="record(&#34;decimal&#34;)">Decimal references</button>', 'decimal'],
  ['hex', '<button id="hex" onclick="record(&#x22;hex&#x22;)">Hex references</button>', 'hex'],
  ['crlf', '<button id="crlf" onclick="record(\r\n\'crlf\'\r\n)">CRLF</button>', 'crlf'],
  ['cr', '<button id="cr" onclick="record(\r\'cr\'\r)">Raw CR</button>', 'cr'],
  ['entity-cr', '<button id="entity-cr" onclick="record(&#13;\'entity-cr\'&#13;)">Entity CR is not raw CR</button>', 'entity-cr'],
  ['unquoted', '<button id="unquoted" onclick=record(42)>Unquoted</button>', '42'],
  ['unquoted-entity', '<button id="unquoted-entity" onclick=record(&quot;unquoted-entity&quot;)>Unquoted entities</button>', 'unquoted-entity'],
  ['once', '<button id="once" onclick="record(\'&amp;not;\')">Decode once</button>', '&not;'],
  ['ambiguous', '<button id="ambiguous" onclick="record(\'&notit;\')">Attribute entity rules</button>', '&notit;'],
  ['mixed', '<button id="mixed" oNcLiCk="record(\'Тест\')">Mixed case and UTF-8</button>', 'Тест'],
  ['null', '<button id="null" onclick="record(\'null-\u0000\')">NULL replacement</button>', 'null-\uFFFD'],
  ['duplicate', '<button id="duplicate" onclick="record(\'first\')" onclick="window.badDuplicate=1">Duplicate first wins</button>', 'first'],
] as const;
const authorHtml = '<!doctype html><html><head><meta charset="utf-8"><title>Synthetic attribute compatibility</title>'
  + '<style>body{font:16px sans-serif}button{margin:4px;padding:10px}textarea{display:none}</style></head><body>'
  + handlers.map(([, html]) => html).join('\n')
  + '<button id="plain" onclick="record(\'plain\')">Baseline control</button>'
  + '<!-- <button onclick="window.badComment=1">Not an element</button> -->'
  + '<textarea><button onclick="window.badText=1">Not an element</button></textarea>'
  + '<div title="inert onmouseover=\'window.badAttribute=1\'">Attribute text is not another attribute</div>'
  + '<template id="source-template"><button id="template-button" onclick="record(&quot;template&quot;)">Template author handler</button></template>'
  + '<script>\r\nwindow.hits=[];window.violations=[];window.security={};\r\n'
  + 'function record(value){window.hits.push(String(value));}\r\n'
  + 'const inertText=\'<button onclick="window.badString=1">Not a parsed element</button>\';\r\n'
  + 'document.addEventListener("securitypolicyviolation",event=>window.violations.push(event.effectiveDirective));\r\n'
  + 'document.body.append(document.getElementById("source-template").content.cloneNode(true));\r\n'
  + 'try{window.security.parentReadable=Boolean(parent.document.body)}catch{window.security.parentBlocked=true}\r\n'
  + 'try{document.cookie="synthetic_author=1";window.security.cookieReadable=true}catch{window.security.cookieBlocked=true}\r\n'
  + 'try{localStorage.setItem("synthetic_author","1");window.security.storageReadable=true}catch{window.security.storageBlocked=true}\r\n'
  + 'fetch("/api/synthetic-leak").then(()=>window.security.fetchBlocked=false).catch(()=>window.security.fetchBlocked=true);\r\n'
  + 'fetch("https://invalid.example/synthetic-leak").then(()=>window.security.externalBlocked=false).catch(()=>window.security.externalBlocked=true);\r\n'
  + '</script></body></html>';

function hash(value: string) { return `'sha256-${createHash('sha256').update(value).digest('base64')}'`; }
function legacyPolicy(html: string, actual: string) {
  // Exact pre-fix extraction retained only as a regression control. The browser
  // must reject its encoded handler while executing the plain handler.
  const scripts = Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi), match => hash((match[1] ?? '').replace(/\r\n?/g, '\n')));
  const attrs = Array.from(html.matchAll(/\son[a-z][\w:-]*\s*=\s*(?:"([^"]*)"|'([^']*)')/gi), match => hash(match[1] ?? match[2] ?? ''));
  return actual.replace(/script-src [^;]*/, `script-src 'unsafe-hashes' ${[...new Set([...scripts, ...attrs])].join(' ')}`);
}

async function realHeaderRules() {
  const compiled = await build({ entryPoints: [path.join(project, 'next.config.ts')], absWorkingDir: project,
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' });
  const configModule = { exports: {} as { default: { headers(): Promise<unknown> } } };
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
  const policies = { top: buildTopDashboardContentSecurityPolicy(authorHtml), kb: knowledgeBaseHtmlPolicy(authorHtml) };
  const directory = await mkdtemp(path.join(tmpdir(), 'kts-html-attribute-next-'));
  const app = path.join(directory, 'app');
  const headers = await realHeaderRules();
  await mkdir(app, { recursive: true });
  await symlink(path.join(project, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'kts-synthetic-html-csp', private: true,
    dependencies: { next: require('next/package.json').version, react: require('react/package.json').version, 'react-dom': require('react-dom/package.json').version } }));
  await writeFile(path.join(directory, 'next.config.mjs'), `export default {poweredByHeader:false,experimental:{cpus:1},headers:async()=>${JSON.stringify(headers)}};`);
  await writeFile(path.join(app, 'layout.js'), 'export default function Layout({children}){return <html><body>{children}</body></html>}');
  await writeFile(path.join(app, 'page.js'), `export default async function Page({searchParams}) {const params=await searchParams;const surface=params.surface==='kb'?'kb':'top';const src=${JSON.stringify(paths)}[surface]+'?mode=preview&legacy='+(params.legacy==='1'?'1':'0');return <iframe id="author" title="Synthetic author HTML" src={src} sandbox={surface==='kb'?'allow-scripts':'allow-scripts allow-popups'} style={{width:'100%',height:'95vh',border:0}}/>;}`);
  for (const surface of ['top', 'kb'] as const) {
    const dataFile = path.join(directory, `${surface}.json`);
    await writeFile(dataFile, JSON.stringify({ html: authorHtml, policy: policies[surface], legacyPolicy: legacyPolicy(authorHtml, policies[surface]) }));
    await mkdir(path.join(app, paths[surface]), { recursive: true });
    await writeFile(path.join(app, paths[surface], 'route.js'), `import {readFile} from 'node:fs/promises';export const dynamic='force-dynamic';export async function GET(request){const data=JSON.parse(await readFile(${JSON.stringify(dataFile)},'utf8'));return new Response(data.html,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':new URL(request.url).searchParams.get('legacy')==='1'?data.legacyPolicy:data.policy,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}})}`);
  }
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: homedir(), TMPDIR: tmpdir(), NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'production' };
  const cli = require.resolve('next/dist/bin/next');
  let log = '';
  const launch = (args: string[]) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', chunk => { log += String(chunk); }); child.stderr?.on('data', chunk => { log += String(chunk); });
    return child;
  };
  console.log(`Synthetic Next attribute fixtures: ${directory}`);
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
      await writeFile(path.join(directory, `${surface}-observed-csp.txt`), actual ?? '(missing)');
      assert.equal(actual, policies[surface], `${surface}: real Next must preserve the generated HTML policy, not override it with global site CSP`);
      assert.match(actual, /connect-src 'none'/);
      assert.doesNotMatch(actual.match(/(?:^|; )script-src ([^;]+)/)?.[1] ?? '', /unsafe-inline|unsafe-eval/);
    }
    assert.match((await fetch(origin)).headers.get('content-security-policy') ?? '', /default-src 'self'/, 'regular site pages retain global CSP');
    const runtime = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
    const playwright = await import(pathToFileURL(path.join(runtime, 'index.mjs')).href);
    let cases = 0;
    for (const engine of ['chromium', 'webkit']) {
      const browser = await playwright[engine].launch({ headless: true });
      try {
        for (const surface of ['top', 'kb'] as const) {
          const context = await browser.newContext();
          const forbiddenRequests: string[] = [];
          await context.route('**/*', (route: { request(): { url(): string; method(): string }; continue(): Promise<void>; abort(): Promise<void> }) => {
            const request = route.request(); const url = new URL(request.url());
            if (url.origin !== origin || url.pathname.includes('synthetic-leak') || url.pathname.includes('external-')) {
              forbiddenRequests.push(request.url()); return route.abort();
            }
            return route.continue();
          });
          const page = await context.newPage();
          await page.goto(`${origin}/?surface=${surface}&legacy=1`);
          const legacy = page.frames().find((frame: { url(): string }) => frame.url().startsWith(origin + paths[surface]));
          assert.ok(legacy);
          await legacy.locator('#plain').click();
          assert.deepEqual(await legacy.evaluate('window.hits'), ['plain']);
          await legacy.locator('#quoted').click();
          assert.deepEqual(await legacy.evaluate('window.hits'), ['plain'], 'pre-fix raw attribute hash reproduces the inert encoded-quote button');
          await legacy.waitForFunction(() => (window as unknown as { violations: string[] }).violations.some(value => value.startsWith('script-src')));
          cases++;

          await page.goto(`${origin}/?surface=${surface}`);
          const author = page.frames().find((frame: { url(): string }) => frame.url().startsWith(origin + paths[surface]));
          assert.ok(author);
          await author.waitForFunction(() => {
            const security = (window as unknown as { security: Record<string, boolean> }).security;
            return security.fetchBlocked && security.externalBlocked;
          });
          const expected: string[] = [];
          for (const [id, , value] of handlers) {
            await author.locator(`#${id}`).click(); expected.push(value);
            assert.deepEqual(await author.evaluate('window.hits'), expected, `${engine}/${surface}/${id}: normalized author handler executes`);
            cases++;
          }
          await author.locator('#template-button').click(); expected.push('template');
          assert.deepEqual(await author.evaluate('window.hits'), expected, 'a real parsed author handler cloned from a template stays functional');
          for (const key of ['badComment', 'badText', 'badAttribute', 'badString', 'badDuplicate', 'badUnknown']) {
            await author.evaluate((name: string) => {
              const button = document.createElement('button'); button.id = 'injected-' + name;
              button.textContent = 'Synthetic forbidden handler'; button.setAttribute('onclick', 'window.' + name + '=1');
              document.body.append(button); button.click();
            }, key);
            assert.equal(await author.evaluate((name: string) => (window as unknown as Record<string, unknown>)[name], key), undefined,
              `${engine}/${surface}/${key}: inert-looking source text must not authorize an injected handler`);
            cases++;
          }
          await author.evaluate(() => {
            const inline = document.createElement('script'); inline.textContent = 'window.syntheticInjectedScript=1'; document.body.append(inline);
            const external = document.createElement('script'); external.src = '/external-script.js'; document.body.append(external);
            const image = document.createElement('img'); image.src = 'https://invalid.example/external-image.png'; document.body.append(image);
          });
          await page.waitForTimeout(100);
          assert.equal(await author.evaluate('window.syntheticInjectedScript'), undefined);
          assert.equal(await author.evaluate('window.security.parentBlocked'), true);
          assert.equal(await author.evaluate('window.security.cookieBlocked'), true);
          assert.equal(await author.evaluate('window.security.storageBlocked'), true);
          assert.deepEqual(forbiddenRequests, [], `${surface}: CSP must stop forbidden requests before network dispatch`);
          // A direct URL remains opaque because isolation comes from the header.
          await page.goto(origin + paths[surface] + '?mode=preview');
          await page.waitForFunction(() => {
            const security = (window as unknown as { security: Record<string, boolean> }).security;
            return security.cookieBlocked && security.storageBlocked;
          });
          assert.equal(await page.evaluate('window.syntheticInjectedScript'), undefined);
          await context.close();
          console.log(`PASS ${engine}/${surface}: author entities/normalization and negative hash/network/isolation checks`);
        }
      } finally { await browser.close(); }
    }
    console.log(`HTML CSP attribute checks passed: ${cases}; Next ${require('next/package.json').version}`);
  } finally {
    await stop(server);
    await writeFile(path.join(directory, 'next-runtime.log'), log);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
