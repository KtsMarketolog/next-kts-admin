/** Local synthetic fixtures only; never opens production or creates real employee activity. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { compile } from 'sass';
import { canManageKnowledgeBase } from '../src/shared/lib/knowledgeBase';
import type { KnowledgeBaseNode } from '../src/shared/lib/knowledgeBase';
import type { AdminSession } from '../src/shared/lib/adminAuth';

async function main() {
  const root = path.resolve('.');
  const runtime = process.env.PLAYWRIGHT_MODULE_PATH ?? path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const playwright = await import(pathToFileURL(path.join(runtime, 'index.mjs')).href);
  const output = await mkdtemp(path.join(tmpdir(), 'kts-knowledge-base-ui-'));
  let css = '', index = 0;
  const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import Header from './src/widgets/layout/Header/Header';
    import {KnowledgeBase} from './src/features/admin/knowledge-base/KnowledgeBase';
    import {canManageKnowledgeBase} from './src/shared/lib/knowledgeBase';
    const folder=new URLSearchParams(location.search).get('folder');
    const parentId=folder&&/^[1-9]\\d*$/.test(folder)&&Number.isSafeInteger(Number(folder))?Number(folder):null;
    const session=location.search.includes('reader=1')?{role:'manager',managerId:1,canManageTopDashboard:true,sessionId:'00000000-0000-4000-8000-000000000001'}:{role:'top',adminUserId:7,sessionId:'00000000-0000-4000-8000-000000000007'};
    createRoot(document.getElementById('root')).render(<><Header/><KnowledgeBase initialCanManage={canManageKnowledgeBase(session)} initialParentId={parentId}/></>);
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' }, alias: { '@': path.join(root, 'src') }, plugins: [{ name: 'fixtures', setup(plugin) {
      plugin.onResolve({ filter: /^next\/(link|navigation|dynamic)$/ }, ({ path: name }) => ({ path: name, namespace: 'fixture' }));
      plugin.onResolve({ filter: /^@\/shared\/lib\/useSiteSettings$/ }, () => ({ path: 'settings', namespace: 'fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({ contents: name.endsWith('navigation')
        ? `export const usePathname=()=>location.pathname;export const useRouter=()=>({push:href=>location.assign(href)});`
        : name.endsWith('dynamic') ? 'export default function dynamic(){return ()=>null;}'
        : name === 'settings' ? `export const useSiteSettings=()=>({phone:'+7 000 000 00 00'});`
        : `import React from 'react';export default function Link({replace,scroll,prefetch,...props}){return React.createElement('a',props);}`, loader: 'js', resolveDir: root }));
      plugin.onLoad({ filter: /\.module\.scss$/ }, (args) => {
        const contents = compile(args.path, { importers: [{ findFileUrl(url) { return url.startsWith('@/') ? pathToFileURL(path.join(root, 'src', url.slice(2))) : null; } }] }).css.replace(/:global\(([^)]+)\)/g, '$1');
        const names = [...new Set([...contents.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => match[1]))];
        const prefix = `kbfixture${index++}_`;
        css += contents.replace(/\.([a-zA-Z_][\w-]*)/g, (_, name) => `.${prefix}${name}`);
        return { contents: `export default ${JSON.stringify(Object.fromEntries(names.map((name) => [name, prefix + name])))}`, loader: 'js' };
      });
    } }],
  });
  const globalCss = await readFile(path.join(root, 'src/app/globals.css'), 'utf8');
  const stamp = '2026-10-21T08:00:00.000Z';
  const folder: KnowledgeBaseNode = { id: 1, parentId: null, kind: 'folder', title: 'Регламенты продаж', revision: '1', archivedAt: null,
    createdAt: stamp, updatedAt: stamp, originalName: null, mimeType: null, size: null, access: { mode: 'custom', actorKeys: ['manager:1'] } };
  const nestedFolder = { ...folder, id: 4, parentId: 1, title: 'Инструкции для новых сотрудников' };
  const longFolder = { ...folder, id: 5, title: 'Положения и инструкции по работе с региональными партнёрами — СправочникДляНовыхСотрудниковПодразделенияПродажИЗакупок' };
  const archivedFolder = { ...folder, id: 6, title: 'Архив регламентов', archivedAt: stamp };
  const openFolderName = (title: string) => `Открыть папку «${title}»`;
  const material = { ...folder, id: 2, parentId: 1, kind: 'file', title: 'Порядок работы с клиентом', originalName: 'regulation.html',
    mimeType: 'text/html', size: 1200, access: { mode: 'inherit', actorKeys: [] } };
  const calls: { path: string; method: string; body: unknown; headers: Record<string, unknown> }[] = [];
  const topSession: AdminSession = { role: 'top', adminUserId: 7, sessionId: '00000000-0000-4000-8000-000000000007' };
  const readerSession: AdminSession = { role: 'manager', managerId: 1, canManageTopDashboard: true, sessionId: '00000000-0000-4000-8000-000000000001' };
  assert.equal(canManageKnowledgeBase(topSession), true, 'real KB policy grants TOP management');
  assert.equal(canManageKnowledgeBase(readerSession), false, 'unrelated TOP-dashboard management flag does not grant KB management');
  let readOnly = false, failList = false, failSave = false, archived = false;
  let moveFixture = false, movePagination = false;
  let moveFailure: 'none' | 'conflict' | 'unknown' = 'none';
  let movePreviewConflict = false;
  let moveNodes: KnowledgeBaseNode[] = [];
  const resetMoves = () => {
    moveFixture = true; movePagination = false; moveFailure = 'none'; movePreviewConflict = false;
    moveNodes = structuredClone([folder, nestedFolder, longFolder, material]) as KnowledgeBaseNode[];
  };
  const movePath = (id: number | null): KnowledgeBaseNode[] => {
    if (id === null) return [];
    const node = moveNodes.find((item) => item.id === id)!;
    return [...movePath(node.parentId), node];
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/app.js') return void response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    if (url.pathname === '/style.css') return void response.writeHead(200, { 'Content-Type': 'text/css' }).end(globalCss + css);
    if (/^\/(img\/logo.svg|fonts\/montserrat\/montserrat-[a-z-]+\.woff2)$/.test(url.pathname)) {
      return void response.writeHead(200, { 'Content-Type': url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'font/woff2' }).end(await readFile(path.join(root, 'public', url.pathname)));
    }
    if (!url.pathname.startsWith('/api/admin/knowledge-base')) {
      return void response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script></html>');
    }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = request.headers['content-type']?.includes('application/json') && raw ? JSON.parse(raw) : raw;
    calls.push({ path: url.pathname + url.search, method: request.method ?? 'GET', body, headers: { ...request.headers } });
    const json = (data: unknown, code = 200) => response.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    if (url.pathname.endsWith('/employees')) return void json({ actors: [
      { actorKey: 'manager:1', actorName: 'Тестовый сотрудник', actorRole: 'manager' },
      { actorKey: 'admin:7', actorName: 'Тестовый руководитель', actorRole: 'top' },
    ], nextCursor: null });
    if (url.pathname.endsWith('/events')) return void json({ recorded: true });
    if (url.pathname.includes('/files/')) return void response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" })
      .end('<!doctype html><html><h1>Тестовый регламент</h1><button onclick="this.textContent=\'Работает\'">Проверить</button><script>try{parent.document.body.dataset.exposed="yes"}catch(e){}</script></html>');
    if (url.pathname.endsWith('/usage')) return void json({ rows: [{ key: url.searchParams.get('view') === 'employees' ? 'manager:1' : '2',
      title: url.searchParams.get('view') === 'employees' ? 'Тестовый сотрудник' : material.title, role: 'manager', sectionOpens: 2,
      folderOpens: 3, fileViews: 4, downloadsStarted: 1, totalEvents: 10, lastVisitAt: stamp }], nextCursor: null });
    if (url.pathname.endsWith('/move')) {
      assert.equal(moveFixture, true);
      const id = Number(url.pathname.split('/').at(-2));
      const source = moveNodes.find((node) => node.id === id)!;
      const destination = moveNodes.find((node) => node.id === body.targetParentId) ?? null;
      assert.equal(readOnly, false, 'reader must never submit a move');
      assert.equal(body.expectedRevision, source.revision);
      assert.notEqual(body.targetParentId, source.id, 'self is not a move target');
      assert.notEqual(body.targetParentId, source.parentId, 'current parent is not a move target');
      assert.ok(source.kind === 'folder' || body.targetParentId !== null, 'files cannot move to root');
      assert.equal(movePath(body.targetParentId).some((node) => node.id === source.id), false, 'descendants cannot be targets');
      if (body.action === 'preview') {
        if (movePreviewConflict) return void json({ error: 'Материал уже изменён. Обновите список.' }, 409);
        return void json({ source, destination, destinationBreadcrumbs: movePath(body.targetParentId), previewToken: `preview-${source.id}-${source.revision}-${body.targetParentId}`,
          affectedCount: moveNodes.filter((node) => movePath(node.id).some((ancestor) => ancestor.id === source.id)).length,
          accessWarning: 'После переноса доступ сотрудников может измениться: он будет ограничен правами новой родительской папки. Проверьте получателей.' });
      }
      assert.equal(body.action, 'commit');
      assert.equal(body.previewToken, `preview-${source.id}-${source.revision}-${body.targetParentId}`);
      if (moveFailure === 'conflict') return void json({ error: 'Данные уже изменены другим пользователем.' }, 409);
      source.parentId = body.targetParentId; source.revision = String(Number(source.revision) + 1);
      if (moveFailure === 'unknown') {
        // Send headers before breaking the body: avoids a browser transport-level retry of
        // an entirely unanswered reused connection, and exercises an unknown application result.
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
        response.write('{'); setTimeout(() => response.destroy(), 30); return;
      }
      return void json(source);
    }
    if (request.method !== 'GET') {
      if (failSave) return void json({ error: 'Данные уже изменены другим пользователем. Обновите список.' }, 409);
      if (body && typeof body === 'object' && 'archived' in body) archived = body.archived;
      return void json({ node: { ...folder, id: 3 }, created: true });
    }
    if (failList) return void json({ error: 'Не удалось загрузить папку' }, 503);
    const parent = url.searchParams.get('parentId');
    if (moveFixture) {
      let nodes = moveNodes.filter((node) => node.parentId === (parent === null ? null : Number(parent)));
      let nextCursor: number | null = null;
      if (movePagination && parent === null) {
        nodes = nodes.filter((node) => node.id > Number(url.searchParams.get('after') ?? 0));
        nextCursor = nodes.length > 1 ? nodes[0].id : null;
        nodes = nodes.slice(0, 1);
      }
      return void json({ nodes, nextCursor, breadcrumbs: movePath(parent === null ? null : Number(parent)), canManage: canManageKnowledgeBase(readOnly ? readerSession : topSession) });
    }
    const inArchive = url.searchParams.get('archived') === '1';
    const materialNodes = archived === inArchive ? [{ ...material, archivedAt: archived ? stamp : null }] : [];
    return void json({ nodes: parent ? [...(parent === '1' && !inArchive ? [nestedFolder] : []), ...materialNodes]
      : inArchive ? [archivedFolder] : [folder, longFolder],
      nextCursor: null, breadcrumbs: parent ? parent === '4' ? [folder, nestedFolder] : [folder] : [], canManage: canManageKnowledgeBase(readOnly ? readerSession : topSession) });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const engine of ['chromium', 'webkit']) {
      const browser = await playwright[engine].launch({ headless: true });
      try {
        for (const width of [1440, 390, 320]) {
          readOnly = false; failList = false; failSave = false; archived = false; moveFixture = false; calls.length = 0;
          const page = await browser.newPage({ viewport: { width, height: 1000 } });
          page.setDefaultTimeout(10_000);
          let scenario = 'existing KB flows';
          const errors: string[] = []; page.on('pageerror', (error: Error) => { errors.push(error.message); console.error(`${engine}/${width} ${scenario}: ${error.message}`); });
          await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          const gotoPage = async (url: string) => {
            // Real folder-open telemetry completes before the fixture navigates away.
            // Otherwise WebKit reports its intentional unload abort as a pageerror.
            await page.waitForLoadState('networkidle');
            await page.goto(url);
            await page.waitForLoadState('networkidle');
          };
          await gotoPage(origin + '/admin/knowledge-base');
          await page.getByRole('button', { name: openFolderName(folder.title), exact: true }).waitFor();
          assert.equal(await page.getByRole('button', { name: 'Создать папку', exact: true }).isEnabled(), true, 'TOP can create folders');
          assert.equal(await page.getByRole('button', { name: 'Статистика использования', exact: true }).isVisible(), true, 'TOP sees usage statistics');
          assert.ok(await page.getByRole('button', { name: 'Настроить', exact: true }).count() > 0, 'TOP can edit folder settings');
          assert.equal(await page.getByRole('button', { name: /^Назад (к списку папок|в папку)/ }).count(), 0, 'root has no folder-back button');
          await page.evaluate(() => document.fonts.ready);
          for (const title of [folder.title, longFolder.title]) {
            const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
            const badge = card.getByText('Папка', { exact: true });
            const badgeBox = await badge.boundingBox();
            const titleBox = await card.getByRole('heading').boundingBox();
            assert.ok(badgeBox && titleBox && badgeBox.height <= 30 && badgeBox.y + badgeBox.height <= titleBox.y, 'compact folder badge sits above title');
            assert.ok(await badge.evaluate((node: HTMLElement) => node.scrollWidth <= node.clientWidth), 'folder label is not clipped');
            assert.ok(await card.evaluate((node: HTMLElement) => node.scrollWidth <= node.clientWidth), 'long folder name stays inside card');
            assert.ok(await card.getByRole('button', { name: openFolderName(title), exact: true }).evaluate((node: HTMLElement) => node.getBoundingClientRect().height) >= 42, 'open folder touch target');
            assert.equal(await card.getByRole('heading').getByRole('button').count(), 0, 'folder title is a clear heading, not hidden navigation');
          }
          assert.equal(calls.some((call) => call.path.includes('/usage')), false, 'statistics lazy');
          assert.equal(calls.some((call) => call.path.includes('/employees')), false, 'employee directory lazy');
          assert.ok(await page.getByRole('heading', { name: 'База знаний', exact: true }).evaluate((node: HTMLElement) => node.getBoundingClientRect().top) > 75, 'title below fixed header');
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no page overflow');
          assert.ok(await page.getByRole('button', { name: 'Обновить', exact: true }).evaluate((node: HTMLElement) => node.getBoundingClientRect().height) < 60, 'toolbar buttons do not stretch to search form height');
          await page.screenshot({ path: path.join(output, `${engine}-${width}-root.png`), fullPage: true });
          await page.getByRole('button', { name: 'Создать папку', exact: true }).click();
          let dialog = page.getByRole('dialog');
          await dialog.getByLabel('Название', { exact: true }).fill('Новая папка');
          const topAccess = dialog.getByRole('checkbox', { name: /Тестовый руководитель.*управляет разделом/ });
          await topAccess.waitFor();
          assert.equal(await topAccess.isChecked(), true, 'TOP always has access without a per-folder grant');
          assert.equal(await topAccess.isDisabled(), true, 'TOP management access cannot be unchecked');
          assert.match(await dialog.innerText(), /Админ.*Админ ТОП.*ТОП.*всегда имеют доступ/);
          await dialog.screenshot({ path: path.join(output, `${engine}-${width}-top-access.png`) });
          await dialog.getByLabel('Тестовый сотрудник', { exact: false }).check();
          failSave = true;
          await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
          await dialog.getByRole('alert').filter({ hasText: 'Данные уже изменены' }).waitFor();
          assert.equal(await dialog.getByRole('button', { name: 'Сохранить', exact: true }).isEnabled(), true);
          const firstOperation = (calls.filter((call) => call.method === 'POST' && call.path === '/api/admin/knowledge-base').at(-1)?.body as { operationId: string }).operationId;
          failSave = false;
          await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
          await page.getByText('Папка создана.', { exact: true }).waitFor();
          const lastOperation = (calls.filter((call) => call.method === 'POST' && call.path === '/api/admin/knowledge-base').at(-1)?.body as { operationId: string }).operationId;
          assert.equal(firstOperation, lastOperation, 'same operation ID for retry');
          const folderCreate = calls.filter((call) => call.method === 'POST' && call.path === '/api/admin/knowledge-base').at(-1)?.body as { access: { actorKeys: string[] } };
          assert.deepEqual(folderCreate.access.actorKeys, ['manager:1'], 'TOP role access is implicit, not stored as a selected employee grant');
          await page.getByRole('button', { name: openFolderName(folder.title), exact: true }).click();
          await page.getByRole('button', { name: material.title, exact: true }).waitFor();
          assert.equal(new URL(page.url()).searchParams.get('folder'), '1');
          assert.ok(calls.some((call) => call.method === 'GET' && call.path.includes('parentId=1')), 'explicit open loads folder');
          const backToRoot = page.getByRole('button', { name: 'Назад к списку папок', exact: true });
          await backToRoot.waitFor();
          assert.ok(await backToRoot.evaluate((node: HTMLElement) => node.getBoundingClientRect().height) >= 42, 'folder-back touch target');
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'folder navigation does not overflow');
          await page.screenshot({ path: path.join(output, `${engine}-${width}-folder-back.png`), fullPage: true });
          const nestedOpen = page.getByRole('button', { name: openFolderName(nestedFolder.title), exact: true });
          await nestedOpen.focus();
          await nestedOpen.press('Enter');
          await page.getByRole('heading', { name: nestedFolder.title, exact: true }).waitFor();
          assert.equal(new URL(page.url()).searchParams.get('folder'), '4');
          assert.ok(calls.some((call) => call.method === 'GET' && call.path.includes('parentId=4')), 'keyboard open loads nested folder');
          const backToParent = page.getByRole('button', { name: `Назад в папку «${folder.title}»`, exact: true });
          await backToParent.waitFor();
          await page.getByRole('searchbox', { name: 'Поиск в текущей папке', exact: true }).fill('порядок');
          const searchResponse = page.waitForResponse((response: { url(): string }) => new URL(response.url()).searchParams.get('search') === 'порядок');
          await page.getByRole('button', { name: 'Найти', exact: true }).click();
          await searchResponse;
          await page.getByRole('heading', { name: nestedFolder.title, exact: true }).waitFor();
          await page.getByRole('button', { name: 'Архив', exact: true }).click();
          await page.getByRole('heading', { name: 'Архив', exact: true }).waitFor();
          await backToParent.focus(); await backToParent.press('Enter');
          await page.getByRole('button', { name: openFolderName(nestedFolder.title), exact: true }).waitFor();
          assert.equal(new URL(page.url()).searchParams.get('folder'), '1', 'nested folder-back opens its actual parent');
          assert.equal(await page.getByRole('searchbox', { name: 'Поиск в текущей папке', exact: true }).inputValue(), '', 'back clears folder search');
          assert.equal(await page.getByRole('button', { name: 'К материалам', exact: true }).count(), 0, 'back leaves archive mode');
          const parentReload = new URL(calls.filter((call) => call.method === 'GET' && new URL(call.path, origin).pathname === '/api/admin/knowledge-base').at(-1)!.path, origin);
          assert.equal(parentReload.searchParams.get('search'), null, 'parent list does not inherit search filter');
          assert.equal(parentReload.searchParams.get('archived'), null, 'parent list loads live materials');
          await page.getByRole('button', { name: 'Загрузить файл', exact: true }).click();
          dialog = page.getByRole('dialog');
          await dialog.getByLabel('Файл', { exact: true }).setInputFiles({ name: 'instruction.html', mimeType: 'text/html', buffer: Buffer.from('<!doctype html><h1>Тест</h1>') });
          await dialog.getByRole('button', { name: 'Загрузить файл', exact: true }).click();
          await page.getByText('Файл загружен.', { exact: true }).waitFor();
          const upload = calls.find((call) => call.path.includes('/upload?'))!;
          assert.match(String(upload.headers['content-type']), /application\/octet-stream/);
          assert.equal(upload.headers['x-kb-file-name'], 'instruction.html');
          assert.match(String(upload.body), /<h1>Тест<\/h1>/);
          await page.getByRole('button', { name: material.title, exact: true }).click();
          dialog = page.getByRole('dialog');
          const frame = dialog.locator('iframe');
          assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts');
          assert.match(await frame.getAttribute('src'), /mode=preview&eventId=[0-9a-f-]+/);
          await page.frameLocator('dialog iframe').getByRole('button', { name: 'Проверить' }).click();
          await page.frameLocator('dialog iframe').getByRole('button', { name: 'Работает' }).waitFor();
          assert.equal(await page.evaluate(() => document.body.dataset.exposed), undefined, 'HTML cannot access parent');
          await page.screenshot({ path: path.join(output, `${engine}-${width}-preview.png`), fullPage: true });
          await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
          await page.getByRole('article').filter({ has: page.getByRole('heading', { name: material.title, exact: true }) }).getByRole('button', { name: 'В архив', exact: true }).click();
          await page.getByRole('dialog').getByRole('button', { name: 'В архив', exact: true }).click();
          await page.getByText('Материал перенесён в архив. Файлы и история сохранены.', { exact: true }).waitFor();
          await page.getByRole('button', { name: 'Архив', exact: true }).click();
          await page.getByRole('button', { name: 'Восстановить', exact: true }).click();
          await page.getByRole('dialog').getByRole('button', { name: 'Восстановить', exact: true }).click();
          await page.getByText('Материал восстановлен.', { exact: true }).waitFor();
          await backToRoot.click();
          await page.getByRole('button', { name: openFolderName(folder.title), exact: true }).waitFor();
          assert.equal(new URL(page.url()).searchParams.get('folder'), null, 'first-level back returns to root');
          assert.equal(await page.getByRole('button', { name: /^Назад (к списку папок|в папку)/ }).count(), 0);
          await page.getByRole('button', { name: 'Архив', exact: true }).click();
          await page.getByRole('heading', { name: archivedFolder.title, exact: true }).waitFor();
          assert.equal(await page.getByRole('button', { name: /^Открыть папку/ }).count(), 0, 'archived folders cannot be opened');
          assert.equal(await page.getByRole('button', { name: /^Переместить «|^Перетащить «/ }).count(), 0, 'archive has no move controls');
          assert.equal(await page.getByRole('button', { name: 'Восстановить', exact: true }).count(), 1, 'archived folder can be restored');
          await page.getByRole('button', { name: 'Статистика использования', exact: true }).click();
          await page.getByRole('button', { name: 'Тестовый сотрудник', exact: true }).click();
          await page.getByRole('button', { name: material.title, exact: true }).waitFor();
          assert.ok(calls.some((call) => call.path.includes('/usage?') && call.path.includes('actorKey=manager%3A1')));
          await page.getByRole('button', { name: material.title, exact: true }).click();
          await page.getByRole('button', { name: 'Тестовый сотрудник', exact: true }).waitFor();
          assert.ok(calls.some((call) => call.path.includes('/usage?') && call.path.includes('nodeId=2')));
          await page.screenshot({ path: path.join(output, `${engine}-${width}-stats.png`), fullPage: true });
          assert.deepEqual(errors, []);
          // A direct link has no parent-folder entry in browser history.
          await gotoPage(origin + '/unrelated-history-entry');
          await gotoPage(origin + '/admin/knowledge-base?folder=4');
          await page.getByRole('heading', { name: nestedFolder.title, exact: true }).waitFor();
          await backToParent.click();
          await page.getByRole('button', { name: openFolderName(nestedFolder.title), exact: true }).waitFor();
          assert.equal(new URL(page.url()).pathname, '/admin/knowledge-base', 'back does not go to previous unrelated history entry');
          assert.equal(new URL(page.url()).searchParams.get('folder'), '1', 'direct nested URL returns to actual parent');
          await backToRoot.click();
          await page.getByRole('button', { name: openFolderName(folder.title), exact: true }).waitFor();
          await gotoPage(origin + '/admin/knowledge-base?folder=1');
          await page.getByRole('button', { name: material.title, exact: true }).waitFor();
          await backToRoot.click();
          await page.getByRole('button', { name: openFolderName(folder.title), exact: true }).waitFor();
          assert.equal(new URL(page.url()).searchParams.get('folder'), null, 'direct first-level URL returns to root');
          failList = true;
          await gotoPage(origin + '/admin/knowledge-base?folder=4');
          await page.getByRole('alert').waitFor();
          assert.equal(await backToRoot.isEnabled(), true, 'failed folder load still offers root fallback');
          failList = false;
          await backToRoot.click();
          await page.getByRole('button', { name: openFolderName(folder.title), exact: true }).waitFor();
          assert.equal(new URL(page.url()).searchParams.get('folder'), null, 'failed-load fallback returns to root');

          // All moving uses a separate mutable local fixture, without real documents or employees.
          console.log(`${engine}/${width}: testing move UI`);
          scenario = 'move initial / drag';
          const gotoMovePage = gotoPage;
          resetMoves();
          await gotoMovePage(origin + '/admin/knowledge-base');
          const cardFor = (title: string) => page.getByRole('article').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
          const moveButton = (title: string) => page.getByRole('button', { name: `Переместить «${title}»`, exact: true });
          const grip = (title: string) => page.getByRole('button', { name: `Перетащить «${title}»`, exact: true });
          const dropOn = async (source: ReturnType<typeof grip>, destination: ReturnType<typeof cardFor>) => {
            if (width === 1440) return source.dragTo(destination);
            // Desktop uses native pointer dragging. On a narrow stacked layout, native
            // dragTo cannot keep distant source/target in view; exercise DOM drop events
            // here and the complete keyboard/touch-friendly picker independently below.
            const transfer = await page.evaluateHandle(() => new DataTransfer());
            await source.dispatchEvent('dragstart', { dataTransfer: transfer });
            await destination.dispatchEvent('dragover', { dataTransfer: transfer });
            await destination.dispatchEvent('drop', { dataTransfer: transfer });
            await source.dispatchEvent('dragend', { dataTransfer: transfer });
            await transfer.dispose();
          };
          const moveRequests = (action: string) => calls.filter((call) => call.path.endsWith('/move') && (call.body as { action?: string })?.action === action);
          await moveButton(folder.title).waitFor();
          const external = await page.evaluateHandle(() => {
            const transfer = new DataTransfer(); transfer.items.add(new File(['external'], 'external.txt')); return transfer;
          });
          const beforeExternal = moveRequests('preview').length;
          await cardFor(longFolder.title).dispatchEvent('dragover', { dataTransfer: external });
          await cardFor(longFolder.title).dispatchEvent('drop', { dataTransfer: external });
          await external.dispose();
          assert.equal(await page.getByRole('dialog').count(), 0, 'external file drop does not create a move or open a dialog');
          assert.equal(moveRequests('preview').length, beforeExternal);
          assert.equal(await cardFor(longFolder.title).evaluate((node: HTMLElement) => {
            const transfer = new DataTransfer(); transfer.setData('text/uri-list', 'https://example.invalid/');
            const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
            node.dispatchEvent(event); return event.defaultPrevented;
          }), true, 'external URL drop cannot navigate away from the knowledge base');
          const targetBeforeDrag = await cardFor(longFolder.title).boundingBox();
          const internal = await page.evaluateHandle(() => new DataTransfer());
          await grip(folder.title).dispatchEvent('dragstart', { dataTransfer: internal });
          const impostor = await page.evaluateHandle(() => {
            const transfer = new DataTransfer(); transfer.setData('application/x-kts-knowledge-base-node', '9999'); return transfer;
          });
          await cardFor(longFolder.title).dispatchEvent('drop', { dataTransfer: impostor });
          await impostor.dispose();
          assert.equal(moveRequests('preview').length, beforeExternal, 'stale/internal source cannot authorize mismatched drag data');
          await cardFor(longFolder.title).dispatchEvent('dragover', { dataTransfer: internal });
          assert.equal(await cardFor(longFolder.title).evaluate((node: HTMLElement) => getComputedStyle(node).outlineWidth), '3px', 'valid drop target is clearly highlighted');
          const targetDuringDrag = await cardFor(longFolder.title).boundingBox();
          assert.equal(targetDuringDrag?.y, targetBeforeDrag?.y, 'drag feedback does not move cards under the pointer');
          await cardFor(folder.title).dispatchEvent('dragover', { dataTransfer: internal });
          await cardFor(folder.title).dispatchEvent('drop', { dataTransfer: internal });
          await grip(folder.title).dispatchEvent('dragend', { dataTransfer: internal });
          await internal.dispose();
          assert.equal(await page.getByRole('dialog').count(), 0, 'dropping on self is ignored');
          assert.equal(moveRequests('preview').length, beforeExternal);
          console.log(`${engine}/${width}: testing folder drop`);
          await dropOn(grip(folder.title), cardFor(longFolder.title));
          dialog = page.getByRole('dialog');
          await dialog.getByRole('button', { name: 'Подтвердить перемещение', exact: true }).waitFor();
          assert.match(await dialog.getByRole('note').innerText(), /доступ сотрудников может измениться/);
          assert.equal(moveRequests('preview').length, beforeExternal + 1, 'drag opens server preview');
          assert.equal(moveRequests('commit').length, 0, 'drag never directly changes hierarchy');
          assert.equal(moveNodes.find((node) => node.id === folder.id)!.parentId, null);
          assert.equal(await dialog.locator('dd').nth(1).innerText(), '3', 'preview shows affected folder, child folder, and file');
          assert.equal(await dialog.evaluate((node: HTMLElement) => node.scrollWidth <= node.clientWidth), true, 'long destination stays inside confirmation');
          await dialog.screenshot({ path: path.join(output, `${engine}-${width}-move-confirmation.png`) });
          await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
          assert.equal(moveRequests('commit').length, 0, 'cancel after drag is non-mutating');

          // Keyboard alternative: paginated folder picker, source excluded, root/back navigation.
          scenario = 'move picker';
          movePagination = true;
          await moveButton(folder.title).focus(); await moveButton(folder.title).press('Enter');
          dialog = page.getByRole('dialog');
          await dialog.getByRole('button', { name: 'Следующие папки', exact: true }).waitFor();
          assert.equal(await dialog.getByRole('button', { name: `Выбрать расположение внутри «${folder.title}»`, exact: true }).count(), 0, 'picker excludes source and therefore its descendants');
          assert.equal(await dialog.getByRole('button', { name: 'Переместить сюда', exact: true }).isDisabled(), true, 'same parent cannot be selected');
          await dialog.getByRole('button', { name: 'Следующие папки', exact: true }).focus();
          await dialog.getByRole('button', { name: 'Следующие папки', exact: true }).press('Enter');
          await dialog.getByRole('button', { name: `Выбрать расположение внутри «${longFolder.title}»`, exact: true }).waitFor();
          assert.equal(await dialog.evaluate((node: HTMLElement) => node.scrollWidth <= node.clientWidth), true, 'long picker name does not overflow on small screens');
          await dialog.screenshot({ path: path.join(output, `${engine}-${width}-move-picker.png`) });
          await dialog.getByRole('button', { name: `Выбрать расположение внутри «${longFolder.title}»`, exact: true }).focus();
          await dialog.getByRole('button', { name: `Выбрать расположение внутри «${longFolder.title}»`, exact: true }).press('Enter');
          await dialog.getByRole('button', { name: 'Переместить сюда', exact: true }).waitFor({ state: 'visible' });
          await dialog.getByRole('button', { name: 'На уровень выше', exact: true }).click();
          await dialog.getByRole('button', { name: 'Следующие папки', exact: true }).click();
          await dialog.getByRole('button', { name: `Выбрать расположение внутри «${longFolder.title}»`, exact: true }).click();
          await dialog.getByRole('button', { name: 'Переместить сюда', exact: true }).click();
          await dialog.getByRole('button', { name: 'Подтвердить перемещение', exact: true }).evaluate((node: HTMLButtonElement) => { node.click(); node.click(); });
          await page.getByRole('status').filter({ hasText: 'Файлы и история сохранены.' }).waitFor();
          assert.equal(moveRequests('commit').length, 1, 'one deliberate commit after server preview');
          assert.equal(moveNodes.find((node) => node.id === folder.id)!.parentId, longFolder.id);
          assert.equal(moveNodes.find((node) => node.id === nestedFolder.id)!.parentId, folder.id, 'nested hierarchy is preserved');
          assert.equal(moveNodes.find((node) => node.id === material.id)!.originalName, 'regulation.html', 'file remains intact');
          await moveButton(folder.title).waitFor({ state: 'detached' });
          await moveButton(longFolder.title).waitFor();
          assert.equal(await moveButton(folder.title).count(), 0, 'successful move refreshes source list');

          // Root/ancestor breadcrumb drops and no root destination for a file.
          scenario = 'move root/ancestor';
          resetMoves();
          await gotoMovePage(origin + '/admin/knowledge-base?folder=1');
          await grip(material.title).waitFor();
          await dropOn(grip(material.title), page.getByRole('navigation', { name: 'Путь папки', exact: true }).getByRole('button', { name: 'База знаний', exact: true }));
          assert.equal(await page.getByRole('dialog').count(), 0, 'file cannot be dropped at root');
          await moveButton(material.title).click();
          dialog = page.getByRole('dialog');
          await dialog.getByRole('button', { name: 'В корень', exact: true }).click();
          await dialog.getByRole('button', { name: `Выбрать расположение внутри «${longFolder.title}»`, exact: true }).waitFor();
          assert.equal(await dialog.getByRole('button', { name: 'Переместить сюда', exact: true }).isDisabled(), true, 'picker forbids file at root too');
          await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
          await dropOn(grip(nestedFolder.title), page.getByRole('navigation', { name: 'Путь папки', exact: true }).getByRole('button', { name: 'База знаний', exact: true }));
          dialog = page.getByRole('dialog');
          await dialog.getByRole('button', { name: 'Подтвердить перемещение', exact: true }).waitFor();
          assert.equal((moveRequests('preview').at(-1)!.body as { targetParentId: number | null }).targetParentId, null, 'root breadcrumb previews folder move');
          await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
          await moveButton(material.title).click();
          dialog = page.getByRole('dialog');
          await dialog.getByRole('button', { name: `Выбрать расположение внутри «${nestedFolder.title}»`, exact: true }).click();
          await dialog.getByRole('button', { name: 'Переместить сюда', exact: true }).click();
          await dialog.getByRole('button', { name: 'Подтвердить перемещение', exact: true }).waitFor();
          assert.equal(await dialog.locator('dd').nth(1).innerText(), '1', 'moving a file affects only that file');
          await dialog.getByRole('button', { name: 'Подтвердить перемещение', exact: true }).click();
          await moveButton(material.title).waitFor({ state: 'detached' });
          await moveButton(nestedFolder.title).waitFor();
          assert.equal(moveNodes.find((node) => node.id === material.id)!.parentId, nestedFolder.id, 'file picker move succeeds');
          assert.equal(moveNodes.find((node) => node.id === material.id)!.size, 1200, 'move preserves file metadata');
          const deeperFolder = { ...nestedFolder, id: 8, parentId: nestedFolder.id, title: 'Вложенные правила' };
          moveNodes.push(deeperFolder);
          await gotoMovePage(origin + '/admin/knowledge-base?folder=4');
          await grip(deeperFolder.title).waitFor();
          await dropOn(grip(deeperFolder.title), page.getByRole('navigation', { name: 'Путь папки', exact: true }).getByRole('button', { name: folder.title, exact: true }));
          dialog = page.getByRole('dialog');
          await dialog.getByRole('button', { name: 'Подтвердить перемещение', exact: true }).waitFor();
          assert.equal((moveRequests('preview').at(-1)!.body as { targetParentId: number | null }).targetParentId, folder.id, 'ancestor breadcrumb previews the correct target');
          await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();

          // Conflict forces reloading and re-previewing; no stale token retry button exists.
          scenario = 'move conflicts';
          resetMoves();
          await gotoMovePage(origin + '/admin/knowledge-base');
          await dropOn(grip(folder.title), cardFor(longFolder.title));
          dialog = page.getByRole('dialog');
          await dialog.getByRole('button', { name: 'Подтвердить перемещение', exact: true }).waitFor();
          moveFailure = 'conflict';
          const beforeConflict = moveRequests('commit').length;
          await dialog.getByRole('button', { name: 'Подтвердить перемещение', exact: true }).click();
          await dialog.getByRole('alert').filter({ hasText: 'Данные или права доступа изменились' }).waitFor();
          assert.equal(await dialog.getByRole('button', { name: 'Подтвердить перемещение', exact: true }).count(), 0);
          assert.equal(moveRequests('commit').length, beforeConflict + 1);
          assert.equal(moveNodes.find((node) => node.id === folder.id)!.parentId, null);
          await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
          await moveButton(folder.title).waitFor();
          moveFailure = 'none'; movePreviewConflict = true;
          const beforePreviewConflict = moveRequests('commit').length;
          await dropOn(grip(folder.title), cardFor(longFolder.title));
          dialog = page.getByRole('dialog');
          await dialog.getByRole('alert').filter({ hasText: 'Материал уже изменён' }).waitFor();
          assert.equal(moveRequests('commit').length, beforePreviewConflict, 'failed preview is never committed');
          assert.equal(await dialog.getByRole('button', { name: 'Подтвердить перемещение', exact: true }).count(), 0);
          await dialog.press('Escape');

          // The server commits but its response is lost: require refresh, never blindly retry.
          scenario = 'move unknown result';
          resetMoves();
          await gotoMovePage(origin + '/admin/knowledge-base');
          await dropOn(grip(folder.title), cardFor(longFolder.title));
          dialog = page.getByRole('dialog');
          await dialog.getByRole('button', { name: 'Подтвердить перемещение', exact: true }).waitFor();
          moveFailure = 'unknown';
          const beforeUnknown = moveRequests('commit').length;
          await dialog.getByRole('button', { name: 'Подтвердить перемещение', exact: true }).click();
          await dialog.getByRole('alert').filter({ hasText: 'Изменение могло уже сохраниться' }).waitFor();
          assert.equal(await dialog.getByRole('button', { name: 'Подтвердить перемещение', exact: true }).count(), 0);
          assert.equal(moveRequests('commit').length, beforeUnknown + 1);
          await dialog.getByRole('button', { name: 'Закрыть и обновить список', exact: true }).click();
          await moveButton(folder.title).waitFor({ state: 'detached' });
          await moveButton(longFolder.title).waitFor();
          assert.equal(await moveButton(folder.title).count(), 0, 'refresh discovers successful move after lost response');
          assert.equal(moveRequests('commit').length, beforeUnknown + 1, 'refresh did not retry commit');
          assert.deepEqual(errors, []);
          await page.waitForLoadState('networkidle');
          moveFixture = false;
          readOnly = true;
          calls.length = 0;
          await gotoPage(origin + '/admin/knowledge-base?reader=1');
          await page.getByRole('button', { name: openFolderName(folder.title), exact: true }).waitFor();
          assert.equal(await page.getByRole('button', { name: 'Создать папку', exact: true }).count(), 0);
          assert.equal(await page.getByRole('button', { name: 'Статистика использования', exact: true }).count(), 0);
          assert.equal(await page.getByRole('button', { name: 'Настроить', exact: true }).count(), 0);
          assert.equal(await page.getByRole('button', { name: 'Архив', exact: true }).count(), 0);
          assert.equal(await page.getByRole('button', { name: /^Переместить «|^Перетащить «/ }).count(), 0, 'read-only employees have no move or drag controls');
          const readerOpen = page.getByRole('button', { name: openFolderName(folder.title), exact: true });
          assert.equal(await readerOpen.isEnabled(), true, 'read-only employee can open granted folder');
          await readerOpen.focus(); await readerOpen.press('Enter');
          await page.getByRole('button', { name: material.title, exact: true }).waitFor();
          assert.equal(await page.getByRole('button', { name: 'Загрузить файл', exact: true }).count(), 0, 'manager cannot upload materials');
          assert.equal(await page.getByRole('button', { name: 'Доступ к папке', exact: true }).count(), 0, 'manager cannot change grants');
          await backToRoot.focus(); await backToRoot.press('Enter');
          await page.getByRole('button', { name: openFolderName(folder.title), exact: true }).waitFor();
          assert.equal(new URL(page.url()).searchParams.get('folder'), null, 'reader can return to root with keyboard');
          failList = true;
          await page.getByRole('button', { name: 'Обновить', exact: true }).click();
          await page.getByRole('alert').waitFor();
          assert.equal(await page.getByRole('button', { name: 'Обновить', exact: true }).isEnabled(), true);
          failList = false;
          await page.getByRole('button', { name: 'Повторить', exact: true }).click();
          await page.getByRole('button', { name: openFolderName(folder.title), exact: true }).waitFor();
          assert.equal(calls.some((call) => call.path.includes('/usage') || call.path.includes('/employees')), false, 'reader never loads management directory or statistics');
          await page.close(); console.log(`${engine}/${width}: KB navigation, access editor, upload, archive, stats, move picker/drag/drop/409/lost response, errors, isolated HTML passed`);
        }
      } finally { await browser.close(); }
    }
    console.log(`Screenshots: ${output}`);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
