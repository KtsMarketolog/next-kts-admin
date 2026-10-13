/** Synthetic journal UI only: never authenticates against production or writes a real event. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { compile } from 'sass';

async function main() {
  const root = path.resolve('.');
  const runtime = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const playwright = await import(pathToFileURL(path.join(runtime, 'index.mjs')).href);
  const screenshots = await mkdtemp(path.join(tmpdir(), 'kts-usage-journal-ui-'));
  let css = '';
  let styleIndex = 0;
  const globalCss = await readFile(path.join(root, 'src/app/globals.css'), 'utf8');
  const logo = await readFile(path.join(root, 'public/img/logo.svg'));
  const bundle = await build({
    absWorkingDir: root, stdin: { resolveDir: root, loader: 'tsx', contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {DashboardUsageJournal} from './src/features/admin/dashboard-usage/DashboardUsageJournal';
      import {AdminDashboard} from './src/features/admin/dashboard/AdminDashboard';
      import Header from './src/widgets/layout/Header/Header';
      import adminStyles from './src/app/admin/admin.module.scss';
      const home = location.pathname === '/admin';
      createRoot(document.getElementById('root')).render(<><Header/>{home
        ? <main className={adminStyles.page}><h1>Панель управления</h1><AdminDashboard canAccessSite={true} canReviewUsage={true} topDashboardMode="manage" managerDashboardMode="manage" isTopAreaOnlyUser={false} wholesaleHref="/admin/wholesale/admin"/></main>
        : location.pathname === '/admin/top' ? <main className={adminStyles.page}><h1>HTML-страницы и отчёты</h1></main> : <DashboardUsageJournal/>}</>);
    ` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' }, alias: { '@': path.join(root, 'src') },
    plugins: [{ name: 'fixtures', setup(plugin) {
      plugin.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'link', namespace: 'fixture' }));
      plugin.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'fixture' }));
      plugin.onResolve({ filter: /^next\/dynamic$/ }, () => ({ path: 'dynamic', namespace: 'fixture' }));
      plugin.onResolve({ filter: /^@\/shared\/lib\/useSiteSettings$/ }, () => ({ path: 'settings', namespace: 'fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: fixture }) => ({ contents: fixture === 'navigation'
        ? `export const usePathname = () => location.pathname; export const useRouter = () => ({push: href => location.assign(href)});`
        : fixture === 'dynamic' ? `export default function dynamic(){return () => null;}`
        : fixture === 'settings' ? `export const useSiteSettings = () => ({phone:'+7 000 000 00 00'});`
        : `import React from 'react'; export default function Link({replace,scroll,prefetch,...props}) { return React.createElement('a', props); }`, loader: 'js', resolveDir: root }));
      plugin.onLoad({ filter: /\.module\.scss$/ }, (args) => {
        const contents = compile(args.path, { importers: [{ findFileUrl(url) {
          return url.startsWith('@/') ? pathToFileURL(path.join(root, 'src', url.slice(2))) : null;
        } }] }).css;
        const names = [...new Set([...contents.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => match[1]))];
        const prefix = `fixture${styleIndex++}_`;
        css += contents.replace(/\.([a-zA-Z_][\w-]*)/g, (_, name) => `.${prefix}${name}`);
        return { contents: `export default ${JSON.stringify(Object.fromEntries(names.map((name) => [name, prefix + name])))}`, loader: 'js' };
      });
    } }],
  });
  const stamp = '2026-10-13T10:00:00.000Z';
  const employee = { actorKey: 'manager:1', actorName: 'Тестовый сотрудник', actorRole: 'manager', lastOpenedAt: stamp,
    lastUsedAt: stamp, lastInteractionAt: stamp, lastDashboardKey: 'top:10', lastDashboardTitle: 'Тестовый отчёт',
    reportCount: 2, interactionCount: 3, uploadCount: 1, viewingSeconds: 125 };
  const never = { ...employee, actorKey: 'admin:2', actorName: 'Без использования', actorRole: 'top',
    lastOpenedAt: null, lastUsedAt: null, lastInteractionAt: null, lastDashboardKey: null, lastDashboardTitle: null,
    reportCount: 0, interactionCount: 0, uploadCount: 0, viewingSeconds: 0 };
  const event = { id: '12', actorKey: employee.actorKey, actorName: employee.actorName, actorRole: employee.actorRole,
    dashboardKey: 'top:10', dashboardTitle: 'Тестовый отчёт', action: 'data_loaded', preview: false,
    versionId: 7, createdAt: stamp, hasProfitabilityDetails: true,
    upload: { name: 'счёт-тест.xlsx', size: 2048 }, uploadType: null, durationSeconds: null };
  const requests: URL[] = [];
  let rejectNextSummary = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (['/', '/admin', '/admin/top', '/admin/dashboard-usage'].includes(url.pathname)) return void res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script></html>');
    if (url.pathname === '/app.js') return void res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    if (url.pathname === '/style.css') return void res.writeHead(200, { 'Content-Type': 'text/css' }).end(globalCss + css);
    if (url.pathname === '/img/logo.svg') return void res.writeHead(200, { 'Content-Type': 'image/svg+xml' }).end(logo);
    if (/^\/fonts\/montserrat\/montserrat-[a-z-]+\.woff2$/.test(url.pathname)) {
      return void res.writeHead(200, { 'Content-Type': 'font/woff2' }).end(await readFile(path.join(root, 'public', url.pathname)));
    }
    if (!url.pathname.startsWith('/api/admin/dashboard-usage')) return void res.writeHead(404).end();
    assert.equal(req.method, 'GET'); requests.push(url);
    const json = (body: unknown, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    if (url.pathname.endsWith('/profitability')) return void json({ invoice: { documentType: 'invoice', invoiceNumber: 'TEST-001',
      currency: 'EUR', dealAmount: 1250, amountSource: 'document', lines: [{ nomenclature: 'Тестовая позиция', quantity: 5 }] } });
    if (url.searchParams.get('view') === 'employees') {
      if (rejectNextSummary) { rejectNextSummary = false; return void json({ error: 'Тестовый временный сбой' }, 503); }
      const employees = url.searchParams.has('after') ? [{ ...employee, actorKey: 'manager:3', actorName: 'Следующая страница' }]
        : url.searchParams.has('search') ? [employee] : [employee, never];
      return void json({ employees, nextCursor: url.searchParams.has('after') || url.searchParams.has('search') ? null : 'manager:1',
        periodStart: '2026-09-13T10:00:00.000Z', generatedAt: stamp });
    }
    if (url.searchParams.get('view') === 'employee') return void json({ reports: [{ dashboardKey: 'top:10', dashboardTitle: 'Тестовый отчёт',
      lastOpenedAt: stamp, lastUsedAt: stamp, openCount: 2, interactionCount: 3, uploadCount: 1, viewingSeconds: 125 }], nextCursor: null });
    return void json({ events: [{ ...event, id: url.searchParams.has('before') ? '11' : '12', preview: url.searchParams.get('preview') === '1' }],
      nextCursor: url.searchParams.has('before') ? null : '12' });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const engineName of ['chromium', 'webkit']) {
      const browser = await playwright[engineName].launch({ headless: true });
      try {
        const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
        await context.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
        const page = await context.newPage(), errors: string[] = [];
        page.on('pageerror', (error: Error) => errors.push(error.message));
        await page.goto(origin + '/admin/dashboard-usage');
        await page.getByRole('heading', { name: 'Журнал и сотрудники', exact: true }).waitFor();
        await page.evaluate(() => document.fonts.ready);
        const journalNavigation = page.getByRole('navigation', { name: 'Навигация журнала' });
        for (const width of [1920, 1400, 1024, 800, 768, 600, 450, 375, 320]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
          const geometry = await page.evaluate(() => {
            const site = document.querySelector('#root > header')!.getBoundingClientRect();
            const main = document.querySelector('main')!;
            const heading = main.querySelector('h1')!.getBoundingClientRect();
            const nav = main.querySelector('nav')!.getBoundingClientRect();
            return { headerBottom: site.bottom, titleTop: heading.top, navTop: nav.top,
              overflow: document.documentElement.scrollWidth - innerWidth };
          });
          assert.ok(geometry.titleTop >= geometry.headerBottom + 12, `${engineName} ${width}: heading overlaps fixed header: ${JSON.stringify(geometry)}`);
          assert.ok(geometry.titleTop - geometry.headerBottom < 110, `${engineName} ${width}: unnecessary top gap`);
          assert.ok(geometry.navTop > geometry.headerBottom, `${engineName} ${width}: back navigation hidden by header`);
          assert.ok(geometry.overflow <= 1, `${engineName} ${width}: horizontal page overflow`);
          await page.screenshot({ path: path.join(screenshots, `${engineName}-header-${width}.png`) });
        }
        await page.setViewportSize({ width: 1400, height: 1000 });
        await journalNavigation.getByRole('link', { name: 'В админку' }).click();
        await page.getByRole('heading', { name: 'Панель управления', exact: true }).waitFor();
        const journalCard = page.getByRole('link', { name: /Журнал и сотрудники/ });
        assert.equal(await journalCard.getAttribute('href'), '/admin/dashboard-usage');
        await page.screenshot({ path: path.join(screenshots, `${engineName}-admin-card.png`), fullPage: true });
        await journalCard.click();
        await page.getByRole('heading', { name: 'Журнал и сотрудники', exact: true }).waitFor();
        await journalNavigation.getByRole('link', { name: 'К отчётам', exact: true }).click();
        await page.getByRole('heading', { name: 'HTML-страницы и отчёты', exact: true }).waitFor();
        await page.goBack();
        await page.getByRole('heading', { name: 'Журнал и сотрудники', exact: true }).waitFor();
        const summary = page.getByRole('region', { name: 'Последняя активность сотрудников' });
        await summary.getByRole('button', { name: never.actorName, exact: true }).waitFor();
        assert.match(await summary.innerText(), /Просмотр: 2 мин 5 с/);
        assert.match(await summary.innerText(), /Нет зафиксированного использования/);
        await summary.getByRole('button', { name: 'Ещё 50 сотрудников' }).click();
        await summary.getByRole('button', { name: 'Следующая страница' }).waitFor();
        await summary.getByRole('searchbox', { name: 'Сотрудник' }).fill('Тестовый');
        await summary.getByRole('button', { name: 'Найти', exact: true }).click();
        await page.waitForFunction(() => !document.body.textContent?.includes('Следующая страница'));
        assert.equal(await summary.getByRole('button', { name: never.actorName, exact: true }).count(), 0);
        await summary.getByRole('button', { name: employee.actorName, exact: true }).click();
        await page.getByRole('heading', { name: `События: ${employee.actorName}` }).waitFor();
        await page.waitForFunction(() => {
          const header = document.querySelector('#root > header')!.getBoundingClientRect();
          const target = document.querySelector('#usage-events-heading')!.getBoundingClientRect();
          return target.top >= header.bottom && target.bottom < innerHeight;
        });
        const reports = page.getByRole('region', { name: 'Отчёты сотрудника за последний месяц' });
        await reports.getByRole('button', { name: 'Тестовый отчёт', exact: true }).click();
        await page.waitForFunction(() => document.body.textContent?.includes('Фильтр: Тестовый сотрудник · top:10'));
        assert.match(await reports.innerText(), /2 мин 5 с/);
        await page.getByRole('button', { name: 'Детализация загруженного счёта', exact: true }).click();
        await page.getByRole('heading', { name: 'Счёт: TEST-001' }).waitFor();
        assert.match(await page.getByRole('region', { name: 'Детализация загруженного счёта' }).innerText(), /Тестовая позиция/);
        assert.match(await page.locator('body').innerText(), /счёт-тест.xlsx · 2.0 КБ/);
        await page.getByRole('checkbox', { name: 'Включить предпросмотры и архив' }).check();
        await page.getByRole('cell', { name: 'Предпросмотр / архив', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Показать ещё 50', exact: true }).click();
        await page.waitForFunction(() => [...document.querySelectorAll('button')].filter(b => b.textContent === 'Детализация загруженного счёта').length === 2);
        await Promise.all([
          page.waitForResponse((response: { url(): string }) => new URL(response.url()).searchParams.get('action') === 'file_uploaded'),
          page.getByRole('combobox', { name: 'Действие', exact: true }).selectOption('file_uploaded'),
        ]);
        await page.screenshot({ path: path.join(screenshots, `${engineName}-desktop.png`), fullPage: true });
        rejectNextSummary = true;
        await summary.getByRole('button', { name: 'Обновить сводку' }).click();
        await summary.getByRole('alert').waitFor();
        await summary.getByRole('button', { name: 'Обновить сводку' }).click();
        await summary.getByRole('button', { name: employee.actorName, exact: true }).waitFor();
        assert.equal(await summary.getByRole('alert').count(), 0);
        await page.setViewportSize({ width: 375, height: 812 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Tables must scroll inside their wrappers, not overflow mobile viewport');
        await page.screenshot({ path: path.join(screenshots, `${engineName}-mobile.png`), fullPage: true });
        assert.deepEqual(errors, []);
        assert.ok(requests.some(url => url.searchParams.get('actor') === 'manager:1' && url.searchParams.get('dashboard') === 'top:10'));
        await context.close();
      } finally { await browser.close(); }
    }
    console.log(`Journal real-header layout (320–1920px), home-card/back navigation, summary, drilldown, uploads, invoice detail, filters, pagination and recovery passed Chromium/WebKit. Screenshots: ${screenshots}`);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
