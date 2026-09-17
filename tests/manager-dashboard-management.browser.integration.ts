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
import postcss from 'postcss';
import { compile } from 'sass';

type BrowserRoute = { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> };

const fixtureEntry = `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ManagerDashboardManagement } from './src/features/admin/manager-dashboard/ManagerDashboardManagement';
import { ManagerDashboard } from './src/features/admin/manager-dashboard/ManagerDashboard';
import adminStyles from './src/app/admin/admin.module.scss';
import dashboardStyles from './src/features/admin/manager-dashboard/ManagerDashboard.module.scss';
const date = '2026-09-15T08:00:00Z';
const makeVersion = (id, audience, suffix) => ({id, audience, originalName: audience + '_synthetic_dashboard_' + suffix + '.html', fileSize: 140000, createdAt: date, firstPublishedAt: date});
const requestedAudience = new URLSearchParams(location.search).get('audience');
const managementAudience = ['development', 'support'].includes(requestedAudience) ? requestedAudience : null;
const supportMany = new URLSearchParams(location.search).get('support') === 'many';
const sharedSnapshot = {id: 301, originalName: 'общий_файл.ktsp', email: 'shared.synthetic@example.test', issued: '2026-09-15', expires: '2999-10-30', receivedAt: date};
const sharedInitial = {
  htmlVersions: [makeVersion(201, 'support', 'shared_active'), makeVersion(202, 'support', 'shared_previous')],
  activeHtmlVersionId: 201, previousHtmlVersionId: 202, snapshot: sharedSnapshot,
  history: [sharedSnapshot, {...sharedSnapshot, id: 300, originalName: 'общий_архив.ktsp'}]
};
const jsonMode = new URLSearchParams(location.search).has('json');
const jsonMissing = new URLSearchParams(location.search).get('json') === 'empty';
const sharedJsonSnapshot = {id: 501, htmlVersionId: 201, originalName: 'общий_компоновщик.json', fileSize: 400,
  savedAt: date, receivedAt: date, status: 'active', sha256: 'a'.repeat(64)};
if (jsonMode) {
  sharedInitial.htmlVersions = sharedInitial.htmlVersions.map(version => ({...version, format: 'route-planner-v1'}));
  sharedInitial.jsonSnapshot = jsonMissing ? null : sharedJsonSnapshot;
  sharedInitial.jsonHistory = jsonMissing ? [] : [sharedJsonSnapshot, {...sharedJsonSnapshot, id: 500, originalName: 'архив_компоновщик.json', status: 'previous'}];
}
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
  supportShared: sharedInitial,
  mail: {enabled: true, configured: true}, expectedBy: '10:00 МСК', expectedIssuedAfter: '2026-09-15'
};
window.fixtureCalls = [];
window.fixtureFailDelete = false;
const viewerAudience = new URLSearchParams(location.search).get('view');
window.fixtureViewerOverview = {
  mode: 'view', audience: viewerAudience === 'development' ? 'development' : 'support',
  bindingStatus: 'matched', email: 'support.synthetic@example.test',
  htmlVersion: makeVersion(11, 'support', 'personal'),
  snapshot: {...sharedSnapshot, id: 401, originalName: 'личный_файл.ktsp'},
  history: [{...sharedSnapshot, id: 401, originalName: 'личный_файл.ktsp'}, {...sharedSnapshot, id: 400, originalName: 'личный_архив.ktsp'}],
  supportShared: sharedInitial
};
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => input === '/api/admin/manager-dashboard'
  ? new Response(JSON.stringify(window.fixtureViewerOverview), {status: 200, headers: {'Content-Type': 'application/json'}})
  : originalFetch(input, init);
function Fixture() {
  const [overview, setOverview] = useState(initial);
  useEffect(() => {
    window.fixtureGrowSupport = () => setOverview(current => ({...current, groups: current.groups.map(group => group.audience === 'support' ? {...group, htmlVersions: Array.from({length: 7}, (_, i) => makeVersion(211 + i, 'support', 'dynamic_' + i))} : group)}));
    return () => {delete window.fixtureGrowSupport;};
  }, []);
  const mutate = async (requestPath, init, message) => {
    const call = {path: requestPath, method: init.method, message};
    if (init.body instanceof FormData) {
      call.files = [...init.body.entries()].filter(([, value]) => value instanceof File).map(([field, file]) => ({field, name: file.name, size: file.size}));
      call.fields = Object.fromEntries([...init.body.entries()].filter(([, value]) => typeof value === 'string'));
    }
    else if (init.body instanceof Blob) {
      call.headers = init.headers;
      call.gzipSize = init.body.size;
      call.json = await new Response(init.body.stream().pipeThrough(new DecompressionStream('gzip'))).json();
    }
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
    if (requestPath === '/shared/html' && init.method === 'POST') {
      const version = {...makeVersion(203, 'support', 'shared_uploaded'), firstPublishedAt: null};
      setOverview(current => ({...current, supportShared: {...current.supportShared, htmlVersions: [version, ...current.supportShared.htmlVersions]}}));
      return {version};
    }
    if (requestPath === '/shared/publish') {
      setOverview(current => ({...current, supportShared: {...current.supportShared, previousHtmlVersionId: current.supportShared.activeHtmlVersionId, activeHtmlVersionId: call.body.versionId}}));
    }
    if (requestPath.startsWith('/shared/html?') && init.method === 'DELETE') {
      const id = Number(new URL(requestPath, location.origin).searchParams.get('id'));
      setOverview(current => ({...current, supportShared: {...current.supportShared, htmlVersions: current.supportShared.htmlVersions.filter(version => version.id !== id)}}));
    }
    if (requestPath === '/shared/snapshots') {
      setOverview(current => ({...current, supportShared: {...current.supportShared, snapshot: {...sharedSnapshot, id: 302, email: call.fields.email, originalName: call.files[0].name}}}));
    }
    if (requestPath === '/shared/json') {
      setOverview(current => ({...current, supportShared: {...current.supportShared,
        jsonSnapshot: {...sharedJsonSnapshot, id: (current.supportShared.jsonSnapshot?.id ?? 501) + 1, originalName: decodeURIComponent(call.headers['X-KTS-Shared-Filename'])}}}));
    }
    if (requestPath === '/snapshots') {
      if (window.fixtureHoldSnapshots) await new Promise(resolve => {window.fixtureReleaseSnapshot = resolve;});
      return {results: call.files.map(file => ({originalName: file.name, status: file.name === 'large-2.ktsp' ? 'rejected' : 'imported'}))};
    }
    return {results: []};
  };
  return <><main id="fixture" className={adminStyles.page + ' ' + dashboardStyles.dashboardPage}>
    <div className={adminStyles.topbar}><h1>Дашборды менеджеров</h1><div className={adminStyles.topbarActions}>
      <a id="fixture-back-link" href="#fixture" className={dashboardStyles.secondary}>В панель управления</a>
      <button className={dashboardStyles.primary}>Обновить</button>
    </div></div>
    <ManagerDashboardManagement audience={managementAudience} overview={overview} busy={false} mutate={mutate}/>
  </main><aside className={adminStyles.page} id="fixture-unrelated"><button>Другая страница администратора</button></aside></>;
}
createRoot(document.getElementById('root')).render(viewerAudience ? <ManagerDashboard mode="view" audience={managementAudience}/> : <Fixture/>);
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
      plugin.onResolve({filter: /^next\/(navigation|link)$/}, args => ({path: args.path, namespace: 'synthetic-next'}));
      plugin.onLoad({filter: /.*/, namespace: 'synthetic-next'}, args => ({contents: args.path === 'next/navigation'
        ? 'const router = {replace(path) {window.fixtureRedirect = path}}; export function useRouter() {return router}'
        : 'import React from "react"; export default function Link({children,...props}) {return React.createElement("a",props,children)}', loader: 'js', resolveDir: root}));
      plugin.onLoad({filter: /\.module\.scss$/}, async (args) => {
        const css = compile(args.path, {importers: [{findFileUrl(url) {
          return url.startsWith('@/') ? pathToFileURL(path.join(root, 'src', url.slice(2))) : null;
        }}]}).css;
        const classNames = [...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => match[1]);
        // Preserve the real admin cascade without colliding unrelated CSS Modules
        // (e.g. admin .danger !important must not match dashboard .danger).
        const prefix = args.path.endsWith('/admin.module.scss') ? 'admin_' : '';
        const parsed = postcss.parse(css);
        if (prefix) parsed.walkRules(rule => {rule.selector = rule.selector.replace(/\.([a-zA-Z_][\w-]*)/g, (_, name) => `.${prefix}${name}`);});
        styles.set(args.path, parsed.toString());
        return {contents: `export default ${JSON.stringify(Object.fromEntries(classNames.map((name) => [name, prefix + name])))};`, loader: 'js'};
      });
    }}],
  });
  const globals = await readFile(path.join(root, 'src/app/globals.css'), 'utf8');
  // Load the admin shell last to exercise the least favorable stylesheet order.
  const moduleStyles = [...styles].sort(([left], [right]) => Number(left.endsWith('/admin.module.scss')) - Number(right.endsWith('/admin.module.scss')));
  const css = `${globals}\n${moduleStyles.map(([, value]) => value).join('\n')}\nhtml,body{overflow-x:visible} body{background:#f5f5f7} #fixture{max-width:1800px;padding:24px;margin:0 auto} #fixture-unrelated{min-height:0;padding:16px} @media(max-width:760px){#fixture{padding:12px}}`;
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
    else if (url.pathname === '/api/admin/manager-dashboard/frame' || url.pathname === '/api/admin/manager-dashboard/shared/frame') {
      receivedFrames.push(url.pathname + url.search);
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
            assert.equal(await page.locator('input[type=file]').count(), 5, 'personal HTML pair, personal batch, shared HTML and shared snapshot');
            assert.equal(await page.getByRole('button', {name: 'Проверить почту сейчас', exact: true}).count(), 0);
            assert.equal(await page.getByRole('heading', {name: 'Личный HTML дашборда', exact: true}).count(), 2);
            assert.equal(await page.getByRole('heading', {name: 'Общий HTML дашборда', exact: true}).count(), 1);
            assert.doesNotMatch(await page.locator('#fixture').innerText(), /почтов|Почтов|Ежедневное обновление/);
            assert.equal(await page.getByRole('heading', {name: 'Общая загрузка личных файлов', exact: true}).count(), 1);
            assert.equal(await page.getByRole('heading', {name: 'Журнал импорта', exact: true}).count(), 1);
            const journal = page.locator('#manager-dashboard-import-journal');
            assert.equal(await journal.locator('li').count(), 5, 'initial journal contains only five supplied rows');
            assert.equal(await page.evaluate(() => {
              const history = document.getElementById('manager-dashboard-html-history')!;
              const upload = document.getElementById('manager-dashboard-snapshots')!;
              return Boolean(upload.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING)
                && history.getBoundingClientRect().top > upload.getBoundingClientRect().bottom;
            }), true, 'all working HTML history is below the shared and personal upload sections');
            assert.equal(await page.locator('.audienceGrid [data-version-id]').count(), 0, 'published HTML history is absent from the working cards');

            // Actual admin stylesheet is deliberately loaded after the dashboard
            // stylesheet: hover, danger colors and keyboard focus must still win.
            const controls = page.locator('#fixture button, #fixture a.secondary');
            for (const control of await controls.all()) {
              const kind = await control.evaluate((element: HTMLElement) => ['primary', 'secondary', 'danger'].find(name => element.classList.contains(name)));
              assert.ok(kind, 'every dashboard action uses a shared button variant');
              await page.mouse.move(0, 0);
              const disabled = await control.isDisabled();
              const normalBackground = kind === 'primary' ? 'rgb(49, 36, 103)' : 'rgb(255, 255, 255)';
              await page.waitForFunction(({element, expected}: {element: HTMLElement; expected: string}) => getComputedStyle(element).backgroundColor === expected, {element: await control.elementHandle(), expected: normalBackground});
              const before = await control.evaluate((element: HTMLElement) => {
                const style = getComputedStyle(element);
                return {background: style.backgroundColor, color: style.color, border: style.borderColor, shadow: style.boxShadow, cursor: style.cursor, transform: style.transform};
              });
              await control.hover({force: disabled});
              if (disabled) {
                const after = await control.evaluate((element: HTMLElement) => {
                  const style = getComputedStyle(element);
                  return {background: style.backgroundColor, color: style.color, border: style.borderColor, shadow: style.boxShadow, cursor: style.cursor, transform: style.transform};
                });
                assert.deepEqual(after, before, 'disabled buttons do not react visually to hover');
                assert.equal(after.cursor, 'not-allowed', 'disabled actions do not imply they are loading');
              } else {
                const expected = kind === 'primary' ? 'rgb(35, 22, 79)' : kind === 'secondary' ? 'rgb(239, 235, 252)' : 'rgb(165, 47, 36)';
                await page.waitForFunction(({element, expected}: {element: HTMLElement; expected: string}) => getComputedStyle(element).backgroundColor === expected, {element: await control.elementHandle(), expected});
                const after = await control.evaluate((element: HTMLElement) => {
                  const style = getComputedStyle(element);
                  return {color: style.color, shadow: style.boxShadow, cursor: style.cursor, transform: style.transform};
                });
                assert.notEqual(after.shadow, 'none', 'enabled actions have visible hover feedback');
                assert.equal(after.cursor, 'pointer');
                assert.equal(after.transform, before.transform, 'hover does not move the action or neighboring rows');
                await control.screenshot({path: path.join(output, `${engineName}-${width}-${kind}-hover.png`)});
                if (kind === 'danger') {
                  assert.equal(after.color, 'rgb(255, 255, 255)', 'delete hover keeps readable contrast');
                  await page.locator('#manager-dashboard-html-panel-development').screenshot({path: path.join(output, `${engineName}-${width}-actions-hover.png`)});
                }
              }
            }
            await page.mouse.move(0, 0);
            const fileInput = page.locator('#manager-dashboard-html-development');
            await fileInput.hover({position: {x: 30, y: 15}});
            await page.waitForFunction(() => {
              const input = document.getElementById('manager-dashboard-html-development');
              return input && getComputedStyle(input, '::file-selector-button').backgroundColor === 'rgb(239, 235, 252)';
            });
            await fileInput.screenshot({path: path.join(output, `${engineName}-${width}-file-hover.png`)});
            await page.mouse.move(0, 0);
            await fileInput.focus();
            await page.keyboard.press('Tab');
            await page.keyboard.press('Shift+Tab');
            // macOS WebKit can exclude controls from sequential Tab navigation;
            // retain keyboard modality but explicitly focus this test target.
            await fileInput.focus();
            assert.equal(await fileInput.evaluate((element: HTMLElement) => getComputedStyle(element).outlineStyle), 'solid', `file input keyboard focus survives admin input:read-only:focus styles (${JSON.stringify(await fileInput.evaluate((element: HTMLElement) => ({active: document.activeElement?.id, focusVisible: element.matches(':focus-visible')})))})`);
            assert.equal(await fileInput.evaluate((element: HTMLElement) => getComputedStyle(element).outlineWidth), '3px');
            const backLink = page.locator('#fixture-back-link');
            await backLink.focus();
            assert.equal(await backLink.evaluate((element: HTMLElement) => getComputedStyle(element).outlineWidth), '3px', 'button-like navigation link has keyboard focus');
            const unrelated = page.locator('#fixture-unrelated button');
            const unrelatedBefore = await unrelated.evaluate((element: HTMLElement) => getComputedStyle(element).backgroundColor);
            await unrelated.hover();
            assert.equal(await unrelated.evaluate((element: HTMLElement) => getComputedStyle(element).backgroundColor), unrelatedBefore, 'hover remains scoped to this dashboard');
            assert.equal(unrelatedBefore, 'rgb(38, 11, 134)', 'real admin base styling is present outside the dashboard');
            await page.emulateMedia({reducedMotion: 'reduce'});
            for (const control of await controls.all()) assert.equal(await control.evaluate((element: HTMLElement) => getComputedStyle(element).transitionDuration), '0s', 'reduced motion removes action transitions');
            assert.equal(await fileInput.evaluate((element: HTMLElement) => getComputedStyle(element, '::file-selector-button').transitionDuration), '0s', 'reduced motion removes file-selector transitions');
            await page.emulateMedia({reducedMotion: 'no-preference'});
            await page.mouse.move(0, 0);
            await page.locator('#fixture h1').scrollIntoViewIfNeeded();
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
            const commonReport = await page.locator('#manager-dashboard-shared-support').boundingBox();
            const personalGrid = await page.locator('.audienceGrid').boundingBox();
            assert.ok(commonReport && personalGrid && commonReport.y > personalGrid.y + personalGrid.height, 'shared report follows both complete personal columns');
            assert.ok(Math.abs(commonReport.width - personalGrid.width) < 2, 'shared controls span the full width with no empty neighboring column');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no page horizontal overflow: ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(element => element.getBoundingClientRect().right > innerWidth + 1).slice(0, 12).map(element => ({tag: element.tagName, className: element.className, right: element.getBoundingClientRect().right}))))}`);
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
              await preview.getByRole('button', {name: 'Закрыть', exact: true}).click();
              await preview.waitFor({state: 'detached'});
              const publishButton = page.locator(`#manager-dashboard-group-${audience}`).getByRole('button', {name: 'Опубликовать группе', exact: true});
              assert.equal(await publishButton.isDisabled(), false, 'closing optional preview must not block publication');
              const beforePublish = (await page.evaluate('window.fixtureCalls')).length;
              acceptConfirmation = false;
              await publishButton.click();
              assert.equal((await page.evaluate('window.fixtureCalls')).length, beforePublish, 'cancelled confirmation does not publish');
              assert.ok(confirmations.at(-1)!.includes(`${audience}_synthetic_dashboard_uploaded.html`));
              assert.ok(confirmations.at(-1)!.includes(audience === 'development' ? 'Менеджеры по развитию' : 'Менеджеры по сопровождению'));
              acceptConfirmation = true;
              await publishButton.click();
              await page.waitForFunction((expected: number) => (window as unknown as {fixtureCalls: Array<{path: string; body?: {versionId: number}}>}).fixtureCalls.some((call) => call.path === '/publish' && call.body?.versionId === expected), id);
            }
            await page.locator('#manager-dashboard-snapshots').setInputFiles([
              {name: 'development.ktsp', mimeType: 'application/json', buffer: Buffer.from('synthetic development')},
              {name: 'support.ktsp', mimeType: 'application/json', buffer: Buffer.from('synthetic support')},
            ]);
            await page.getByRole('button', {name: 'Загрузить файлы', exact: true}).click();
            const calls = await page.evaluate('window.fixtureCalls');
            assert.deepEqual(calls.map((call: {path: string}) => call.path), ['/html?audience=development', '/publish', '/html?audience=support', '/publish', '/snapshots']);
            assert.deepEqual(calls[1].body, {audience: 'development', versionId: 101, expectedActiveVersionId: 1});
            assert.deepEqual(calls[3].body, {audience: 'support', versionId: 111, expectedActiveVersionId: null});
            assert.deepEqual(calls[4].files.map((file: {name: string}) => file.name), ['development.ktsp', 'support.ktsp']);

            // Deletion is exercised through actual controls and browser dialogs;
            // the synthetic mutation never connects to a real API or removes files.
            const developmentPanel = page.locator('#manager-dashboard-history-development');
            const supportPanel = page.locator('#manager-dashboard-history-support');
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
            const commonPanel = page.locator('#manager-dashboard-shared-support');
            const sharedPrevious = page.locator('[data-version-audience="support-shared"]').filter({hasText: 'support_synthetic_dashboard_shared_previous.html'});
            assert.equal(await sharedPrevious.getByRole('button', {name: 'Вернуть общий HTML', exact: true}).isDisabled(), false, 'shared publication is available while another report is previewed');
            await sharedPrevious.getByRole('button', {name: 'Предпросмотр общего HTML', exact: true}).click();
            const sharedPreviewUrl = new URL((await previewFrame.getAttribute('src'))!, origin);
            assert.equal(sharedPreviewUrl.pathname, '/api/admin/manager-dashboard/shared/frame');
            assert.equal(sharedPreviewUrl.searchParams.get('preview'), '1');
            assert.equal(sharedPreviewUrl.searchParams.has('snapshot'), false, 'legacy shared preview does not select shared or personal data');
            assert.match(await page.locator('#manager-dashboard-html-preview').innerText(), /Общие и личные данные не загружаются/);
            await page.locator('#manager-dashboard-html-preview').getByRole('button', {name: 'Закрыть', exact: true}).click();
            await previewFrame.waitFor({state: 'detached'});
            assert.equal(await sharedPrevious.getByRole('button', {name: 'Вернуть общий HTML', exact: true}).isDisabled(), false, 'shared rollback remains available after closing preview');
            await sharedPrevious.getByRole('button', {name: 'Вернуть общий HTML', exact: true}).click();
            await page.locator('#manager-dashboard-shared-html').setInputFiles({name: 'shared-report.html', mimeType: 'text/html', buffer: Buffer.from('<html>Synthetic shared report</html>')});
            await commonPanel.getByRole('button', {name: 'Загрузить общий HTML', exact: true}).click();
            await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#manager-dashboard-html-preview iframe')?.src.includes('version=203'));
            const activeShared = page.locator('[data-version-audience="support-shared"]').filter({hasText: 'support_synthetic_dashboard_shared_uploaded.html'});
            await activeShared.getByRole('button', {name: 'Опубликовать общий HTML', exact: true}).click();
            assert.equal(await activeShared.getByRole('button', {name: /^Удалить общий HTML/}).isDisabled(), true);
            await page.locator('#manager-dashboard-shared-email').fill('shared.recipient@example.test');
            await page.locator('#manager-dashboard-shared-snapshot').setInputFiles({name: 'all-support.ktsp', mimeType: 'application/json', buffer: Buffer.from('synthetic shared report')});
            acceptConfirmation = false;
            await commonPanel.getByRole('button', {name: 'Опубликовать общий файл', exact: true}).click();
            assert.equal((await page.evaluate('window.fixtureCalls')).filter((call: {path: string}) => call.path === '/shared/snapshots').length, 0);
            assert.equal(await page.locator('#manager-dashboard-shared-snapshot').evaluate((input: HTMLInputElement) => input.files?.[0]?.name), 'all-support.ktsp');
            assert.match(confirmations.at(-1)!, /ВСЕХ менеджеров по сопровождению/);
            assert.match(confirmations.at(-1)!, /Личные дашборды и личные файлы всех менеджеров сохранятся/);
            acceptConfirmation = true;
            await commonPanel.getByRole('button', {name: 'Опубликовать общий файл', exact: true}).click();
            const sharedCalls = (await page.evaluate('window.fixtureCalls')).filter((call: {path: string}) => call.path.startsWith('/shared/'));
            assert.deepEqual(sharedCalls.map((call: {path: string}) => call.path), ['/shared/publish', '/shared/html', '/shared/publish', '/shared/snapshots']);
            assert.deepEqual(sharedCalls[0].body, {versionId: 202, expectedActiveVersionId: 201});
            assert.deepEqual(sharedCalls[2].body, {versionId: 203, expectedActiveVersionId: 202});
            assert.deepEqual(sharedCalls[3].fields, {email: 'shared.recipient@example.test', expectedActiveSnapshotId: '301', confirmShared: 'true'});
            assert.deepEqual(sharedCalls[3].files.map((file: {field: string; name: string}) => [file.field, file.name]), [['file', 'all-support.ktsp']]);
            for (const audience of ['development', 'support']) assert.equal(await page.locator(`#manager-dashboard-files-${audience} tbody tr`).count(), 1, 'shared publication preserves personal snapshot rows');
            await page.locator('#manager-dashboard-shared-support').screenshot({path: path.join(output, `${engineName}-${width}-shared-management.png`)});
            const beforeLargeUpload = (await page.evaluate('window.fixtureCalls')).length;
            await page.evaluate('window.fixtureHoldSnapshots = true');
            await page.locator('#manager-dashboard-snapshots').setInputFiles(Array.from({length: 4}, (_, index) => ({
              name: `large-${index + 1}.ktsp`, mimeType: 'application/json', buffer: Buffer.alloc(8 * 1024 * 1024),
            })));
            await page.getByRole('button', {name: 'Загрузить файлы', exact: true}).click();
            await page.waitForFunction('typeof window.fixtureReleaseSnapshot === "function"');
            assert.equal((await page.evaluate('window.fixtureCalls')).length, beforeLargeUpload + 1, 'only one personal batch is in flight');
            assert.equal(await page.locator('#manager-dashboard-shared-html').isDisabled(), true);
            assert.equal(await page.locator('#manager-dashboard-html-support').isDisabled(), true);
            await page.evaluate('window.fixtureReleaseSnapshot(); delete window.fixtureReleaseSnapshot;');
            await page.waitForFunction('typeof window.fixtureReleaseSnapshot === "function"');
            assert.equal(await page.locator('#manager-dashboard-shared-html').isDisabled(), true, 'competing controls remain locked through the second batch');
            await page.evaluate('window.fixtureHoldSnapshots = false; window.fixtureReleaseSnapshot(); delete window.fixtureReleaseSnapshot;');
            await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('#manager-dashboard-snapshots')?.disabled);
            const largeCalls = (await page.evaluate('window.fixtureCalls')).slice(beforeLargeUpload);
            assert.equal(largeCalls.length, 2, '32 MiB selection is sent as two bounded requests');
            for (const call of largeCalls) {
              assert.equal(call.path, '/snapshots');
              assert.equal(call.files.reduce((bytes: number, file: {size: number}) => bytes + file.size, 0), 16 * 1024 * 1024);
            }
            const lastResults = page.getByRole('heading', {name: 'Результат последней операции', exact: true}).locator('..');
            assert.deepEqual(await lastResults.locator('li strong').allTextContents(), ['large-1.ktsp', 'large-2.ktsp', 'large-3.ktsp', 'large-4.ktsp']);
            assert.deepEqual(await lastResults.locator('li span').allTextContents(), ['Загружен', 'Отклонён', 'Загружен', 'Загружен']);
            assert.equal(await page.locator('#manager-dashboard-snapshots').evaluate((input: HTMLInputElement) => input.files?.length), 0, 'processed selection cannot replay successful files');
            assert.deepEqual(errors, [], 'no browser script errors');
            assert.deepEqual(external, [], 'no external requests');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mutations and preview do not introduce horizontal overflow');
            await page.evaluate('window.fixtureGrowSupport()');
            await page.locator('#manager-dashboard-history-support .versionsTable tbody tr').nth(6).waitFor({state: 'visible'});
            await assertPanelAlignment('support grows dynamically after render');
            await page.goto(`${origin}/?support=many`);
            await page.locator('#manager-dashboard-history-support .versionsTable tbody tr').nth(6).waitFor({state: 'visible'});
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

            for (const audience of ['development', 'support']) {
              const otherAudience = audience === 'development' ? 'support' : 'development';
              const versionId = audience === 'development' ? 101 : 111;
              const scopedHistoryStart = historyRequests.length;
              await page.goto(`${origin}/?audience=${audience}`);
              const group = page.locator(`#manager-dashboard-group-${audience}`);
              await group.waitFor({state: 'visible'});
              await page.evaluate(() => document.fonts.ready);
              assert.equal(await page.locator(`#manager-dashboard-group-${otherAudience}`).count(), 0, `${audience}: other personal group is absent from the DOM`);
              assert.equal(await page.locator(`#manager-dashboard-html-${otherAudience}`).count(), 0, `${audience}: other HTML uploader is absent`);
              assert.equal(await page.locator(`#manager-dashboard-files-${otherAudience}`).count(), 0, `${audience}: other manager files are absent`);
              assert.equal(await group.locator('tbody tr').filter({hasText: `Тестовый менеджер ${audience === 'development' ? 'развития' : 'сопровождения'}`}).count(), 1);
              assert.equal(await page.getByRole('heading', {name: 'Личный HTML дашборда', exact: true}).count(), 1);
              assert.equal(await page.locator('#manager-dashboard-shared-support').count(), audience === 'support' ? 1 : 0, `${audience}: shared support report is available only in support management`);
              assert.equal(await page.locator('input[type=file]').count(), audience === 'support' ? 4 : 2);
              assert.equal(await page.getByRole('heading', {name: 'Общая загрузка личных файлов', exact: true}).count(), 1);
              assert.equal(await page.locator('#manager-dashboard-snapshots').count(), 1, 'scoped view retains one common mixed-file uploader');
              assert.equal(await page.getByRole('heading', {name: 'Журнал импорта', exact: true}).count(), 1);
              assert.equal(await page.locator('#manager-dashboard-import-journal li').count(), 5);
              assert.equal(historyRequests.length, scopedHistoryStart, 'scoped journal also waits for explicit pagination');
              const scopedGrid = await page.locator('.audienceGrid').boundingBox();
              const scopedColumn = await group.boundingBox();
              assert.ok(scopedGrid && scopedColumn && Math.abs(scopedGrid.width - scopedColumn.width) < 2, `${audience}: single group fills the available width`);
              assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${audience}: scoped management has no horizontal overflow`);
              await page.screenshot({path: path.join(output, `${engineName}-${width}-${audience}-scoped.png`), fullPage: true});

              await page.locator(`#manager-dashboard-html-${audience}`).setInputFiles({name: `${audience}-scoped.html`, mimeType: 'text/html', buffer: Buffer.from('<!doctype html><h1>Scoped synthetic</h1>')});
              await group.getByRole('button', {name: 'Загрузить черновик', exact: true}).click();
              await page.waitForFunction((expected: number) => document.querySelector<HTMLIFrameElement>('#manager-dashboard-html-preview iframe')?.src.includes(`version=${expected}`), versionId);
              const scopedFrame = new URL((await page.locator('#manager-dashboard-html-preview iframe').getAttribute('src'))!, origin);
              assert.equal(scopedFrame.searchParams.get('audience'), audience, 'scoped upload previews the selected group');
              await group.getByRole('button', {name: 'Опубликовать группе', exact: true}).click();
              await page.waitForFunction(() => (window as unknown as {fixtureCalls: Array<{path: string}>}).fixtureCalls.some(call => call.path === '/publish'));
              await page.locator('#manager-dashboard-snapshots').setInputFiles([
                {name: 'development.ktsp', mimeType: 'application/json', buffer: Buffer.from('synthetic development')},
                {name: 'support.ktsp', mimeType: 'application/json', buffer: Buffer.from('synthetic support')},
              ]);
              await page.getByRole('button', {name: 'Загрузить файлы', exact: true}).click();
              await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('#manager-dashboard-snapshots')?.disabled);
              const scopedCalls = await page.evaluate('window.fixtureCalls');
              assert.deepEqual(scopedCalls.map((call: {path: string}) => call.path), [`/html?audience=${audience}`, '/publish', '/snapshots']);
              assert.deepEqual(scopedCalls[1].body, {audience, versionId, expectedActiveVersionId: audience === 'development' ? 1 : null});
              assert.deepEqual(scopedCalls[2].files.map((file: {name: string}) => file.name), ['development.ktsp', 'support.ktsp'], 'both groups can still share one batch in either scoped view');
              assert.deepEqual(scopedCalls[2].fields, {}, 'mixed snapshot upload does not gain an audience override');
              await page.locator('#manager-dashboard-import-journal').getByRole('button', {name: /Показать ещё/}).click();
              await page.waitForFunction(() => document.querySelectorAll('#manager-dashboard-import-journal li').length === 10);
              assert.deepEqual(historyRequests.slice(scopedHistoryStart), [{before: 9, returned: 5}], 'scoped view uses the same common import journal');
              assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${audience}: uploads, preview and pagination preserve page width`);
            }

            await page.goto(`${origin}/?audience=support&json=1`);
            await page.locator('#manager-dashboard-shared-json').waitFor({state: 'visible'});
            assert.equal(await page.locator('#manager-dashboard-group-development').count(), 0, 'support JSON mode stays scoped');
            assert.equal(await page.locator('#manager-dashboard-shared-email').count(), 0, 'scoped JSON needs no recipient email');
            await page.locator('#manager-dashboard-history-support-shared').getByRole('button', {name: 'Предпросмотр общего HTML', exact: true}).first().click();
            const scopedJsonPreview = page.locator('#manager-dashboard-html-preview iframe');
            await scopedJsonPreview.waitFor({state: 'visible'});
            const scopedJsonSource = new URL((await scopedJsonPreview.getAttribute('src'))!, origin);
            assert.equal(scopedJsonSource.pathname, '/api/admin/manager-dashboard/shared/frame');
            assert.equal(scopedJsonSource.searchParams.get('preview'), '1');
            assert.equal(scopedJsonSource.searchParams.get('version'), '201');
            assert.equal(scopedJsonSource.searchParams.get('revision'), '501');
            assert.equal(scopedJsonSource.searchParams.has('snapshot'), false);
            await page.locator('#manager-dashboard-shared-json').setInputFiles({name: 'scoped-support.json', mimeType: 'application/json', buffer: Buffer.from('{"snapshot":true,"orders":[]}')});
            await page.getByRole('button', {name: 'Опубликовать общий JSON', exact: true}).click();
            await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#manager-dashboard-html-preview iframe')?.src.includes('revision=502'));
            assert.equal((await page.evaluate('window.fixtureCalls'))[0].path, '/shared/json', 'scoped support retains the shared JSON mutation route');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'scoped support JSON preview has no horizontal overflow');
            await page.screenshot({path: path.join(output, `${engineName}-${width}-support-scoped-json-preview.png`), fullPage: true});

            await page.goto(`${origin}/?view=support&audience=development`);
            const personalFrame = page.locator('iframe[title="Личный дашборд менеджера"]');
            const commonFrame = page.locator('iframe[title="Общий дашборд сопровождения"]');
            await personalFrame.waitFor({state: 'visible'});
            await commonFrame.waitFor({state: 'visible'});
            assert.equal(await page.evaluate(() => {
              const history = document.getElementById('manager-dashboard-data-history')!;
              return [...document.querySelectorAll('iframe')].every(frame =>
                Boolean(frame.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING)
                && frame.getBoundingClientRect().bottom < history.getBoundingClientRect().top);
            }), true, 'personal and shared data history follows both reports in DOM and visual order');
            assert.equal(await page.locator('iframe').count(), 2, 'support has two independently mounted reports even with a development management prop');
            assert.equal(new URL((await personalFrame.getAttribute('src'))!, origin).searchParams.get('snapshot'), '401');
            assert.equal(new URL((await commonFrame.getAttribute('src'))!, origin).searchParams.get('snapshot'), '301');
            await page.locator('#manager-dashboard-history').selectOption('400');
            await page.locator('#manager-dashboard-shared-history').selectOption('300');
            assert.equal(new URL((await personalFrame.getAttribute('src'))!, origin).searchParams.get('snapshot'), '400');
            assert.equal(new URL((await commonFrame.getAttribute('src'))!, origin).searchParams.get('snapshot'), '300');
            await personalFrame.evaluate((frame: HTMLIFrameElement) => {frame.dataset.mountToken = 'personal-kept';});
            await commonFrame.evaluate((frame: HTMLIFrameElement) => {frame.dataset.mountToken = 'shared-before-reload';});
            await page.evaluate(() => {
              const state = window as unknown as {fixtureViewerOverview: {htmlVersion: {id: number}; snapshot: {id: number}}};
              state.fixtureViewerOverview.htmlVersion = {...state.fixtureViewerOverview.htmlVersion, id: 12};
              state.fixtureViewerOverview.snapshot = {...state.fixtureViewerOverview.snapshot, id: 402};
            });
            await page.getByRole('button', {name: 'Перезагрузить общий отчёт', exact: true}).click();
            await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('iframe[title="Общий дашборд сопровождения"]')?.src.includes('revision=1'));
            assert.equal(await personalFrame.getAttribute('data-mount-token'), 'personal-kept', 'shared reload does not remount the personal report');
            assert.equal(new URL((await personalFrame.getAttribute('src'))!, origin).searchParams.get('version'), '11', 'shared reload defers a newly published personal HTML until personal/global refresh');
            assert.equal(new URL((await personalFrame.getAttribute('src'))!, origin).searchParams.get('snapshot'), '400', 'shared reload preserves personal archive selection');
            assert.equal(await commonFrame.getAttribute('data-mount-token'), null, 'shared reload remounts only the common frame');
            await commonFrame.evaluate((frame: HTMLIFrameElement) => {frame.dataset.mountToken = 'shared-kept';});
            await page.evaluate(() => {
              const state = window as unknown as {fixtureViewerOverview: {email: string; bindingStatus: string; supportShared: {activeHtmlVersionId: number; htmlVersions: Array<{id: number}>; snapshot: {id: number; email: string}}}};
              state.fixtureViewerOverview.email = '';
              state.fixtureViewerOverview.bindingStatus = 'missing_email';
              state.fixtureViewerOverview.supportShared = {...state.fixtureViewerOverview.supportShared,
                activeHtmlVersionId: 204,
                htmlVersions: [{...state.fixtureViewerOverview.supportShared.htmlVersions[0], id: 204}],
                snapshot: {...state.fixtureViewerOverview.supportShared.snapshot, id: 303, email: 'new.shared.recipient@example.test'}};
              window.dispatchEvent(new Event('focus'));
            });
            await page.getByText('В профиле не указан email для назначения личного файла.', {exact: false}).waitFor({state: 'visible'});
            await page.getByRole('button', {name: 'Открыть обновление', exact: true}).waitFor({state: 'visible'});
            assert.equal(await commonFrame.getAttribute('data-mount-token'), 'shared-kept', 'personal binding changes and shared updates preserve the open shared report until explicit refresh');
            assert.equal(new URL((await commonFrame.getAttribute('src'))!, origin).searchParams.get('version'), '201');
            assert.equal(new URL((await personalFrame.getAttribute('src'))!, origin).searchParams.has('snapshot'), false, 'personal binding loss clears personal data promptly');
            await page.getByRole('button', {name: 'Открыть обновление', exact: true}).click();
            await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('iframe[title="Общий дашборд сопровождения"]')?.src.includes('version=204'));
            await page.locator('#manager-dashboard-shared-history').selectOption('');
            assert.equal(new URL((await commonFrame.getAttribute('src'))!, origin).searchParams.get('snapshot'), '303');
            assert.equal(await page.locator('iframe').count(), 2, 'shared report stays available with no personal email');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'viewer remains within desktop/mobile width');
            assert.deepEqual(errors, [], 'real viewer polling and frame updates have no browser errors');
            await page.screenshot({path: path.join(output, `${engineName}-${width}-support-viewer.png`), fullPage: true});
            await page.goto(`${origin}/?view=development&audience=support`);
            await personalFrame.waitFor({state: 'visible'});
            assert.equal(await commonFrame.count(), 0, 'development never renders the support shared report even with a support management prop');
            await page.goto(`${origin}/?json=1`);
            const jsonFile = page.locator('#manager-dashboard-shared-json');
            await jsonFile.waitFor({state: 'visible'});
            assert.equal(await page.locator('#manager-dashboard-shared-email').count(), 0, 'JSON never requires the old recipient email');
            assert.equal(await page.locator('#manager-dashboard-shared-snapshot').count(), 0, 'JSON does not use the password .ktsp upload path');
            await page.locator('#manager-dashboard-history-support-shared').getByRole('button', {name: 'Предпросмотр общего HTML', exact: true}).first().click();
            assert.match(await page.locator('#manager-dashboard-html-preview').innerText(), /Общий JSON, привязанный к этой версии HTML, загружается автоматически/);
            assert.match(await page.locator('#manager-dashboard-html-preview').innerText(), /Личные данные менеджеров не загружаются/);
            assert.doesNotMatch(await page.locator('#manager-dashboard-html-preview').innerText(), /Общие и личные данные не загружаются/);
            const jsonPreviewBefore = new URL((await previewFrame.getAttribute('src'))!, origin);
            assert.equal(jsonPreviewBefore.searchParams.get('preview'), '1');
            assert.equal(jsonPreviewBefore.searchParams.get('version'), '201');
            assert.equal(jsonPreviewBefore.searchParams.get('revision'), '501');
            assert.equal(jsonPreviewBefore.searchParams.has('snapshot'), false, 'preview snapshot is resolved by the server for the selected HTML');
            await previewFrame.evaluate((frame: HTMLIFrameElement) => {frame.dataset.mountToken = 'json-preview-before-upload';});
            await jsonFile.setInputFiles({name: 'общий_маршрут.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({snapshot: true, app: 'компоновщик', orders: [], savedAt: '2026-09-17T05:00:00Z'}))});
            const publishJson = page.getByRole('button', {name: 'Опубликовать общий JSON', exact: true});
            acceptConfirmation = false;
            await publishJson.click();
            assert.equal((await page.evaluate('window.fixtureCalls')).length, 0, 'cancelled JSON confirmation performs no request');
            assert.equal(await jsonFile.evaluate((input: HTMLInputElement) => input.files?.length), 1, 'cancelled JSON preserves file selection');
            acceptConfirmation = true;
            await publishJson.click();
            await page.waitForFunction(() => (window as unknown as {fixtureCalls: Array<{path: string}>}).fixtureCalls.some(call => call.path === '/shared/json'));
            await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('#manager-dashboard-shared-json')?.disabled);
            const jsonCalls = await page.evaluate('window.fixtureCalls');
            assert.equal(jsonCalls.length, 1);
            assert.deepEqual(jsonCalls[0].headers, {'Content-Type': 'application/gzip', 'X-KTS-Shared-Version': '201',
              'X-KTS-Shared-Expected-Snapshot': '501', 'X-KTS-Shared-Filename': encodeURIComponent('общий_маршрут.json'), 'X-KTS-Shared-Confirm': 'true'});
            assert.equal(jsonCalls[0].json.app, 'компоновщик');
            assert.ok(jsonCalls[0].gzipSize < 16 * 1024 * 1024);
            assert.equal(await jsonFile.evaluate((input: HTMLInputElement) => input.files?.length), 0);
            assert.match(await commonPanel.innerText(), /общий_маршрут.json/);
            await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#manager-dashboard-html-preview iframe')?.src.includes('revision=502'));
            assert.equal(await previewFrame.getAttribute('data-mount-token'), null, 'same HTML preview reloads after publishing a new shared JSON');
            assert.equal(new URL((await previewFrame.getAttribute('src'))!, origin).searchParams.get('version'), '201');
            assert.equal(new URL((await previewFrame.getAttribute('src'))!, origin).searchParams.has('snapshot'), false, 'refresh does not turn preview into viewer snapshot selection');
            const jsonControlBounds = await jsonFile.evaluate((input: HTMLInputElement) => {
              const form = input.closest('form')!;
              const outer = form.getBoundingClientRect();
              return [...form.querySelectorAll('input, button, p')].map(control => {
                const bounds = control.getBoundingClientRect();
                return bounds.left >= outer.left && bounds.right <= outer.right;
              });
            });
            assert.ok(jsonControlBounds.every(Boolean), 'long HTML names cannot expand and clip mobile JSON upload controls');
            await commonPanel.screenshot({path: path.join(output, `${engineName}-${width}-json-management.png`)});
            await page.locator('#manager-dashboard-history-development').getByRole('button', {name: 'Предпросмотр', exact: true}).first().click();
            await previewFrame.evaluate((frame: HTMLIFrameElement) => {frame.dataset.mountToken = 'personal-preview-kept';});
            await jsonFile.setInputFiles({name: 'обновлённый_маршрут.json', mimeType: 'application/json', buffer: Buffer.from('{"snapshot":true,"orders":[]}')});
            await publishJson.click();
            await page.waitForFunction(() => (window as unknown as {fixtureCalls: Array<{path: string}>}).fixtureCalls.filter(call => call.path === '/shared/json').length === 2);
            await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('#manager-dashboard-shared-json')?.disabled);
            assert.equal(await previewFrame.getAttribute('data-mount-token'), 'personal-preview-kept', 'shared JSON upload preserves an unrelated personal preview');
            await page.goto(`${origin}/?json=empty`);
            await page.locator('#manager-dashboard-history-support-shared').getByRole('button', {name: 'Предпросмотр общего HTML', exact: true}).first().click();
            assert.equal(new URL((await previewFrame.getAttribute('src'))!, origin).searchParams.get('revision'), '0');
            await previewFrame.evaluate((frame: HTMLIFrameElement) => {frame.dataset.mountToken = 'empty-json-preview';});
            await jsonFile.setInputFiles({name: 'первый_маршрут.json', mimeType: 'application/json', buffer: Buffer.from('{"snapshot":true,"orders":[]}')});
            await publishJson.click();
            await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('#manager-dashboard-html-preview iframe')?.src.includes('revision=502'));
            assert.equal(await previewFrame.getAttribute('data-mount-token'), null, 'first JSON upload replaces an already open empty preview');
            assert.equal((await page.evaluate('window.fixtureCalls'))[0].headers['X-KTS-Shared-Expected-Snapshot'], 'null');
            await page.goto(`${origin}/?view=support&json=1`);
            await commonFrame.waitFor({state: 'visible'});
            assert.equal(new URL((await commonFrame.getAttribute('src'))!, origin).searchParams.get('snapshot'), '501');
            const jsonViewer = page.getByRole('heading', {name: 'Общий дашборд', exact: true}).locator('..').locator('..').locator('..');
            assert.doesNotMatch(await jsonViewer.innerText(), /общий_файл.ktsp|введите пароль/);
            assert.match(await jsonViewer.innerText(), /без email и пароля/);
            await page.locator('#manager-dashboard-shared-history').selectOption('500');
            assert.equal(new URL((await commonFrame.getAttribute('src'))!, origin).searchParams.get('snapshot'), '500');
            await page.locator('#manager-dashboard-shared-history').selectOption('');
            await personalFrame.evaluate((frame: HTMLIFrameElement) => {frame.dataset.mountToken = 'personal-json-kept';});
            await commonFrame.evaluate((frame: HTMLIFrameElement) => {frame.dataset.mountToken = 'json-before-refresh';});
            await page.evaluate(() => {
              const state = window as unknown as {fixtureViewerOverview: {supportShared: {jsonSnapshot: {id: number}}}};
              state.fixtureViewerOverview.supportShared.jsonSnapshot = {...state.fixtureViewerOverview.supportShared.jsonSnapshot, id: 502};
              window.dispatchEvent(new Event('focus'));
            });
            await page.getByRole('button', {name: 'Открыть обновление', exact: true}).waitFor({state: 'visible'});
            assert.equal(await commonFrame.getAttribute('data-mount-token'), 'json-before-refresh', 'new JSON notification does not replace open calculations automatically');
            await page.getByRole('button', {name: 'Перезагрузить общий отчёт', exact: true}).click();
            await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('iframe[title="Общий дашборд сопровождения"]')?.src.includes('snapshot=502'));
            assert.equal(await personalFrame.getAttribute('data-mount-token'), 'personal-json-kept', 'JSON refresh does not reset password-protected personal report');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'JSON view stays in mobile width');
            assert.deepEqual(errors, [], 'JSON gzip upload and viewer have no browser errors');
            assert.deepEqual(external, [], 'JSON UI uses no external services');
            console.log(`PASS ${engineName}/${width}: combined aligned panels, scoped group management and uploads, common batch/journal, scoped shared JSON preview, real admin cascade, optional preview/publication, bounded gzip JSON upload with confirmation/CAS, shared JSON preview refresh on replacement/first upload without resetting personal preview, role-bound JSON and password viewers/history, safe JSON polling refresh without resetting personal frame, journal 5+5+3, no overflow.`);
          } finally {await context.close();}
        }
        // A narrow desktop viewport is not a touchscreen. Exercise the actual
        // coarse-pointer/hover:none media features in a separate touch context.
        const touchContext = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
        const touchExternal: string[] = [];
        try {
          await touchContext.route('**/*', async (route: BrowserRoute) => {
            const url = new URL(route.request().url());
            if (url.origin === origin) await route.continue();
            else {touchExternal.push(url.origin); await route.abort();}
          });
          const touchPage = await touchContext.newPage();
          await touchPage.goto(origin);
          await touchPage.locator('#manager-dashboard-group-development').waitFor({state: 'visible'});
          assert.equal(await touchPage.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches), true, 'touch fixture uses genuine coarse-pointer media features');
          for (const control of await touchPage.locator('#fixture button:not(:disabled), #fixture a.secondary').all()) {
            const before = await control.evaluate((element: HTMLElement) => ({background: getComputedStyle(element).backgroundColor, shadow: getComputedStyle(element).boxShadow}));
            await control.hover();
            const after = await control.evaluate((element: HTMLElement) => ({background: getComputedStyle(element).backgroundColor, shadow: getComputedStyle(element).boxShadow}));
            assert.deepEqual(after, before, 'touch devices do not retain hover-only colors or shadows');
          }
          assert.deepEqual(touchExternal, [], 'touch checks do not request external services');
          await touchPage.locator('#manager-dashboard-html-panel-development').screenshot({path: path.join(output, `${engineName}-touch-390-actions.png`)});
          console.log(`PASS ${engineName}/touch-390: real hover:none/coarse-pointer, no sticky action hover or external requests.`);
        } finally {await touchContext.close();}
      } finally {await browser.close();}
    }
    assert.ok(enginesTested > 0, 'at least one browser engine must be installed');
    assert.ok(receivedFrames.length > 0, 'the actual DashboardFrame requested the synthetic preview route');
    console.log(`Screenshots: ${output}`);
  } finally {await new Promise<void>((resolve) => server.close(() => resolve()));}
}

main().catch((error: unknown) => {console.error(error); process.exitCode = 1;});
