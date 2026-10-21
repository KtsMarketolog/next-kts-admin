/** Real retry notice and CSS, synthetic router only; no application requests or saved-price writes. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { compile } from 'sass';

const fixture = `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {PriceBuildNotice} from './src/app/price/[token]/PriceBuildNotice';
window.refreshCount=0;window.readyNext=false;
window.routerRefresh=()=>{window.refreshCount++;return new Promise(resolve=>{window.completeRefresh=()=>{if(window.readyNext)window.showPrice();resolve();}});};
function Fixture(){const[ready,setReady]=useState(false);window.showPrice=()=>setReady(true);return ready?<h1>Сохранённый прайс</h1>:<PriceBuildNotice/>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;

async function main() {
  const root = path.resolve('.');
  const runtime = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const playwright = await import(pathToFileURL(path.join(runtime, 'index.mjs')).href);
  const output = await mkdtemp(path.join(tmpdir(), 'kts-price-build-notice-ui-'));
  let css = '';
  const bundle = await build({ absWorkingDir: root, stdin: { contents: fixture, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'fixture-router-and-real-css', setup(plugin) {
      plugin.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'router', namespace: 'fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export function useRouter(){return {refresh:()=>window.routerRefresh()}}', loader: 'js' }));
      plugin.onLoad({ filter: /\.module\.scss$/ }, (args) => {
        css = compile(args.path).css;
        const names = [...new Set([...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => match[1]))];
        return { contents: `export default ${JSON.stringify(Object.fromEntries(names.map((name) => [name, name])))}`, loader: 'js' };
      });
    } }],
  });
  const globalCss = await readFile(path.join(root, 'src/app/globals.css'), 'utf8');
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/app.js') return void response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    if (url.pathname === '/style.css') return void response.writeHead(200, { 'Content-Type': 'text/css' }).end(globalCss + css);
    if (/^\/fonts\/montserrat\/montserrat-[a-z-]+\.woff2$/.test(url.pathname)) return void response.writeHead(200, { 'Content-Type': 'font/woff2' }).end(await readFile(path.join(root, 'public', url.pathname)));
    return void response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (const engine of ['chromium', 'webkit']) {
      const browser = await playwright[engine].launch({ headless: true });
      try {
        for (const width of [1440, 390, 320]) {
          const page = await browser.newPage({ viewport: { width, height: 900 } });
          page.setDefaultTimeout(10_000);
          const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message));
          await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          await page.goto(origin, { waitUntil: 'networkidle' });
          await page.getByRole('heading', { name: 'Прайс готовится', exact: true }).waitFor();
          assert.match(await page.locator('main').innerText(), /Данные прайса сохранены/);
          assert.equal(await page.evaluate('window.refreshCount'), 0, 'notice does not retry automatically');
          assert.equal(await page.locator('main').evaluate((node: HTMLElement) => node.scrollWidth <= node.clientWidth), true);
          const retry = page.getByRole('button', { name: 'Повторить', exact: true });
          assert.ok((await retry.boundingBox()).height >= 44);
          await page.screenshot({ path: path.join(output, `${engine}-${width}-notice.png`) });

          await retry.focus(); await retry.press('Enter');
          const pending = page.getByRole('button', { name: 'Открываем прайс…', exact: true });
          await pending.waitFor();
          assert.equal(await pending.isDisabled(), true);
          assert.equal(await page.getByRole('region', { name: 'Прайс готовится', exact: true }).getAttribute('aria-busy'), 'true');
          assert.equal(await page.getByRole('status').innerText(), 'Проверяем готовность прайса…');
          await pending.evaluate((button: HTMLButtonElement) => button.click());
          assert.equal(await page.evaluate('window.refreshCount'), 1);
          await page.evaluate('window.completeRefresh()');
          await retry.waitFor();
          assert.equal(await retry.isEnabled(), true, 'another busy response releases retry button');
          assert.equal(await page.evaluate('window.refreshCount'), 1, 'no retry loop after busy response');

          await page.evaluate('window.readyNext=true'); await retry.click();
          await pending.waitFor(); await page.evaluate('window.completeRefresh()');
          await page.getByRole('heading', { name: 'Сохранённый прайс', exact: true }).waitFor();
          assert.equal(await page.evaluate('window.refreshCount'), 2);
          assert.equal(await retry.count(), 0);
          assert.deepEqual(errors, []);
          await page.close();
          console.log(`${engine}/${width}: accessible retry, pending lock, no automatic loop, successful recovery and layout passed`);
        }
      } finally { await browser.close(); }
    }
    console.log(`Screenshots: ${output}`);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
