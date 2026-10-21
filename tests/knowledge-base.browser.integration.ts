/** Local synthetic fixtures only; never opens production or creates real employee activity. */
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
  const output = await mkdtemp(path.join(tmpdir(), 'kts-knowledge-base-ui-'));
  let css = '', index = 0;
  const bundle = await build({ absWorkingDir: root, stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import Header from './src/widgets/layout/Header/Header';
    import {KnowledgeBase} from './src/features/admin/knowledge-base/KnowledgeBase';
    const folder=new URLSearchParams(location.search).get('folder');
    const parentId=folder&&/^[1-9]\\d*$/.test(folder)&&Number.isSafeInteger(Number(folder))?Number(folder):null;
    createRoot(document.getElementById('root')).render(<><Header/><KnowledgeBase initialCanManage={!location.search.includes('reader=1')} initialParentId={parentId}/></>);
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
  const folder = { id: 1, parentId: null, kind: 'folder', title: 'Регламенты продаж', revision: '1', archivedAt: null,
    createdAt: stamp, updatedAt: stamp, originalName: null, mimeType: null, size: null, access: { mode: 'custom', actorKeys: ['manager:1'] } };
  const nestedFolder = { ...folder, id: 4, parentId: 1, title: 'Инструкции для новых сотрудников' };
  const longFolder = { ...folder, id: 5, title: 'Положения и инструкции по работе с региональными партнёрами — СправочникДляНовыхСотрудниковПодразделенияПродажИЗакупок' };
  const archivedFolder = { ...folder, id: 6, title: 'Архив регламентов', archivedAt: stamp };
  const openFolderName = (title: string) => `Открыть папку «${title}»`;
  const material = { ...folder, id: 2, parentId: 1, kind: 'file', title: 'Порядок работы с клиентом', originalName: 'regulation.html',
    mimeType: 'text/html', size: 1200, access: { mode: 'inherit', actorKeys: [] } };
  const calls: { path: string; method: string; body: unknown; headers: Record<string, unknown> }[] = [];
  let readOnly = false, failList = false, failSave = false, archived = false;
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
    if (url.pathname.endsWith('/employees')) return void json({ actors: [{ actorKey: 'manager:1', actorName: 'Тестовый сотрудник', actorRole: 'manager' }], nextCursor: null });
    if (url.pathname.endsWith('/events')) return void json({ recorded: true });
    if (url.pathname.includes('/files/')) return void response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" })
      .end('<!doctype html><html><h1>Тестовый регламент</h1><button onclick="this.textContent=\'Работает\'">Проверить</button><script>try{parent.document.body.dataset.exposed="yes"}catch(e){}</script></html>');
    if (url.pathname.endsWith('/usage')) return void json({ rows: [{ key: url.searchParams.get('view') === 'employees' ? 'manager:1' : '2',
      title: url.searchParams.get('view') === 'employees' ? 'Тестовый сотрудник' : material.title, role: 'manager', sectionOpens: 2,
      folderOpens: 3, fileViews: 4, downloadsStarted: 1, totalEvents: 10, lastVisitAt: stamp }], nextCursor: null });
    if (request.method !== 'GET') {
      if (failSave) return void json({ error: 'Данные уже изменены другим пользователем. Обновите список.' }, 409);
      if (body && typeof body === 'object' && 'archived' in body) archived = body.archived;
      return void json({ node: { ...folder, id: 3 }, created: true });
    }
    if (failList) return void json({ error: 'Не удалось загрузить папку' }, 503);
    const parent = url.searchParams.get('parentId');
    const inArchive = url.searchParams.get('archived') === '1';
    const materialNodes = archived === inArchive ? [{ ...material, archivedAt: archived ? stamp : null }] : [];
    return void json({ nodes: parent ? [...(parent === '1' && !inArchive ? [nestedFolder] : []), ...materialNodes]
      : inArchive ? [archivedFolder] : [folder, longFolder],
      nextCursor: null, breadcrumbs: parent ? parent === '4' ? [folder, nestedFolder] : [folder] : [], canManage: !readOnly });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const engine of ['chromium', 'webkit']) {
      const browser = await playwright[engine].launch({ headless: true });
      try {
        for (const width of [1440, 390, 320]) {
          readOnly = false; failList = false; failSave = false; archived = false; calls.length = 0;
          const page = await browser.newPage({ viewport: { width, height: 1000 } });
          page.setDefaultTimeout(10_000);
          const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message));
          await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          await page.goto(origin + '/admin/knowledge-base');
          await page.getByRole('button', { name: openFolderName(folder.title), exact: true }).waitFor();
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
          await page.goto(origin + '/unrelated-history-entry');
          await page.goto(origin + '/admin/knowledge-base?folder=4');
          await page.getByRole('heading', { name: nestedFolder.title, exact: true }).waitFor();
          await backToParent.click();
          await page.getByRole('button', { name: openFolderName(nestedFolder.title), exact: true }).waitFor();
          assert.equal(new URL(page.url()).pathname, '/admin/knowledge-base', 'back does not go to previous unrelated history entry');
          assert.equal(new URL(page.url()).searchParams.get('folder'), '1', 'direct nested URL returns to actual parent');
          await backToRoot.click();
          await page.getByRole('button', { name: openFolderName(folder.title), exact: true }).waitFor();
          await page.goto(origin + '/admin/knowledge-base?folder=1');
          await page.getByRole('button', { name: material.title, exact: true }).waitFor();
          await backToRoot.click();
          await page.getByRole('button', { name: openFolderName(folder.title), exact: true }).waitFor();
          assert.equal(new URL(page.url()).searchParams.get('folder'), null, 'direct first-level URL returns to root');
          failList = true;
          await page.goto(origin + '/admin/knowledge-base?folder=4');
          await page.getByRole('alert').waitFor();
          assert.equal(await backToRoot.isEnabled(), true, 'failed folder load still offers root fallback');
          failList = false;
          await backToRoot.click();
          await page.getByRole('button', { name: openFolderName(folder.title), exact: true }).waitFor();
          assert.equal(new URL(page.url()).searchParams.get('folder'), null, 'failed-load fallback returns to root');
          readOnly = true;
          await page.goto(origin + '/admin/knowledge-base?reader=1');
          await page.getByRole('button', { name: openFolderName(folder.title), exact: true }).waitFor();
          assert.equal(await page.getByRole('button', { name: 'Создать папку', exact: true }).count(), 0);
          assert.equal(await page.getByRole('button', { name: 'Статистика использования', exact: true }).count(), 0);
          assert.equal(await page.getByRole('button', { name: 'Настроить', exact: true }).count(), 0);
          const readerOpen = page.getByRole('button', { name: openFolderName(folder.title), exact: true });
          assert.equal(await readerOpen.isEnabled(), true, 'read-only employee can open granted folder');
          await readerOpen.focus(); await readerOpen.press('Enter');
          await page.getByRole('button', { name: material.title, exact: true }).waitFor();
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
          await page.close(); console.log(`${engine}/${width}: KB navigation, access editor, upload, archive, stats, errors, isolated HTML passed`);
        }
      } finally { await browser.close(); }
    }
    console.log(`Screenshots: ${output}`);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
