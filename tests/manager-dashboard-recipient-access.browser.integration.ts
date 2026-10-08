/**
 * Real personal management + audience editor, synthetic HTTP API only.
 * node --import tsx tests/manager-dashboard-recipient-access.browser.integration.ts
 * Serves 127.0.0.1, blocks external requests, screenshots go to /private/tmp.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import postcss from 'postcss';
import { compile } from 'sass';

import type { ManagerDashboardGroup } from '../src/features/admin/manager-dashboard/types';

type Audience = 'development' | 'support';
type Route = { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> };
type FixtureEmployee = ManagerDashboardGroup['managers'][number] & { checked: boolean; eligible: boolean; role: string };
type FixtureState = {
  audience: Audience;
  employees: FixtureEmployee[];
  revision: number;
  overviewReads: number;
  failedSaves: number;
  failOverviewOnce: boolean;
  failSaveOnce: boolean;
  requests: Array<{ path: string; method: string }>;
  saves: Array<{ key: string; userIds: string[]; version: string; mode: string }>;
};

const date = '2026-10-08T06:00:00Z';
const fixtureEntry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {ManagerDashboard} from './src/features/admin/manager-dashboard/ManagerDashboard';
const audience = new URLSearchParams(location.search).get('audience');
createRoot(document.getElementById('root')).render(<ManagerDashboard mode="manage" audience={audience} canAssignAccess />);
`;

function newState(audience: Audience): FixtureState {
  const role = audience === 'development' ? 'manager' : 'support_manager';
  return {
    audience, revision: 1, overviewReads: 0, failedSaves: 0,
    failOverviewOnce: false, failSaveOnce: false, requests: [], saves: [],
    employees: [
      { id: 1, name: 'Первый тестовый сотрудник', email: 'first@example.test', role, isActive: true, eligible: true, checked: true,
        bindingStatus: 'matched', snapshotStatus: 'current', snapshot: { id: 101, originalName: 'первый_сохранённый_снимок.ktsp', issued: '2026-10-08', expires: '2099-12-31', receivedAt: date } },
      { id: 2, name: 'Второй тестовый сотрудник', email: 'second@example.test', role, isActive: true, eligible: true, checked: true,
        bindingStatus: 'matched', snapshotStatus: 'current', snapshot: { id: 102, originalName: 'второй_сохранённый_снимок.ktsp', issued: '2026-10-08', expires: '2099-12-31', receivedAt: date } },
      { id: 3, name: 'Неактивный тестовый сотрудник', email: 'inactive@example.test', role, isActive: false, eligible: true, checked: true,
        bindingStatus: 'matched', snapshotStatus: 'missing', snapshot: null },
      { id: 4, name: 'Тестовый сотрудник другой группы', email: 'other@example.test', role: audience === 'development' ? 'support_manager' : 'manager',
        isActive: true, eligible: false, checked: false, bindingStatus: 'matched', snapshotStatus: 'missing', snapshot: null },
    ],
  };
}

function accessPayload(state: FixtureState) {
  return {
    key: `manager:${state.audience}`, mode: 'individual', version: `revision-${state.revision}`,
    users: state.employees.map(({ id, name, email, role, isActive, checked, eligible }) => ({
      id: `manager:${id}`, name, login: email, role, isActive, checked, eligible, locked: false,
    })),
  };
}

function overviewPayload(state: FixtureState) {
  return {
    mode: 'manage', expectedIssuedAfter: '2026-10-08', expectedBy: '10:00 МСК', imports: [], importsNextCursor: null,
    groups: (['development', 'support'] as const).map(audience => ({
      audience, activeHtmlVersionId: 10, previousHtmlVersionId: null,
      htmlVersions: [{ id: 10, audience, originalName: `${audience}_synthetic.html`, fileSize: 1000, createdAt: date, firstPublishedAt: date }],
      managers: audience !== state.audience ? [] : state.employees.filter(employee => employee.isActive && employee.eligible && employee.checked)
        .map(({ id, name, email, isActive, bindingStatus, snapshot, snapshotStatus }) => ({ id, name, email, isActive, bindingStatus, snapshot, snapshotStatus })),
    })),
  };
}

async function main() {
  const root = path.resolve('.');
  const require = createRequire(path.join(root, 'package.json'));
  let modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
  if (!modulePath) {
    try { modulePath = path.dirname(require.resolve('playwright/package.json')); }
    catch { modulePath = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
  }
  const playwright = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href);
  const screenshots = await mkdtemp('/private/tmp/kts-recipient-access-ui-');
  const styles = new Map<string, string>();
  const bundle = await build({
    stdin: { contents: fixtureEntry, resolveDir: root, loader: 'tsx' }, absWorkingDir: root,
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { '@': path.join(root, 'src') }, define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'fixture-components', setup(plugin) {
      plugin.onResolve({ filter: /^next\/(navigation|link)$/ }, args => ({ path: args.path, namespace: 'fixture-next' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fixture-next' }, args => ({ contents: args.path === 'next/navigation'
        ? 'const router={replace(path){window.fixtureRedirect=path}}; export function useRouter(){return router}'
        : 'import React from "react"; export default function Link({children,...props}){return React.createElement("a",props,children)}', loader: 'js', resolveDir: root }));
      plugin.onLoad({ filter: /\.module\.scss$/ }, args => {
        const css = compile(args.path, { importers: [{ findFileUrl(url) {
          return url.startsWith('@/') ? pathToFileURL(path.join(root, 'src', url.slice(2))) : null;
        } }] }).css;
        const names = [...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map(match => match[1]);
        const prefix = `fixture${styles.size}_`;
        const parsed = postcss.parse(css);
        parsed.walkRules(rule => { rule.selector = rule.selector.replace(/\.([a-zA-Z_][\w-]*)/g, (_, name) => `.${prefix}${name}`); });
        styles.set(args.path, parsed.toString());
        return { contents: `export default ${JSON.stringify(Object.fromEntries(names.map(name => [name, prefix + name])))};`, loader: 'js' };
      });
    } }],
  });
  const globals = await readFile(path.join(root, 'src/app/globals.css'), 'utf8');
  const css = globals + '\n' + [...styles].sort(([a], [b]) => Number(a.endsWith('/admin.module.scss')) - Number(b.endsWith('/admin.module.scss')))
    .map(([, style]) => style).join('\n');
  const fonts = new Map<string, Buffer>();
  for (const match of globals.matchAll(/url\("(\/fonts\/[^"?]+)"\)/g)) fonts.set(match[1], await readFile(path.join(root, 'public', match[1])));
  let state = newState('development');
  const unexpected: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const headers = { 'Cache-Control': 'no-store' };
    const json = (status: number, payload: unknown) => response.writeHead(status, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
    if (url.pathname === '/') return void response.writeHead(200, { ...headers, 'Content-Type': 'text/html;charset=utf-8' }).end('<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
    if (url.pathname === '/fixture.js') return void response.writeHead(200, { ...headers, 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    if (url.pathname === '/fixture.css') return void response.writeHead(200, { ...headers, 'Content-Type': 'text/css' }).end(css);
    if (fonts.has(url.pathname)) return void response.writeHead(200, { ...headers, 'Content-Type': 'font/woff2' }).end(fonts.get(url.pathname));
    if (url.pathname === '/favicon.ico') return void response.writeHead(204).end();
    state.requests.push({ path: url.pathname, method: request.method ?? 'GET' });
    if (url.pathname === '/api/admin/manager-dashboard' && request.method === 'GET') {
      state.overviewReads += 1;
      if (state.failOverviewOnce) {
        state.failOverviewOnce = false;
        return void json(503, { error: 'Тестовый отказ обновления списка.' });
      }
      return void json(200, overviewPayload(state));
    }
    if (url.pathname === '/api/admin/dashboard-access' && request.method === 'GET') {
      assert.equal(url.searchParams.get('key'), `manager:${state.audience}`);
      return void json(200, accessPayload(state));
    }
    if (url.pathname === '/api/admin/dashboard-access' && request.method === 'PUT') {
      let raw = '';
      for await (const chunk of request) raw += chunk.toString();
      const body = JSON.parse(raw);
      assert.deepEqual(Object.keys(body).sort(), ['key', 'mode', 'userIds', 'version']);
      assert.equal(body.key, `manager:${state.audience}`);
      assert.equal(body.version, `revision-${state.revision}`);
      if (state.failSaveOnce) {
        state.failSaveOnce = false;
        state.failedSaves += 1;
        return void json(503, { error: 'Тестовый отказ сохранения доступов.' });
      }
      state.saves.push(body);
      state.revision += 1;
      for (const employee of state.employees) employee.checked = employee.eligible && body.userIds.includes(`manager:${employee.id}`);
      return void json(200, accessPayload(state));
    }
    unexpected.push(`${request.method} ${url.pathname}`);
    response.writeHead(404).end();
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const engine of ['chromium', 'webkit']) {
      const browser = await playwright[engine].launch({ headless: true });
      try {
        for (const width of [1440, 390]) {
          for (const audience of ['development', 'support'] as const) {
            state = newState(audience);
            const storedSnapshots = structuredClone(state.employees.map(employee => employee.snapshot));
            const context = await browser.newContext({ viewport: { width, height: 1000 } });
            const external: string[] = [];
            await context.route('**/*', async (route: Route) => {
              if (new URL(route.request().url()).origin === origin) await route.continue();
              else { external.push(route.request().url()); await route.abort(); }
            });
            try {
              const page = await context.newPage();
              const errors: string[] = [];
              page.on('pageerror', (error: Error) => errors.push(error.message));
              await page.goto(`${origin}/?audience=${audience}`);
              const panel = page.locator(`#manager-dashboard-files-${audience}`);
              const editor = page.locator(`#manager-dashboard-html-panel-${audience}`).locator('section').filter({ has: page.getByRole('heading', { name: 'Кому доступен отчёт', exact: true }) });
              const first = editor.getByRole('checkbox', { name: /Первый тестовый сотрудник/ });
              const second = editor.getByRole('checkbox', { name: /Второй тестовый сотрудник/ });
              const save = editor.getByRole('button', { name: 'Сохранить доступы', exact: true });
              await first.waitFor();
              assert.equal(await panel.locator('tbody tr').count(), 2);
              assert.match(await panel.innerText(), /Менеджеров: 2/);
              assert.doesNotMatch(await panel.innerText(), /Неактивный тестовый|другой группы/);
              assert.equal(await editor.getByRole('checkbox', { name: /Неактивный тестовый/ }).count(), 1, 'access editor retains inactive accounts');
              assert.equal(await editor.getByRole('checkbox', { name: /другой группы/ }).isDisabled(), true);
              const htmlInput = page.locator(`#manager-dashboard-html-${audience}`);
              await htmlInput.setInputFiles({ name: 'неотправленный_черновик.html', mimeType: 'text/html', buffer: Buffer.from('<!doctype html><title>Synthetic draft</title>') });

              await first.uncheck();
              assert.equal(await panel.locator('tbody tr').count(), 2, 'draft checkbox changes do not hide rows before saving');
              const initialReads = state.overviewReads;
              await save.click();
              await editor.getByRole('status').filter({ hasText: /^Доступы сохранены\.$/ }).waitFor();
              assert.equal(state.overviewReads, initialReads + 1, 'successful save reloads overview');
              assert.equal(await panel.locator('tbody tr').count(), 1);
              assert.match(await panel.innerText(), /Менеджеров: 1/);
              assert.doesNotMatch(await panel.innerText(), /Первый тестовый|первый_сохранённый/);
              assert.equal(await first.count(), 1, 'excluded employee remains available to re-enable in the editor');
              assert.equal(await first.isChecked(), false);
              assert.equal(await htmlInput.evaluate((input: HTMLInputElement) => input.files?.[0]?.name), 'неотправленный_черновик.html', 'refresh preserves an unsent HTML selection');

              await first.check();
              await save.click();
              await editor.getByRole('status').filter({ hasText: /^Доступы сохранены\.$/ }).waitFor();
              assert.equal(await panel.locator('tbody tr').count(), 2);
              assert.match(await panel.innerText(), /Менеджеров: 2/);
              assert.match(await panel.innerText(), /первый_сохранённый_снимок.ktsp/);
              assert.deepEqual(state.employees.map(employee => employee.snapshot), storedSnapshots, 'revocation and return never mutate stored snapshots');

              state.failSaveOnce = true;
              const readsBeforeFailure = state.overviewReads;
              await second.uncheck();
              await save.click();
              await editor.getByRole('status').filter({ hasText: 'Тестовый отказ сохранения доступов.' }).waitFor();
              assert.equal(state.failedSaves, 1);
              assert.equal(state.overviewReads, readsBeforeFailure, 'failed PUT never reloads the recipient overview');
              assert.equal(await panel.locator('tbody tr').count(), 2);
              assert.match(await panel.innerText(), /Менеджеров: 2/);
              assert.equal(state.employees[1].checked, true);

              state.failOverviewOnce = true;
              await save.click();
              await editor.getByRole('status').filter({ hasText: 'Доступы сохранены, но список личных файлов не удалось обновить.' }).waitFor();
              assert.equal(state.employees[1].checked, false, 'PUT succeeded even when the following overview read failed');
              assert.equal(await panel.locator('tbody tr').count(), 2, 'failed reload does not pretend old table has refreshed');
              assert.equal(await second.isChecked(), false);
              await page.getByRole('alert').filter({ hasText: 'Тестовый отказ обновления списка.' }).waitFor();
              await page.getByRole('button', { name: 'Обновить', exact: true }).click();
              await panel.getByText('Менеджеров: 1', { exact: true }).waitFor();
              assert.equal(await panel.locator('tbody tr').count(), 1);
              assert.doesNotMatch(await panel.innerText(), /Второй тестовый/);

              await first.uncheck();
              await save.click();
              await editor.getByRole('status').filter({ hasText: /^Доступы сохранены\.$/ }).waitFor();
              assert.equal(await panel.locator('tbody tr').count(), 0);
              assert.match(await panel.innerText(), /Менеджеров: 0/);
              assert.match(await panel.innerText(), /нет активных сотрудников с доступом/i, 'empty state explains access filtering, not employee deletion');
              assert.equal(await first.count(), 1);
              assert.equal(await second.count(), 1);
              await first.check();
              await save.click();
              await editor.getByRole('status').filter({ hasText: /^Доступы сохранены\.$/ }).waitFor();
              assert.match(await panel.innerText(), /первый_сохранённый_снимок.ktsp/);
              assert.deepEqual(state.employees.map(employee => employee.snapshot), storedSnapshots);
              assert.equal(await page.locator('iframe').count(), 0, 'MR/MS preview is not automatically moved or opened');
              assert.ok(state.requests.every(request => request.method === 'GET' || request.method === 'PUT' && request.path === '/api/admin/dashboard-access'), 'no snapshot, account, publication or pricing mutation');
              assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'layout remains within viewport');
              assert.deepEqual(errors, [], 'real management/access components have no browser errors');
              assert.deepEqual(external, [], 'no customer or external service requests');
              await panel.screenshot({ path: path.join(screenshots, `${engine}-${width}-${audience}-recipients.png`) });
              await editor.screenshot({ path: path.join(screenshots, `${engine}-${width}-${audience}-access.png`) });
              console.log(`PASS ${engine}/${width}/${audience}: save refresh, counters, re-enable, unchanged snapshots/upload choice, PUT failure, reload failure/recovery and empty state.`);
            } finally { await context.close(); }
          }
        }
      } finally { await browser.close(); }
    }
    assert.deepEqual(unexpected, [], 'only expected synthetic endpoints were requested');
    console.log(`Screenshots: ${screenshots}`);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
