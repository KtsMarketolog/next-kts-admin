/** Synthetic journal UI only: never authenticates against production or writes a real event. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { compile } from 'sass';
import * as XLSX from 'xlsx';
import { buildDashboardUsageWorkbook } from '../src/shared/lib/dashboardUsageExport';
import type { DashboardUsageRow } from '../src/shared/lib/db/dashboardUsageRepo';

async function main() {
  const root = path.resolve('.');
  const runtime = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const playwright = await import(pathToFileURL(path.join(runtime, 'index.mjs')).href);
  const screenshots = await mkdtemp(path.join(tmpdir(), 'kts-usage-journal-ui-'));
  console.log(`Journal UI screenshots: ${screenshots}`);
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
        } }] }).css.replace(/:global\(([^)]+)\)/g, '$1');
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
  let delayNextSummary = false;
  let releaseDelayedSummary: (() => void) | null = null;
  let rejectNextExport = false;
  let delayNextExport = false;
  let releaseDelayedExport: (() => void) | null = null;
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
    if (url.pathname.endsWith('/export')) {
      if (rejectNextExport) { rejectNextExport = false; return void json({ error: 'Слишком много данных для Excel. Сузьте период или выберите сотрудника (не более 5000 строк).' }, 413); }
      const output = () => res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
        .end(buildDashboardUsageWorkbook({ view: 'events', rows: Array.from({ length: 121 }, (_, index) => ({ ...event, id: String(1000 - index) } as DashboardUsageRow)) }, {}));
      if (delayNextExport) { delayNextExport = false; releaseDelayedExport = output; return; }
      return void output();
    }
    if (url.searchParams.get('view') === 'actors') return void json({ actors: [
      { actorKey: 'manager:1', actorName: 'Одинаковое имя', actorRole: 'manager' },
      { actorKey: 'admin:2', actorName: 'Одинаковое имя', actorRole: 'top' },
    ], nextCursor: null });
    if (url.pathname.endsWith('/profitability')) return void json({ invoice: { documentType: 'invoice', invoiceNumber: 'TEST-001',
      currency: 'EUR', dealAmount: 1250, amountSource: 'document', lines: [{ nomenclature: 'Тестовая позиция', quantity: 5 }] } });
    if (url.searchParams.get('view') === 'employees') {
      if (rejectNextSummary) { rejectNextSummary = false; return void json({ error: 'Тестовый временный сбой' }, 503); }
      const employees = url.searchParams.has('after') ? [{ ...employee, actorKey: 'manager:101', actorName: 'Следующая страница сотрудников' }]
        : [employee, ...(url.searchParams.has('search') ? [] : [never]),
          ...Array.from({ length: url.searchParams.has('search') ? 49 : 48 }, (_, index) => ({ ...employee,
            actorKey: `manager:${index + 3}`, actorName: `Тестовый сотрудник ${index + 3}` }))];
      const body = { employees, nextCursor: url.searchParams.has('after') ? null : 'employee-page-2',
        periodStart: '2026-09-13T10:00:00.000Z', generatedAt: stamp };
      if (delayNextSummary) {
        delayNextSummary = false;
        releaseDelayedSummary = () => json({ ...body, employees: [{ ...employee, actorName: 'Устаревший ответ' }] });
        return;
      }
      return void json(body);
    }
    if (url.searchParams.get('view') === 'employee') return void json({ reports: [{
      dashboardKey: url.searchParams.has('after') ? 'top:11' : 'top:10',
      dashboardTitle: url.searchParams.has('after') ? 'Второй отчёт сотрудника' : 'Тестовый отчёт',
      lastOpenedAt: stamp, lastUsedAt: stamp, openCount: 2, interactionCount: 3, uploadCount: 1, viewingSeconds: 125 }],
      nextCursor: url.searchParams.has('after') ? null : 'reports-page-2' });
    return void json({ events: [{ ...event, id: url.searchParams.has('before') ? '11' : '12',
      dashboardTitle: url.searchParams.has('before') ? 'Отчёт второй страницы' : event.dashboardTitle,
      action: url.searchParams.get('action') || event.action, preview: url.searchParams.get('preview') === '1' }],
      nextCursor: url.searchParams.has('before') ? null : '12' });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const engineName of ['chromium', 'webkit']) {
      requests.length = 0; rejectNextSummary = false; delayNextSummary = false; releaseDelayedSummary = null;
      const browser = await playwright[engineName].launch({ headless: true });
      try {
        const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
        await context.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
        const page = await context.newPage(), errors: string[] = [];
        page.setDefaultTimeout(10_000);
        page.on('pageerror', (error: Error) => errors.push(error.message));
        await page.goto(origin + '/admin/dashboard-usage');
        await page.getByRole('heading', { name: 'Журнал и сотрудники', exact: true }).waitFor();
        await page.evaluate(() => document.fonts.ready);
        const activityTab = page.getByRole('tab', { name: 'Активность сотрудников', exact: true });
        const eventsTab = page.getByRole('tab', { name: 'События', exact: true });
        const summary = page.getByRole('tabpanel', { name: 'Активность сотрудников', exact: true });
        const events = page.getByRole('tabpanel', { name: 'События', exact: true });
        const employeeRequests = () => requests.filter(url => url.searchParams.get('view') === 'employee');
        const summaryRequests = () => requests.filter(url => url.searchParams.get('view') === 'employees');
        const eventRequests = () => requests.filter(url => url.pathname === '/api/admin/dashboard-usage' && !['employee', 'employees', 'actors'].includes(url.searchParams.get('view') ?? ''));
        const actorRequests = () => requests.filter(url => url.searchParams.get('view') === 'actors');
        const exportRequests = () => requests.filter(url => url.pathname.endsWith('/export'));
        const invoiceRequests = () => requests.filter(url => url.pathname.endsWith('/profitability'));
        await summary.getByRole('button', { name: employee.actorName, exact: true }).waitFor();
        assert.equal(await activityTab.getAttribute('aria-selected'), 'true');
        assert.equal(eventRequests().length, 0, 'default activity view never eagerly fetches events');
        assert.equal(employeeRequests().length, 0, 'employee reports are lazy');
        assert.equal(invoiceRequests().length, 0, 'invoice data is never prefetched');
        assert.equal(actorRequests().length, 0, 'employee picker is also lazy');
        const help = page.locator('details').filter({ has: page.getByText('Как читать журнал', { exact: true }) });
        assert.equal(await help.getAttribute('open'), null, 'help is collapsed initially');
        const journalNavigation = page.getByRole('navigation', { name: 'Навигация журнала' });
        for (const control of [journalNavigation.getByRole('link', { name: 'Вернуться в панель управления', exact: true }),
          journalNavigation.getByRole('link', { name: 'К отчётам', exact: true }), summary.getByRole('button', { name: 'Найти', exact: true })]) {
          assert.deepEqual(await control.evaluate((element: Element) => {
            const style = getComputedStyle(element);
            return { background: style.backgroundColor, color: style.color, border: style.borderTopWidth, weight: style.fontWeight };
          }), { background: 'rgb(233, 234, 242)', color: 'rgb(36, 38, 51)', border: '0px', weight: '700' },
          'journal secondary controls match standard admin buttons');
        }
        assert.equal(await activityTab.evaluate((element: Element) => getComputedStyle(element).backgroundColor), 'rgb(38, 11, 134)', 'active tab keeps the standard admin primary color');
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
        console.log(`${engineName}: default lazy activity tab and nine header/layout widths passed`);
        await page.setViewportSize({ width: 1400, height: 1000 });
        await page.evaluate(() => scrollTo({ top: 600, behavior: 'instant' }));
        const stickyTabs = await page.getByRole('tablist', { name: 'Разделы журнала' }).evaluate((element: Element) => ({
          position: getComputedStyle(element).position, top: element.getBoundingClientRect().top,
          headerBottom: document.querySelector('#root > header')!.getBoundingClientRect().bottom,
          expectedTop: parseFloat(getComputedStyle(element).top),
        }));
        assert.equal(stickyTabs.position, 'sticky');
        await page.screenshot({ path: path.join(screenshots, `${engineName}-sticky-tabs.png`) });
        assert.ok(stickyTabs.top >= stickyTabs.headerBottom, `sticky tabs remain below the fixed site header: ${JSON.stringify(stickyTabs)}`);
        assert.ok(Math.abs(stickyTabs.top - stickyTabs.expectedTop) <= 1, `sticky tab bar actually sticks: ${JSON.stringify(stickyTabs)}`);
        await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
        const activityTable = summary.getByRole('region', { name: 'Таблица активности сотрудников', exact: true });
        await activityTable.evaluate((element: HTMLElement) => { element.scrollTop = 250; });
        const stickyHead = await activityTable.evaluate((element: HTMLElement) => ({
          scrollTop: element.scrollTop, wrapperTop: element.getBoundingClientRect().top,
          headTop: element.querySelector('thead th')!.getBoundingClientRect().top,
          position: getComputedStyle(element.querySelector('thead th')!).position,
        }));
        assert.ok(stickyHead.scrollTop > 0);
        assert.equal(stickyHead.position, 'sticky');
        assert.ok(Math.abs(stickyHead.headTop - stickyHead.wrapperTop) <= 2, 'table header stays visible when its bounded result area scrolls');
        await activityTable.evaluate((element: HTMLElement) => { element.scrollTop = 0; });
        await journalNavigation.getByRole('link', { name: 'Вернуться в панель управления' }).click();
        await page.getByRole('heading', { name: 'Панель управления', exact: true }).waitFor();
        assert.deepEqual(await page.evaluate(() => [getComputedStyle(document.documentElement).overflowX, getComputedStyle(document.body).overflowX]),
          ['hidden', 'hidden'], 'journal-only sticky overflow adjustment must not affect the admin home');
        const journalCard = page.getByRole('link', { name: /Журнал и сотрудники/ });
        assert.equal(await journalCard.getAttribute('href'), '/admin/dashboard-usage');
        await page.screenshot({ path: path.join(screenshots, `${engineName}-admin-card.png`), fullPage: true });
        await journalCard.click();
        await page.getByRole('heading', { name: 'Журнал и сотрудники', exact: true }).waitFor();
        await journalNavigation.getByRole('link', { name: 'К отчётам', exact: true }).click();
        await page.getByRole('heading', { name: 'HTML-страницы и отчёты', exact: true }).waitFor();
        await page.goBack();
        await page.getByRole('heading', { name: 'Журнал и сотрудники', exact: true }).waitFor();
        await summary.getByRole('button', { name: never.actorName, exact: true }).waitFor();
        assert.match(await summary.innerText(), /2 мин 5 с/);
        assert.equal(await summary.locator('tbody tr').count(), 50);
        await page.screenshot({ path: path.join(screenshots, `${engineName}-desktop-activity.png`), fullPage: true });
        const activityEmployeeButton = summary.getByRole('button', { name: employee.actorName, exact: true });
        await activityEmployeeButton.click();
        const activityEmployeeDialog = page.getByRole('dialog', { name: `Сотрудник: ${employee.actorName}`, exact: true });
        await activityEmployeeDialog.getByRole('button', { name: `События: ${event.dashboardTitle}`, exact: true }).waitFor();
        assert.equal(eventRequests().length, 0, 'employee report drawer does not eagerly load event history');
        assert.equal(employeeRequests().length, 1);
        await page.screenshot({ path: path.join(screenshots, `${engineName}-desktop-employee-drawer.png`) });
        await activityEmployeeDialog.getByRole('button', { name: 'Закрыть подробности', exact: true }).click();
        await activityEmployeeDialog.waitFor({ state: 'hidden' });
        assert.ok(await activityEmployeeButton.evaluate((element: Element) => document.activeElement === element));
        await summary.getByRole('button', { name: 'Далее', exact: true }).click();
        await summary.getByRole('button', { name: 'Следующая страница сотрудников', exact: true }).waitFor();
        assert.equal(await summary.locator('tbody tr').count(), 1, 'next page replaces rows instead of appending');
        assert.match(await summary.innerText(), /Страница 2/);
        assert.ok(await summary.getByRole('button', { name: 'Далее', exact: true }).isDisabled());
        await summary.getByRole('button', { name: 'Назад', exact: true }).click();
        await summary.getByRole('button', { name: never.actorName, exact: true }).waitFor();
        assert.equal(await summary.locator('tbody tr').count(), 50);
        await summary.getByRole('searchbox', { name: 'Сотрудник' }).fill('Тестовый');
        await Promise.all([
          page.waitForResponse((response: { url(): string }) => new URL(response.url()).searchParams.get('search') === 'Тестовый'),
          summary.getByRole('button', { name: 'Найти', exact: true }).click(),
        ]);
        assert.equal(await summary.getByRole('button', { name: never.actorName, exact: true }).count(), 0);
        await summary.getByRole('button', { name: 'Далее', exact: true }).click();
        await summary.getByRole('button', { name: 'Следующая страница сотрудников', exact: true }).waitFor();
        const beforeInactiveSummary = summaryRequests().length;
        await eventsTab.click();
        await events.getByRole('button', { name: /^Подробнее/ }).waitFor();
        assert.equal(await eventsTab.getAttribute('aria-selected'), 'true');
        assert.equal(summaryRequests().length, beforeInactiveSummary, 'inactive employee tab does not refetch');
        assert.equal(employeeRequests().length, 1, 'switching tabs does not fetch employee reports again');
        await Promise.all([
          page.waitForResponse((response: { url(): string }) => new URL(response.url()).searchParams.get('action') === 'file_uploaded'),
          events.getByRole('combobox', { name: 'Действие', exact: true }).selectOption('file_uploaded'),
        ]);
        await events.getByRole('checkbox', { name: 'Включить предпросмотры и архив' }).check();
        await events.getByText('Предпросмотр / архив', { exact: true }).waitFor();
        await events.getByRole('button', { name: 'Далее', exact: true }).click();
        await events.getByRole('button', { name: 'Отчёт второй страницы', exact: true }).waitFor();
        assert.equal(await events.getByRole('button', { name: /^Подробнее/ }).count(), 1, 'event pagination remains bounded');
        assert.match(await events.innerText(), /Страница 2/);
        const beforeInactiveEvents = eventRequests().length;
        await activityTab.click();
        await summary.getByRole('button', { name: 'Следующая страница сотрудников', exact: true }).waitFor();
        assert.equal(await summary.getByRole('searchbox', { name: 'Сотрудник' }).inputValue(), 'Тестовый');
        assert.match(await summary.innerText(), /Страница 2/);
        assert.equal(eventRequests().length, beforeInactiveEvents, 'inactive event tab does not refetch');
        await eventsTab.click();
        await events.getByRole('button', { name: 'Отчёт второй страницы', exact: true }).waitFor();
        assert.equal(await events.getByRole('combobox', { name: 'Действие', exact: true }).inputValue(), 'file_uploaded');
        assert.ok(await events.getByRole('checkbox', { name: 'Включить предпросмотры и архив' }).isChecked());
        assert.match(await events.innerText(), /Страница 2/);
        await events.getByRole('button', { name: 'Назад', exact: true }).click();
        await events.getByRole('button', { name: event.dashboardTitle, exact: true }).waitFor();
        assert.match(await events.innerText(), /Страница 1/);
        console.log(`${engineName}: bounded pagination and search/filter/cursor preservation passed`);

        const employeeButton = events.getByRole('button', { name: employee.actorName, exact: true });
        const employeeRequestCount = employeeRequests().length;
        await employeeButton.click();
        const employeeDialog = page.getByRole('dialog', { name: `Сотрудник: ${employee.actorName}`, exact: true });
        await employeeDialog.getByRole('button', { name: `События: ${event.dashboardTitle}`, exact: true }).waitFor();
        assert.equal(await employeeDialog.evaluate((element: Element) => element.tagName), 'DIALOG');
        assert.equal(employeeRequests().length, employeeRequestCount + 1, 'report details only load after an explicit employee click');
        assert.match(await employeeDialog.innerText(), /2 мин 5 с/);
        await employeeDialog.getByRole('button', { name: 'Далее', exact: true }).click();
        await employeeDialog.getByRole('button', { name: 'События: Второй отчёт сотрудника', exact: true }).waitFor();
        assert.equal(await employeeDialog.getByRole('button', { name: `События: ${event.dashboardTitle}`, exact: true }).count(), 0);
        await employeeDialog.getByRole('button', { name: 'Назад', exact: true }).click();
        await employeeDialog.getByRole('button', { name: `События: ${event.dashboardTitle}`, exact: true }).waitFor();
        await page.keyboard.press('Escape');
        await employeeDialog.waitFor({ state: 'hidden' });
        assert.ok(await employeeButton.evaluate((element: Element) => document.activeElement === element), 'Escape restores focus to employee trigger');
        await employeeButton.click();
        await employeeDialog.getByRole('button', { name: 'Посмотреть события', exact: true }).click();
        await employeeDialog.waitFor({ state: 'hidden' });
        await page.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === 'События');
        await events.getByRole('button', { name: employee.actorName, exact: true }).waitFor();
        assert.equal(eventRequests().at(-1)?.searchParams.get('actor'), employee.actorKey);
        assert.equal(await events.getByRole('combobox', { name: 'Действие', exact: true }).inputValue(), '', 'employee drilldown shows all actions rather than inheriting an unrelated action filter');
        assert.equal(await events.getByRole('checkbox', { name: 'Включить предпросмотры и архив' }).isChecked(), false, 'employee drilldown starts from published report events');
        assert.equal(eventRequests().at(-1)?.searchParams.has('action'), false);
        assert.equal(eventRequests().at(-1)?.searchParams.has('preview'), false);
        await events.getByRole('button', { name: employee.actorName, exact: true }).click();
        await employeeDialog.getByRole('button', { name: `События: ${event.dashboardTitle}`, exact: true }).click();
        await employeeDialog.waitFor({ state: 'hidden' });
        await events.getByRole('button', { name: /^Подробнее/ }).waitFor();
        assert.equal(eventRequests().at(-1)?.searchParams.get('actor'), employee.actorKey);
        assert.equal(eventRequests().at(-1)?.searchParams.get('dashboard'), event.dashboardKey);

        const detailsButton = events.getByRole('button', { name: /^Подробнее/ });
        assert.equal(invoiceRequests().length, 0);
        await detailsButton.click();
        const eventDialog = page.getByRole('dialog', { name: 'Подробности события', exact: true });
        await eventDialog.waitFor();
        assert.equal(await eventDialog.evaluate((element: Element) => element.tagName), 'DIALOG');
        assert.match(await eventDialog.innerText(), /счёт-тест.xlsx/);
        assert.match(await eventDialog.innerText(), /2.0 КБ/);
        assert.equal(invoiceRequests().length, 0, 'opening event metadata must not fetch invoice contents');
        await eventDialog.getByRole('button', { name: 'Детализация загруженного счёта', exact: true }).click();
        await eventDialog.getByRole('heading', { name: 'Счёт: TEST-001', exact: true }).waitFor();
        assert.match(await eventDialog.innerText(), /Тестовая позиция/);
        assert.equal(invoiceRequests().length, 1);
        await page.screenshot({ path: path.join(screenshots, `${engineName}-desktop-event-drawer.png`) });
        await page.keyboard.press('Escape');
        await eventDialog.waitFor({ state: 'hidden' });
        assert.ok(await detailsButton.evaluate((element: Element) => document.activeElement === element), 'event dialog returns focus');
        await detailsButton.click();
        await eventDialog.waitFor();
        assert.equal(invoiceRequests().length, 1, 'reopening metadata never implicitly fetches invoice');
        await eventDialog.getByRole('button', { name: 'Закрыть подробности', exact: true }).click();
        await eventDialog.waitFor({ state: 'hidden' });
        await detailsButton.click();
        await eventDialog.waitFor();
        const dialogBox = await eventDialog.boundingBox(); assert.ok(dialogBox && dialogBox.x > 8);
        await page.mouse.click(dialogBox.x / 2, Math.min(500, dialogBox.y + dialogBox.height / 2));
        await eventDialog.waitFor({ state: 'hidden' });
        assert.ok(await detailsButton.evaluate((element: Element) => document.activeElement === element), 'backdrop closes the dialog and restores focus');
        await Promise.all([
          page.waitForResponse((response: { url(): string }) => {
            const url = new URL(response.url());
            return url.pathname === '/api/admin/dashboard-usage' && !url.searchParams.has('actor') && url.searchParams.get('dashboard') === event.dashboardKey;
          }),
          events.getByRole('button', { name: 'Убрать фильтр сотрудника', exact: true }).click(),
        ]);
        await events.getByRole('button', { name: /^Подробнее/ }).waitFor();
        assert.equal(await events.getByRole('button', { name: 'Убрать фильтр сотрудника', exact: true }).count(), 0);
        await Promise.all([
          page.waitForResponse((response: { url(): string }) => {
            const url = new URL(response.url());
            return url.pathname === '/api/admin/dashboard-usage' && !url.searchParams.has('dashboard') && !url.searchParams.has('view');
          }),
          events.getByRole('button', { name: 'Убрать фильтр дашборда', exact: true }).click(),
        ]);
        await events.getByRole('button', { name: event.dashboardTitle, exact: true }).click();
        await events.getByRole('button', { name: 'Убрать фильтр дашборда', exact: true }).waitFor();
        await events.getByRole('button', { name: 'Сбросить фильтры', exact: true }).click();
        await events.getByRole('button', { name: /^Подробнее/ }).waitFor();
        assert.equal(await events.getByRole('combobox', { name: 'Действие', exact: true }).inputValue(), '');
        assert.equal(await events.getByRole('checkbox', { name: 'Включить предпросмотры и архив' }).isChecked(), false);
        assert.equal(await events.getByRole('button', { name: 'Убрать фильтр дашборда', exact: true }).count(), 0);
        console.log(`${engineName}: lazy employee/event/invoice dialogs, focus and filter chips passed`);
        await page.screenshot({ path: path.join(screenshots, `${engineName}-desktop.png`), fullPage: true });
        await activityTab.click();
        await summary.getByRole('button', { name: employee.actorName, exact: true }).waitFor();
        assert.match(await summary.innerText(), /Страница 1/, 'changing the shared employee filter resets the activity cursor');
        rejectNextSummary = true;
        await summary.getByRole('button', { name: 'Обновить сводку' }).click();
        await summary.getByRole('alert').waitFor();
        await summary.getByRole('button', { name: 'Обновить сводку' }).click();
        await summary.getByRole('button', { name: employee.actorName, exact: true }).waitFor();
        assert.equal(await summary.getByRole('alert').count(), 0);
        delayNextSummary = true;
        await Promise.all([
          page.waitForRequest((request: { url(): string }) => new URL(request.url()).searchParams.get('view') === 'employees'),
          summary.getByRole('button', { name: 'Обновить сводку' }).click(),
        ]);
        for (let attempt = 0; attempt < 20 && !releaseDelayedSummary; attempt += 1) await page.waitForTimeout(10);
        const releaseSummary = releaseDelayedSummary as (() => void) | null;
        assert.ok(releaseSummary, 'fixture holds the in-flight summary response');
        await eventsTab.click();
        await events.getByRole('button', { name: /^Подробнее/ }).waitFor();
        releaseSummary(); releaseDelayedSummary = null;
        await activityTab.click();
        await summary.getByRole('button', { name: employee.actorName, exact: true }).waitFor();
        assert.equal(await page.getByText('Устаревший ответ', { exact: true }).count(), 0, 'aborted inactive-tab response cannot overwrite the active summary');

        const common = page.getByRole('region', { name: 'Общие фильтры журнала' });
        await common.getByLabel('Дата с (МСК)').fill('2026-10-14');
        await common.getByLabel('Дата по (МСК)').fill('2026-10-13');
        const beforeInvalid = summaryRequests().length;
        assert.ok(await common.getByRole('button', { name: 'Выгрузить в Excel' }).isDisabled());
        await common.getByRole('button', { name: 'Применить период' }).click();
        await common.getByRole('alert').filter({ hasText: 'Начало периода' }).waitFor();
        assert.equal(summaryRequests().length, beforeInvalid, 'invalid range never queries API');
        await common.getByLabel('Дата с (МСК)').fill('2026-10-12');
        await common.getByRole('button', { name: 'Применить период' }).click();
        await summary.getByRole('button', { name: employee.actorName, exact: true }).waitFor();
        assert.equal(summaryRequests().at(-1)?.searchParams.get('from'), '2026-10-12');
        assert.equal(summaryRequests().at(-1)?.searchParams.get('to'), '2026-10-13');
        await common.locator('summary').click();
        await common.getByRole('button', { name: /Одинаковое имя.*manager:1/ }).waitFor();
        assert.equal(actorRequests().length, 1);
        await common.getByRole('searchbox', { name: 'Поиск сотрудника' }).fill('Одинаковое');
        await common.getByRole('button', { name: 'Искать', exact: true }).click();
        await common.getByRole('button', { name: /Одинаковое имя.*admin:2/ }).click();
        await summary.getByRole('button', { name: employee.actorName, exact: true }).waitFor();
        assert.equal(summaryRequests().at(-1)?.searchParams.get('actor'), 'admin:2', 'identical names select exact account key');
        assert.equal(summaryRequests().at(-1)?.searchParams.has('after'), false);
        await summary.getByRole('button', { name: employee.actorName, exact: true }).click();
        await employeeDialog.getByRole('button', { name: `События: ${event.dashboardTitle}`, exact: true }).waitFor();
        assert.equal(employeeRequests().at(-1)?.searchParams.get('from'), '2026-10-12');
        assert.equal(employeeRequests().at(-1)?.searchParams.get('to'), '2026-10-13');
        await page.keyboard.press('Escape');
        await employeeDialog.waitFor({ state: 'hidden' });
        await summary.getByRole('button', { name: 'Далее', exact: true }).click();
        await summary.getByRole('button', { name: 'Следующая страница сотрудников', exact: true }).waitFor();
        const [summaryDownload] = await Promise.all([page.waitForEvent('download'), common.getByRole('button', { name: 'Выгрузить в Excel' }).click()]);
        await summaryDownload.path();
        assert.equal(exportRequests().at(-1)?.searchParams.get('view'), 'employees');
        assert.equal(exportRequests().at(-1)?.searchParams.get('actor'), 'admin:2');
        assert.equal(exportRequests().at(-1)?.searchParams.get('search'), 'Тестовый');
        assert.equal(exportRequests().at(-1)?.searchParams.has('after'), false);
        await eventsTab.click();
        await events.getByRole('button', { name: /^Подробнее/ }).waitFor();
        await events.getByRole('combobox', { name: 'Действие', exact: true }).selectOption('file_uploaded');
        await events.getByRole('checkbox', { name: 'Включить предпросмотры и архив' }).check();
        await events.getByRole('button', { name: event.dashboardTitle, exact: true }).click();
        await events.getByRole('button', { name: 'Далее', exact: true }).click();
        await events.getByRole('button', { name: 'Отчёт второй страницы', exact: true }).waitFor();
        const [download] = await Promise.all([page.waitForEvent('download'), common.getByRole('button', { name: 'Выгрузить в Excel' }).click()]);
        const file = await download.path(); assert.ok(file);
        const workbook = XLSX.read(await readFile(file));
        assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets['События']).length, 121, 'download is the full filtered result, not the current one-row page');
        const exportQuery = exportRequests().at(-1)!.searchParams;
        assert.deepEqual(Object.fromEntries(exportQuery), { view: 'events', from: '2026-10-12', to: '2026-10-13', actor: 'admin:2', dashboard: 'top:10', action: 'file_uploaded', preview: '1' });
        rejectNextExport = true;
        await common.getByRole('button', { name: 'Выгрузить в Excel' }).click();
        await common.getByRole('alert').filter({ hasText: 'Слишком много данных' }).waitFor();
        assert.ok(await common.getByRole('button', { name: 'Выгрузить в Excel' }).isEnabled());
        delayNextExport = true; let lateDownloads = 0;
        const countDownload = () => { lateDownloads++; }; page.on('download', countDownload);
        await common.getByRole('button', { name: 'Выгрузить в Excel' }).click();
        for (let attempt = 0; attempt < 50 && !releaseDelayedExport; attempt++) await page.waitForTimeout(10);
        const releaseExport = releaseDelayedExport as (() => void) | null; assert.ok(releaseExport);
        await common.getByRole('button', { name: 'Сбросить период' }).click();
        releaseExport(); releaseDelayedExport = null;
        await events.getByRole('button', { name: event.dashboardTitle, exact: true }).waitFor();
        await page.waitForTimeout(100);
        assert.equal(lateDownloads, 0, 'changing filters aborts old export and ignores late file');
        page.off('download', countDownload);
        await common.getByRole('button', { name: 'Все сотрудники', exact: true }).click();
        await activityTab.click();
        await summary.getByRole('button', { name: employee.actorName, exact: true }).waitFor();
        assert.equal(summaryRequests().at(-1)?.searchParams.has('actor'), false);
        assert.equal(summaryRequests().at(-1)?.searchParams.has('from'), false);
        console.log(`${engineName}: shared Moscow period/exact employee filters, full XLSX export, overflow and late-response cancellation passed`);
        await page.setViewportSize({ width: 375, height: 812 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Tables must scroll inside their wrappers, not overflow mobile viewport');
        await page.screenshot({ path: path.join(screenshots, `${engineName}-mobile.png`), fullPage: true });
        await summary.getByRole('button', { name: employee.actorName, exact: true }).click();
        await employeeDialog.getByRole('button', { name: `События: ${event.dashboardTitle}`, exact: true }).waitFor();
        const mobileDrawer = await employeeDialog.boundingBox(); assert.ok(mobileDrawer);
        assert.ok(mobileDrawer.x >= 0 && mobileDrawer.x + mobileDrawer.width <= 375, 'mobile drawer stays inside viewport');
        assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden', 'modal locks background scroll');
        await page.screenshot({ path: path.join(screenshots, `${engineName}-mobile-employee-drawer.png`) });
        await page.keyboard.press('Escape');
        await employeeDialog.waitFor({ state: 'hidden' });
        assert.notEqual(await page.evaluate(() => document.body.style.overflow), 'hidden', 'closing restores background scroll');
        assert.deepEqual(errors, []);
        assert.ok(requests.some(url => url.searchParams.get('actor') === 'manager:1' && url.searchParams.get('dashboard') === 'top:10'));
        await context.close();
      } finally { await browser.close(); }
    }
    console.log(`Journal real-header layout (320–1920px), lazy tabs/drawers/invoice, bounded pagination, preserved state, dialog focus, abort/recovery and navigation passed Chromium/WebKit. Screenshots: ${screenshots}`);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
