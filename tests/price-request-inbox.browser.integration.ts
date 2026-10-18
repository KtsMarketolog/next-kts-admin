/** New management inbox with real CSS and synthetic session/repository only. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { compile } from 'sass';
import postcss from 'postcss';

const fixture = `import React from 'react';import {createRoot} from 'react-dom/client';
import Page from './src/app/admin/wholesale/requests/page';
Page({searchParams:Promise.resolve({pending:'1'})}).then(element=>createRoot(document.getElementById('root')).render(element));`;
const requests = ['pending', 'retrying', 'sent'].map((mailStatus, index) => ({
  id: 101 - index, companyId: index ? 31 : null, priceTitle: 'Индивидуальный прайс для клиента',
  clientName: 'Тестовая компания', token: 'synthetic', mailStatus, createdAt: '2026-10-19T09:40:00Z',
  totalQuantity: 2, totalPriceLabel: '20 EUR', totalConvertedRub: null, rubConversionInfo: '',
  convertedBreakdownLabel: '', comment: 'Тестовое уточнение сроков поставки',
  items: [{ priceItemId: 11, productTitle: 'Тестовый товар', model: 'Модель A', sku: 'TEST', variantTitle: '', quantity: 2,
    prices: [{ amount: 10, currency: 'EUR', lineTotal: 20, convertedRubAmount: null, convertedRubLineTotal: null }] }],
}));

async function main() {
  const root = path.resolve('.');
  const require = createRequire(path.join(root, 'package.json'));
  let runtime = process.env.PLAYWRIGHT_MODULE_PATH;
  if (!runtime) {
    try { runtime = path.dirname(require.resolve('playwright/package.json')); }
    catch { runtime = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
  }
  const playwright = await import(pathToFileURL(path.join(runtime, 'index.mjs')).href);
  const cssParts: string[] = [];
  const bundle = await build({ absWorkingDir: root, stdin: { contents: fixture, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', alias: { '@': path.join(root, 'src') },
    define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{ name: 'fixture-ui', setup(plugin) {
      plugin.onResolve({ filter: /^(next\/(link|navigation)|@\/shared\/lib\/(adminAuth|db\/clientPriceRequestsRepo))$/ },
        (args) => ({ path: args.path, namespace: 'fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents:
        args.path === 'next/link' ? 'import React from "react";export default function Link(props){return <a {...props}/>}'
          : args.path === 'next/navigation' ? 'export function redirect(){throw new Error("Unexpected redirect")}'
            : args.path.endsWith('/adminAuth') ? 'export async function getAdminSession(){return {role:"admin"}}'
              : `export async function getPriceRequestInbox(){return ${JSON.stringify({ requests, nextCursor: '77' })}}`,
      loader: 'jsx', resolveDir: root }));
      plugin.onLoad({ filter: /\.module\.scss$/ }, (args) => {
        const css = compile(args.path, { importers: [{ findFileUrl(url) { return url.startsWith('@/') ? pathToFileURL(path.join(root, 'src', url.slice(2))) : null; } }] }).css;
        const prefix = `f${cssParts.length}_`;
        const names = [...new Set([...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => match[1]))];
        const parsed = postcss.parse(css);
        parsed.walkRules((rule) => { rule.selector = rule.selector.replace(/\.([a-zA-Z_][\w-]*)/g, (_, name) => `.${prefix}${name}`); });
        cssParts.push(parsed.toString());
        return { contents: `export default ${JSON.stringify(Object.fromEntries(names.map((name) => [name, prefix + name])))};`, loader: 'js' };
      });
    } }],
  });
  const css = await readFile(path.join(root, 'src/app/globals.css'), 'utf8') + cssParts.join('\n');
  const output = await mkdtemp('/private/tmp/kts-price-request-inbox-');
  const server = createServer((request, response) => {
    if (request.url === '/app.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    else if (request.url === '/style.css') response.writeHead(200, { 'Content-Type': 'text/css' }).end(css);
    else response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (const engineName of ['chromium', 'webkit']) {
      const browser = await playwright[engineName].launch({ headless: true });
      try {
        for (const width of [1440, 390]) {
          const page = await browser.newPage({ viewport: { width, height: 1100 } }); page.setDefaultTimeout(10_000);
          const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message));
          await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          await page.goto(origin);
          await page.getByRole('heading', { name: 'Заявки из прайсов' }).waitFor();
          assert.equal(await page.getByRole('link', { name: 'Вернуться к прайсам' }).getAttribute('href'), '/admin/wholesale');
          assert.equal(await page.locator('details').count(), 3);
          await page.getByText(/Клиент:.*без привязки к компании/).waitFor();
          await page.getByText(/Почта временно недоступна/).waitFor();
          await page.locator('details summary').first().click();
          await page.getByText('Тестовое уточнение сроков поставки').first().waitFor();
          assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'), true);
          assert.ok(await page.locator('details h3').first().evaluate((heading: HTMLElement) => Number.parseFloat(getComputedStyle(heading).fontSize)) >= 14,
            'request titles stay readable on mobile instead of shrinking with desktop vw units');
          assert.deepEqual(errors, []);
          await page.screenshot({ path: path.join(output, `${engineName}-${width}.png`), fullPage: true });
          await page.close(); console.log('PASS', engineName, width);
        }
      } finally { await browser.close(); }
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  console.log('Screenshots:', output);
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
