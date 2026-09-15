/**
 * Optional isolated browser acceptance test for the actual management component.
 * node --import tsx tests/manager-dashboard-management.browser.integration.ts
 * Uses synthetic data and fake mutations only; never connects to production.
 * Serves only 127.0.0.1, blocks external browser requests, writes screenshots to /private/tmp.
 * PLAYWRIGHT_MODULE_PATH may point to the existing bundled Playwright installation.
 */
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import { compile } from 'sass';

type BrowserRoute = { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> };

const fixtureEntry = `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ManagerDashboardManagement } from './src/features/admin/manager-dashboard/ManagerDashboardManagement';
const date = '2026-09-15T08:00:00Z';
const makeVersion = (id, audience, suffix) => ({id, audience, originalName: audience + '_synthetic_dashboard_' + suffix + '.html', fileSize: 140000, createdAt: date, firstPublishedAt: date});
const supportMany = new URLSearchParams(location.search).get('support') === 'many';
const initial = {
  mode: 'manage', groups: ['development', 'support'].map((audience, index) => ({
    audience, activeHtmlVersionId: index ? (supportMany ? 11 : null) : 1, previousHtmlVersionId: index ? (supportMany ? 12 : null) : 2,
    htmlVersions: index ? (supportMany ? Array.from({length: 7}, (_, i) => makeVersion(11 + i, audience, 'history_' + i)) : [])
      : [makeVersion(1, audience, 'active'), makeVersion(2, audience, 'previous')],
    managers: [{id: index + 1, name: index ? 'Тестовый менеджер сопровождения' : 'Тестовый менеджер развития',
      email: audience + '.synthetic@example.test', bindingStatus: 'matched', isActive: true,
      snapshotStatus: 'current', snapshot: {id: index + 1, originalName: 'личный_снимок_Синтетический_Менеджер_' + audience + '_2026-09-15.ktsp', issued: '2026-09-15', expires: '2026-10-30', receivedAt: date}}]
  })),
  imports: Array.from({length: 5}, (_, i) => ({id: 13 - i, originalName: 'синтетический_снимок_журнала_' + (13 - i) + '.ktsp', status: 'imported', createdAt: date})),
  importsNextCursor: '9',
  mail: {enabled: true, configured: true}, expectedBy: '10:00 МСК', expectedIssuedAfter: '2026-09-15'
};
window.fixtureCalls = [];
window.fixtureFailDelete = false;
function Fixture() {
  const [overview, setOverview] = useState(initial);
  useEffect(() => {
    window.fixtureGrowSupport = () => setOverview(current => ({...current, groups: current.groups.map(group => group.audience === 'support' ? {...group, htmlVersions: Array.from({length: 7}, (_, i) => makeVersion(211 + i, 'support', 'dynamic_' + i))} : group)}));
    return () => {delete window.fixtureGrowSupport;};
  }, []);
  const mutate = async (requestPath, init, message) => {
    const call = {path: requestPath, method: init.method, message};
    if (init.body instanceof FormData) call.files = [...init.body.entries()].map(([field, file]) => ({field, name: file.name, size: file.size}));
    else if (init.body) call.body = JSON.parse(init.body);
    window.fixtureCalls.push(call);
    if (requestPath.startsWith('/html?') && init.method === 'DELETE') {
      if (window.fixtureFailDelete) return null;
      const params = new URL(requestPath, location.origin).searchParams;
      const audience = params.get('audience');
      const id = Number(params.get('id'));
      setOverview(current => ({...current, groups: current.groups.map(group => group.audience === audience ? {...group,
        previousHtmlVersionId: group.previousHtmlVersionId === id ? null : group.previousHtmlVersionId,
        htmlVersions: group.htmlVersions.filter(version => version.id !== id)} : group)}));
      return {message: 'Synthetic deletion succeeded'};
    }
    if (requestPath.startsWith('/html?')) {
      const audience = new URL(requestPath, location.origin).searchParams.get('audience');
      const version = {...makeVersion(audience === 'development' ? 101 : 111, audience, 'uploaded'), firstPublishedAt: null};
      setOverview(current => ({...current, groups: current.groups.map(group => group.audience === audience ? {...group, htmlVersions: [version, ...group.htmlVersions]} : group)}));
      return {version};
    }
    if (requestPath === '/publish') {
      const {audience, versionId} = call.body;
      setOverview(current => ({...current, groups: current.groups.map(group => group.audience === audience ? {...group, previousHtmlVersionId: group.activeHtmlVersionId, activeHtmlVersionId: versionId} : group)}));
    }
    return {results: []};
  };
  return <main id="fixture"><h1>Дашборды менеджеров</h1><ManagerDashboardManagement overview={overview} busy={false} mutate={mutate}/></main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;

async function main() {
  const root = path.resolve('.');
  const require = createRequire(path.join(root, 'package.json'));
  let modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
  if (!modulePath) {
    try { modulePath = path.dirname(require.resolve('playwright/package.json')); }
    catch { modulePath = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
  }
  const playwright = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href);
  const output = await mkdtemp('/private/tmp/kts-manager-dashboard-columns-');
  const styles = new Map<string, string>();
  const bundle = await build({
    absWorkingDir: root, stdin: {contents: fixtureEntry, resolveDir: root, loader: 'tsx'},
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: {'process.env.NODE_ENV': '"test"'}, alias: {'@': path.join(root, 'src')},
    plugins: [{name: 'synthetic-scss-modules', setup(plugin) {
      plugin.onLoad({filter: /\.module\.scss$/}, async (args) => {
        const css = compile(args.path).css;
        styles.set(args.path, css);
        const classNames = [...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => match[1]);
        return {contents: `export default ${JSON.stringify(Object.fromEntries(classNames.map((name) => [name, name])))};`, loader: 'js'};
      });
    }}],
  });
  const globals = await readFile(path.join(root, 'src/app/globals.css'), 'utf8');
  const css = `${globals}\n${[...styles.values()].join('\n')}\nhtml,body{overflow-x:visible} body{background:#f5f5f7} #fixture{max-width:1800px;padding:24px;margin:0 auto} #fixture>h1{font-size:28px;margin:0 0 28px} @media(max-width:760px){#fixture{padding:12px} #fixture>h1{font-size:24px}}`;
  const fonts = new Map<string, Buffer>();
  for (const match of globals.matchAll(/url\("(\/fonts\/[^"?]+)"\)/g)) {
    fonts.set(match[1], await readFile(path.join(root, 'public', match[1])));
  }
  const receivedFrames: string[] = [];
  const historyRequests: Array<{before: number; returned: number}> = [];
  // Only five rows are in the browser bundle. Remaining records exist solely in this HTTP stub.
  const history = Array.from({length: 13}, (_, i) => ({id: 13 - i, originalName: `синтетический_снимок_журнала_${13 - i}.ktsp`, status: 'imported', createdAt: '2026-09-15T08:00:00Z'}));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const headers = {'Cache-Control': 'no-store'};
    if (url.pathname === '/') response.writeHead(200, {...headers, 'Content-Type': 'text/html; charset=utf-8'}).end('<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
    else if (url.pathname === '/fixture.js') response.writeHead(200, {...headers, 'Content-Type': 'text/javascript'}).end(bundle.outputFiles[0].contents);
    else if (url.pathname === '/fixture.css') response.writeHead(200, {...headers, 'Content-Type': 'text/css'}).end(css);
    else if (fonts.has(url.pathname)) response.writeHead(200, {...headers, 'Content-Type': 'font/woff2'}).end(fonts.get(url.pathname));
    else if (url.pathname === '/api/admin/manager-dashboard/imports') {
      const before = Number(url.searchParams.get('before'));
      if (request.method !== 'GET' || !Number.isSafeInteger(before) || before <= 0) {
        historyRequests.push({before, returned: 0});
        response.writeHead(400, headers).end();
        return;
      }
      const remaining = history.filter((item) => item.id < before);
      const imports = remaining.slice(0, 5);
      const nextCursor = remaining.length > imports.length ? String(imports.at(-1)?.id) : null;
      historyRequests.push({before, returned: imports.length});
      response.writeHead(200, {...headers, 'Content-Type': 'application/json'}).end(JSON.stringify({imports, nextCursor}));
    }
    else if (url.pathname === '/api/admin/manager-dashboard/frame') {
      receivedFrames.push(url.search);
      response.writeHead(200, {...headers, 'Content-Type': 'text/html; charset=utf-8'}).end('<!doctype html><html lang="ru"><meta charset="utf-8"><body style="font-family:system-ui;padding:30px;background:#f2f0fb"><h1>Синтетический предпросмотр HTML</h1><p>Только тестовая рамка — личные данные отсутствуют.</p></body></html>');
    } else response.writeHead(404, headers).end();
  });
  let enginesTested = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {server.off('error', reject); resolve();});
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const engineName of ['chromium', 'webkit']) {
      const engine = playwright[engineName];
      try { await access(engine.executablePath()); }
      catch { console.log(`SKIP ${engineName}: browser executable is not installed.`); continue; }
      const browser = await engine.launch({headless: true});
      enginesTested += 1;
      try {
        for (const width of [1440, 390]) {
          const context = await browser.newContext({viewport: {width, height: 1000}, timezoneId: 'Europe/Moscow'});
          const external: string[] = [];
          const errors: string[] = [];
          await context.route('**/*', async (route: BrowserRoute) => {
            const url = new URL(route.request().url());
            if (url.origin === origin) await route.continue();
            else {external.push(url.origin); await route.abort();}
          });
          const page = await context.newPage();
          page.on('pageerror', (error: Error) => errors.push(error.message));
          let acceptConfirmation = true;
          const confirmations: string[] = [];
          page.on('dialog', (dialog: {accept(): Promise<void>; dismiss(): Promise<void>; message(): string}) => {
            confirmations.push(dialog.message());
            void (acceptConfirmation ? dialog.accept() : dialog.dismiss());
          });
          page.setDefaultTimeout(7000);
          try {
            const pageHistoryStart = historyRequests.length;
            await page.goto(origin);
            await page.locator('#manager-dashboard-group-support').waitFor({state: 'visible'});
            await page.evaluate(() => document.fonts.ready);
            assert.equal(await page.getByRole('tab').count(), 0, 'no audience tabs remain');
            for (const audience of ['development', 'support']) {
              assert.equal(await page.locator(`#manager-dashboard-heading-${audience}`).isVisible(), true);
              assert.equal(await page.locator(`#manager-dashboard-html-${audience}`).isVisible(), true);
            }
            assert.equal(await page.locator('input[type=file]').count(), 3, 'two independent HTML uploads plus one shared snapshot input');
            assert.equal(await page.getByRole('button', {name: 'Проверить почту сейчас', exact: true}).count(), 1);
            assert.equal(await page.getByRole('heading', {name: 'Общая загрузка личных файлов', exact: true}).count(), 1);
            assert.equal(await page.getByRole('heading', {name: 'Журнал импорта', exact: true}).count(), 1);
            const journal = page.locator('#manager-dashboard-import-journal');
            assert.equal(await journal.locator('li').count(), 5, 'initial journal contains only five supplied rows');
            const assertPanelAlignment = async (scenario: string) => {
              // WebKit applies viewport changes asynchronously; allow layout and ResizeObserver to settle.
              await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
              if (width > 1000) await page.waitForFunction(() => {
                const left = document.getElementById('manager-dashboard-html-panel-development')?.getBoundingClientRect();
                const right = document.getElementById('manager-dashboard-html-panel-support')?.getBoundingClientRect();
                const leftManagers = document.getElementById('manager-dashboard-files-development')?.getBoundingClientRect();
                const rightManagers = document.getElementById('manager-dashboard-files-support')?.getBoundingClientRect();
                return left && right && leftManagers && rightManagers && Math.abs(left.height - right.height) < 2 && Math.abs(leftManagers.y - rightManagers.y) < 2;
              });
              else await page.waitForFunction(() => ['development', 'support'].every((audience) => {
                const panel = document.getElementById(`manager-dashboard-html-panel-${audience}`);
                const inner = panel?.lastElementChild;
                return panel && inner && panel.getBoundingClientRect().bottom - inner.getBoundingClientRect().bottom <= 40;
              }));
              const layout = await page.evaluate(() => ['development', 'support'].map((audience) => {
                const html = document.getElementById(`manager-dashboard-html-panel-${audience}`);
                const managers = document.getElementById(`manager-dashboard-files-${audience}`);
                if (!html || !managers) throw new Error('Synthetic panels missing');
                const htmlBox = html.getBoundingClientRect();
                const managersBox = managers.getBoundingClientRect();
                const contentEnd = html.lastElementChild?.getBoundingClientRect().bottom ?? htmlBox.bottom;
                return {htmlTop: htmlBox.y, htmlHeight: htmlBox.height, managersTop: managersBox.y, gapAfterHtml: managersBox.y - htmlBox.bottom, innerBottomSpace: htmlBox.bottom - contentEnd};
              }));
              if (width > 1000) {
                assert.ok(Math.abs(layout[0].htmlHeight - layout[1].htmlHeight) < 2, `${scenario}: desktop HTML panels share the taller height`);
                assert.ok(Math.abs(layout[0].htmlTop - layout[1].htmlTop) < 2, `${scenario}: desktop HTML panels begin together`);
                assert.ok(Math.abs(layout[0].managersTop - layout[1].managersTop) < 2, `${scenario}: manager panels begin together`);
              } else {
                assert.ok(Math.abs(layout[0].htmlHeight - layout[1].htmlHeight) > 40, `${scenario}: mobile HTML panels retain their own natural heights`);
                for (const column of layout) {
                  assert.ok(column.gapAfterHtml >= 12 && column.gapAfterHtml <= 28, `${scenario}: no blank alignment gap before mobile managers`);
                  assert.ok(column.innerBottomSpace <= 40, `${scenario}: shorter mobile HTML panel is not stretched to the other group (${JSON.stringify(column)})`);
                }
              }
            };
            await assertPanelAlignment('development two versions / support empty');
            const development = await page.locator('#manager-dashboard-group-development').boundingBox();
            const support = await page.locator('#manager-dashboard-group-support').boundingBox();
            assert.ok(development && support);
            if (width > 1000) {
              assert.ok(Math.abs(development.y - support.y) < 2, 'desktop groups are side by side');
              assert.ok(support.x >= development.x + development.width, 'support is to the right');
            } else {
              assert.ok(support.y >= development.y + development.height, 'mobile groups are stacked');
              assert.ok(Math.abs(support.x - development.x) < 2);
              assert.equal(await page.locator('.audienceColumn .sectionHeading > div').evaluateAll((elements: Element[]) => elements.every((element) => {
                const last = element.lastElementChild;
                return last && element.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom <= 4;
              })), true, 'mobile column headings must not retain a desktop flex-basis as blank vertical space');
            }
            const shared = await page.getByRole('heading', {name: 'Общая загрузка личных файлов', exact: true}).boundingBox();
            assert.ok(shared && shared.y > Math.max(development.y + development.height, support.y + support.height), 'common upload follows both groups');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no page horizontal overflow');
            await page.screenshot({path: path.join(output, `${engineName}-${width}-columns.png`), fullPage: true});

            assert.equal(historyRequests.length, pageHistoryStart, 'journal must not download further records before a click');
            await journal.getByRole('button', {name: /Показать ещё/}).click();
            await page.waitForFunction(() => document.querySelectorAll('#manager-dashboard-import-journal li').length === 10);
            assert.deepEqual(historyRequests.slice(pageHistoryStart), [{before: 9, returned: 5}], 'first click fetches only the next five records');
            await journal.getByRole('button', {name: /Показать ещё/}).click();
            await page.waitForFunction(() => document.querySelectorAll('#manager-dashboard-import-journal li').length === 13);
            assert.deepEqual(historyRequests.slice(pageHistoryStart), [{before: 9, returned: 5}, {before: 4, returned: 3}], 'second click fetches only the final three records');
            assert.equal(await journal.getByRole('button', {name: /Показать ещё/}).count(), 0, 'end of history has no further loading control');
            const importNames = await journal.locator('li strong').allTextContents();
            assert.equal(new Set(importNames).size, 13, 'pagination has no duplicated records');
            assert.deepEqual(importNames, history.map((item) => item.originalName), 'journal remains newest first across page boundaries');
            await journal.screenshot({path: path.join(output, `${engineName}-${width}-journal-13.png`)});

            // Both selectors remain populated independently, even after submitting the other group.
            for (const audience of ['development', 'support']) await page.locator(`#manager-dashboard-html-${audience}`).setInputFiles({name: `${audience}.html`, mimeType: 'text/html', buffer: Buffer.from('<!doctype html><h1>Synthetic</h1>')});
            for (const audience of ['development', 'support']) {
              const id = audience === 'development' ? 101 : 111;
              await page.locator(`#manager-dashboard-group-${audience}`).getByRole('button', {name: 'Загрузить черновик', exact: true}).click();
              await page.waitForFunction((expected: string) => Array.from(document.querySelectorAll('iframe')).some((frame) => frame.src.includes(expected)), `version=${id}`);
              if (audience === 'development') assert.equal(await page.locator('#manager-dashboard-html-support').evaluate((input: HTMLInputElement) => input.files?.[0]?.name), 'support.html', 'uploading development must not clear the support file');
              const preview = page.locator('#manager-dashboard-html-preview');
              assert.equal(await preview.locator('iframe').count(), 1);
              assert.equal(await preview.evaluate((element: Element) => element.closest('.audienceGrid') === null), true, 'preview is outside the two-column grid');
              const previewBox = await preview.boundingBox();
              const gridBox = await page.locator('.audienceGrid').boundingBox();
              assert.ok(previewBox && gridBox && Math.abs(previewBox.width - gridBox.width) < 2, 'preview spans full grid width');
              const frameSource = await preview.locator('iframe').getAttribute('src');
              assert.ok(frameSource?.includes(`audience=${audience}`) && frameSource.includes('preview=1'));
              if (audience === 'support') await page.screenshot({path: path.join(output, `${engineName}-${width}-preview.png`), fullPage: true});
              await page.locator(`#manager-dashboard-group-${audience}`).getByRole('button', {name: 'Опубликовать группе', exact: true}).click();
              await page.waitForFunction((expected: number) => (window as unknown as {fixtureCalls: Array<{path: string; body?: {versionId: number}}>}).fixtureCalls.some((call) => call.path === '/publish' && call.body?.versionId === expected), id);
            }
            await page.locator('#manager-dashboard-snapshots').setInputFiles([
              {name: 'development.ktsp', mimeType: 'application/json', buffer: Buffer.from('synthetic development')},
              {name: 'support.ktsp', mimeType: 'application/json', buffer: Buffer.from('synthetic support')},
            ]);
            await page.getByRole('button', {name: 'Загрузить файлы', exact: true}).click();
            await page.getByRole('button', {name: 'Проверить почту сейчас', exact: true}).click();
            const calls = await page.evaluate('window.fixtureCalls');
            assert.deepEqual(calls.map((call: {path: string}) => call.path), ['/html?audience=development', '/publish', '/html?audience=support', '/publish', '/snapshots', '/check-email']);
            assert.deepEqual(calls[1].body, {audience: 'development', versionId: 101, expectedActiveVersionId: 1});
            assert.deepEqual(calls[3].body, {audience: 'support', versionId: 111, expectedActiveVersionId: null});
            assert.deepEqual(calls[4].files.map((file: {name: string}) => file.name), ['development.ktsp', 'support.ktsp']);

            // Deletion is exercised through actual controls and browser dialogs;
            // the synthetic mutation never connects to a real API or removes files.
            const developmentPanel = page.locator('#manager-dashboard-group-development');
            const supportPanel = page.locator('#manager-dashboard-group-support');
            const oldRow = developmentPanel.locator('.versionsTable tbody tr').filter({hasText: 'development_synthetic_dashboard_previous.html'});
            const deleteOld = oldRow.getByRole('button', {name: /^Удалить HTML/});
            assert.equal(await supportPanel.getByRole('button', {name: /^Удалить HTML/}).isDisabled(), true, 'published support version cannot be deleted');
            await oldRow.getByRole('button', {name: 'Предпросмотр', exact: true}).click();
            const previewFrame = page.locator('#manager-dashboard-html-preview iframe');
            await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#manager-dashboard-html-preview iframe')?.src.includes('version=2'));
            const deleteCallCount = () => page.evaluate(() => (window as unknown as {fixtureCalls: Array<{method: string}>}).fixtureCalls.filter(call => call.method === 'DELETE').length);
            acceptConfirmation = false;
            await deleteOld.click();
            assert.equal(await deleteCallCount(), 0, 'cancelled deletion sends no mutation');
            assert.equal(await oldRow.count(), 1);
            assert.ok((await previewFrame.getAttribute('src'))?.includes('version=2'), 'cancel preserves the open preview');
            const deletionConfirmation = confirmations.at(-1)!;
            assert.match(deletionConfirmation, /development_synthetic_dashboard_previous\.html/);
            assert.match(deletionConfirmation, /#2/);
            assert.match(deletionConfirmation, /Менеджеры по развитию/);
            assert.match(deletionConfirmation, /необратим/);
            acceptConfirmation = true;
            await page.evaluate('window.fixtureFailDelete = true');
            await deleteOld.click();
            assert.equal(await deleteCallCount(), 1);
            assert.equal(await oldRow.count(), 1, 'failed mutation keeps the version');
            assert.ok((await previewFrame.getAttribute('src'))?.includes('version=2'), 'failed deletion preserves the open preview');
            await page.evaluate('window.fixtureFailDelete = false');
            await deleteOld.click();
            await oldRow.waitFor({state: 'detached'});
            await previewFrame.waitFor({state: 'detached'});
            assert.equal(await deleteCallCount(), 2, 'retry issues one further mutation');
            assert.equal(await supportPanel.locator('.versionsTable tbody tr').count(), 1, 'development deletion does not remove support HTML');
            for (const audience of ['development', 'support']) assert.equal(await page.locator(`#manager-dashboard-files-${audience} tbody tr`).count(), 1, 'personal snapshot rows remain');
            await assertPanelAlignment('deleting an archived version shrinks both desktop HTML panels');
            await supportPanel.getByRole('button', {name: 'Предпросмотр', exact: true}).click();
            const previousRow = developmentPanel.locator('.versionsTable tbody tr').filter({hasText: 'development_synthetic_dashboard_active.html'});
            await previousRow.getByRole('button', {name: /^Удалить HTML/}).click();
            await previousRow.waitFor({state: 'detached'});
            assert.ok((await previewFrame.getAttribute('src'))?.includes('audience=support'), 'deleting another group does not close the support preview');
            const deleteCalls = await page.evaluate(() => (window as unknown as {fixtureCalls: Array<{path: string; method: string}>}).fixtureCalls.filter(call => call.method === 'DELETE'));
            assert.deepEqual(deleteCalls.map((call: {path: string}) => call.path), ['/html?audience=development&id=2', '/html?audience=development&id=2', '/html?audience=development&id=1']);
            assert.deepEqual(errors, [], 'no browser script errors');
            assert.deepEqual(external, [], 'no external requests');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mutations and preview do not introduce horizontal overflow');
            await page.evaluate('window.fixtureGrowSupport()');
            await page.locator('#manager-dashboard-group-support .versionsTable tbody tr').nth(6).waitFor({state: 'visible'});
            await assertPanelAlignment('support grows dynamically after render');
            await page.goto(`${origin}/?support=many`);
            await page.locator('#manager-dashboard-group-support .versionsTable tbody tr').nth(6).waitFor({state: 'visible'});
            await page.evaluate(() => document.fonts.ready);
            await assertPanelAlignment('development two versions / support seven versions');
            await page.setViewportSize({width: width > 1000 ? 1280 : 430, height: 1000});
            await assertPanelAlignment('resize with asymmetric content');
            await page.setViewportSize({width, height: 1000});
            await page.evaluate(() => {document.body.style.fontFamily = 'Arial, sans-serif';});
            await assertPanelAlignment('font metrics change with asymmetric content');
            await page.evaluate(() => {document.body.style.fontFamily = '';});
            await assertPanelAlignment('original font metrics restored');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'a longer right panel does not introduce horizontal overflow');
            assert.equal(await page.locator('#manager-dashboard-import-journal li').count(), 5, 'fresh initial response remains bounded to five rows');
            await page.screenshot({path: path.join(output, `${engineName}-${width}-support-taller.png`), fullPage: true});
            console.log(`PASS ${engineName}/${width}: aligned asymmetric groups, natural mobile heights, isolated uploads/publication/deletion, delete cancellation/retry/preview scope, journal 5+5+3, full-width preview, no overflow.`);
          } finally {await context.close();}
        }
      } finally {await browser.close();}
    }
    assert.ok(enginesTested > 0, 'at least one browser engine must be installed');
    assert.ok(receivedFrames.length > 0, 'the actual DashboardFrame requested the synthetic preview route');
    console.log(`Screenshots: ${output}`);
  } finally {await new Promise<void>((resolve) => server.close(() => resolve()));}
}

main().catch((error: unknown) => {console.error(error); process.exitCode = 1;});
