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
import type { KnowledgeBaseAccess, KnowledgeBaseNode } from '../src/shared/lib/knowledgeBase';
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
    createRoot(document.getElementById('root')).render(<><Header/><KnowledgeBase initialCanManage={canManageKnowledgeBase(session)} initialParentId={parentId} initialArchived={new URLSearchParams(location.search).get('archived')==='1'}/></>);
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
  const material: KnowledgeBaseNode = { ...folder, id: 2, parentId: 1, kind: 'file', title: 'Порядок работы с клиентом', originalName: 'regulation.html',
    mimeType: 'text/html', size: 1200, access: { mode: 'inherit', actorKeys: [] } };
  const deepFolder: KnowledgeBaseNode = { ...folder, id: 7, parentId: nestedFolder.id,
    title: 'ПодробныеПравилаВозмещенияКомандировочныхРасходовСотрудниковРегиональныхПодразделений' };
  const deepMaterial: KnowledgeBaseNode = { ...material, id: 8, parentId: deepFolder.id, kind: 'file', title: 'Командировочные расходы' };
  const secondMaterial: KnowledgeBaseNode = { ...deepMaterial, id: 9, parentId: nestedFolder.id, title: 'Командировочные расходы: отчёт' };
  const outsideMaterial: KnowledgeBaseNode = { ...deepMaterial, id: 10, parentId: longFolder.id, title: 'Командировочные расходы: партнёры' };
  const searchNodes = [folder, nestedFolder, longFolder, deepFolder, deepMaterial, secondMaterial, outsideMaterial];
  const searchPath = (id: number | null): KnowledgeBaseNode[] => {
    if (id === null) return [];
    const node = searchNodes.find((item) => item.id === id)!;
    return [...searchPath(node.parentId), node];
  };
  const calls: { path: string; method: string; body: unknown; headers: Record<string, unknown> }[] = [];
  const topSession: AdminSession = { role: 'top', adminUserId: 7, sessionId: '00000000-0000-4000-8000-000000000007' };
  const readerSession: AdminSession = { role: 'manager', managerId: 1, canManageTopDashboard: true, sessionId: '00000000-0000-4000-8000-000000000001' };
  assert.equal(canManageKnowledgeBase(topSession), true, 'real KB policy grants TOP management');
  assert.equal(canManageKnowledgeBase(readerSession), false, 'unrelated TOP-dashboard management flag does not grant KB management');
  let readOnly = false, failList = false, failSave = false, archived = false;
  let searchFixture = false;
  let accessFixture = false, failAccessPreview = false;
  let delayedAccess: { started: Promise<void>; onStart: () => void; release: Promise<void>; finish: () => void } | null = null;
  const accessSelections = [...Array.from({ length: 27 }, (_, index) => `manager:${index + 1}`), 'admin:7', 'manager:999'];
  let delayedSearch: { started: Promise<void>; onStart: () => void; release: Promise<void>; finish: () => void } | null = null;
  let moveFixture = false, movePagination = false;
  let moveFailure: 'none' | 'conflict' | 'unknown' = 'none';
  let movePreviewConflict = false;
  let moveNodes: KnowledgeBaseNode[] = [];
  let deleteFixture = false, deletePreviewConflict = false;
  let deleteFailure: 'none' | 'conflict' | 'unknown' = 'none';
  let deleteNodes: KnowledgeBaseNode[] = [];
  const archivedChildFolder = { ...nestedFolder, id: 16, parentId: archivedFolder.id, title: 'Вложенная архивная папка' };
  const archivedChildFile = { ...material, id: 17, parentId: archivedChildFolder.id, title: 'Файл внутри архивной папки' };
  const archivedOwnFile = { ...material, id: 18, parentId: archivedFolder.id, title: 'Отдельно архивированный файл', archivedAt: stamp };
  const archivedRootFile = { ...material, id: 19, parentId: null, title: 'Архивный файл в корне', archivedAt: stamp, access: { mode: 'custom' as const, actorKeys: ['manager:1'] } };
  const resetDeletes = () => {
    deleteFixture = true; moveFixture = false; deletePreviewConflict = false; deleteFailure = 'none';
    deleteNodes = structuredClone([archivedFolder, archivedChildFolder, archivedChildFile, archivedOwnFile, archivedRootFile, folder]);
  };
  const deletePath = (id: number | null): KnowledgeBaseNode[] => {
    if (id === null) return [];
    const node = deleteNodes.find((item) => item.id === id)!;
    return [...deletePath(node.parentId), node];
  };
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
    if (url.pathname.endsWith('/access-preview')) {
      assert.equal(request.method, 'POST');
      const input = body as { parentId: number | null; access: KnowledgeBaseAccess };
      const totalActive = accessFixture ? 40 : 2;
      const byRole = accessFixture ? 9 : 1;
      const active = Array.from({ length: totalActive - byRole }, (_, index) => `manager:${index + 1}`);
      const allowed = input.parentId !== null && accessFixture ? active.slice(0, 26) : active;
      const bySelection = input.access.mode === 'custom' ? allowed.filter((key) => input.access.actorKeys.includes(key)).length : 0;
      const byInheritance = input.access.mode === 'inherit' ? allowed.length : 0;
      const withAccess = byRole + bySelection + byInheritance;
      const selectedInactive = input.access.actorKeys.filter((key) => !active.includes(key) && key !== 'admin:7').length;
      const selectedBlockedByParent = input.access.actorKeys.filter((key) => active.includes(key) && !allowed.includes(key)).length;
      if (failAccessPreview) return void json({ error: 'Не удалось получить сведения о доступе.' }, 503);
      if (delayedAccess && !input.access.actorKeys.includes('manager:1')) {
        delayedAccess.onStart(); await delayedAccess.release;
      }
      return void json({ totalActive, withAccess, byRole, bySelection, byInheritance,
        withoutAccess: totalActive - withAccess, selectedInactive, selectedBlockedByParent });
    }
    if (url.pathname.endsWith('/employees')) {
      if (accessFixture && url.searchParams.get('search')) return void json({ actors: [], nextCursor: null });
      if (accessFixture && url.searchParams.get('after')) return void json({ actors: [
        { actorKey: 'manager:28', actorName: 'Дополнительный сотрудник', actorRole: 'manager' },
      ], nextCursor: null });
      return void json({ actors: [
      { actorKey: 'manager:1', actorName: 'Тестовый сотрудник', actorRole: 'manager' },
      { actorKey: 'admin:7', actorName: 'Тестовый руководитель', actorRole: 'top' },
      ], nextCursor: accessFixture ? 'manager:1' : null });
    }
    if (url.pathname.endsWith('/events')) return void json({ recorded: true });
    if (url.pathname.includes('/files/')) return void response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" })
      .end('<!doctype html><html><h1>Тестовый регламент</h1><button onclick="this.textContent=\'Работает\'">Проверить</button><script>try{parent.document.body.dataset.exposed="yes"}catch(e){}</script></html>');
    if (url.pathname.endsWith('/usage')) return void json({ rows: [{ key: url.searchParams.get('view') === 'employees' ? 'manager:1' : '2',
      title: url.searchParams.get('view') === 'employees' ? 'Тестовый сотрудник' : material.title, role: 'manager', sectionOpens: 2,
      folderOpens: 3, fileViews: 4, downloadsStarted: 1, totalEvents: 10, lastVisitAt: stamp }], nextCursor: null });
    if (url.pathname.endsWith('/delete')) {
      assert.equal(deleteFixture, true);
      assert.equal(readOnly, false);
      const id = Number(url.pathname.split('/').at(-2));
      const source = deleteNodes.find((node) => node.id === id)!;
      assert.equal(body.expectedRevision, source.revision);
      assert.ok(deletePath(id).some((node) => !!node.archivedAt), 'only effectively archived fixtures can be deleted');
      const affected = deleteNodes.filter((node) => deletePath(node.id).some((ancestor) => ancestor.id === id));
      const counts = { affectedCount: affected.length, fileCount: affected.filter((node) => node.kind === 'file').length,
        folderCount: affected.filter((node) => node.kind === 'folder').length, totalBytes: affected.reduce((sum, node) => sum + (node.size ?? 0), 0) };
      if (body.action === 'preview') {
        if (deletePreviewConflict) return void json({ error: 'Материал уже изменён. Обновите список.' }, 409);
        return void json({ source, previewToken: `delete-${id}-${source.revision}`, ...counts });
      }
      assert.equal(body.action, 'commit');
      assert.equal(body.confirmationTitle, source.title);
      assert.equal(body.previewToken, `delete-${id}-${source.revision}`);
      assert.match(body.operationId, /^[0-9a-f-]{36}$/);
      if (deleteFailure === 'conflict') return void json({ error: 'Состав папки изменился.' }, 409);
      const affectedIds = new Set(affected.map((node) => node.id));
      deleteNodes = deleteNodes.filter((node) => !affectedIds.has(node.id));
      if (deleteFailure === 'unknown') {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
        response.write('{'); setTimeout(() => response.destroy(), 30); return;
      }
      return void json({ deleted: true, nodeId: id, cleanupPending: false, ...counts });
    }
    if (url.pathname.endsWith('/move')) {
      assert.equal(moveFixture, true);
      const id = Number(url.pathname.split('/').at(-2));
      const source = moveNodes.find((node) => node.id === id)!;
      const destination = moveNodes.find((node) => node.id === body.targetParentId) ?? null;
      assert.equal(readOnly, false, 'reader must never submit a move');
      assert.equal(body.expectedRevision, source.revision);
      assert.notEqual(body.targetParentId, source.id, 'self is not a move target');
      assert.notEqual(body.targetParentId, source.parentId, 'current parent is not a move target');
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
      if (source.kind === 'file' && body.targetParentId === null) source.access = { mode: 'custom', actorKeys: ['manager:1'] };
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
    if (deleteFixture) {
      const breadcrumbs = deletePath(parent === null ? null : Number(parent));
      const inArchive = url.searchParams.get('archived') === '1';
      const nodes = deleteNodes.filter((node) => node.parentId === (parent === null ? null : Number(parent)))
        .filter((node) => inArchive ? breadcrumbs.some((item) => !!item.archivedAt) || !!node.archivedAt : !node.archivedAt);
      return void json({ nodes, nextCursor: null, breadcrumbs, canManage: canManageKnowledgeBase(readOnly ? readerSession : topSession) });
    }
    if (accessFixture) return void json({ nodes: [{ ...(parent ? nestedFolder : folder),
      access: { mode: 'custom', actorKeys: accessSelections } }], nextCursor: null,
      breadcrumbs: parent ? [folder] : [], canManage: true });
    if (searchFixture) {
      const parentId = parent === null ? null : Number(parent);
      const search = url.searchParams.get('search') ?? '';
      const inArchive = url.searchParams.get('archived') === '1';
      if (search === 'отложенный' && delayedSearch) {
        delayedSearch.onStart(); await delayedSearch.release;
        return void json({ nodes: [{ ...deepMaterial, title: 'Устаревший результат', path: searchPath(deepMaterial.parentId) }], nextCursor: null,
          breadcrumbs: searchPath(parentId), canManage: true });
      }
      let nodes = inArchive ? [] : search ? searchNodes.filter((node) => node.title.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru'))
        && (parentId === null || searchPath(node.parentId).some((ancestor) => ancestor.id === parentId)))
        .map((node) => ({ ...node, path: searchPath(node.parentId).map(({ id, title }) => ({ id, title })) }))
        : searchNodes.filter((node) => node.parentId === parentId);
      nodes = nodes.filter((node) => node.id > Number(url.searchParams.get('after') ?? 0));
      const nextCursor = search && nodes.length > 1 ? nodes[0].id : null;
      if (search) nodes = nodes.slice(0, 1);
      return void json({ nodes, nextCursor, breadcrumbs: searchPath(parentId), canManage: canManageKnowledgeBase(readOnly ? readerSession : topSession) });
    }
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
          readOnly = false; failList = false; failSave = false; archived = false; moveFixture = false; searchFixture = false; deleteFixture = false;
          accessFixture = false; failAccessPreview = false; delayedAccess = null; calls.length = 0;
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
          assert.equal(await page.getByRole('button', { name: 'Загрузить файл', exact: true }).isEnabled(), true, 'TOP can upload at root');
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
          await page.getByRole('button', { name: 'Загрузить файл', exact: true }).click();
          const rootUploadDialog = page.getByRole('dialog');
          assert.equal(await rootUploadDialog.getByRole('option', { name: /Как у родительской/ }).count(), 0, 'root upload cannot inherit absent folder rights');
          const editorBox = await rootUploadDialog.boundingBox();
          assert.ok(editorBox && editorBox.width <= 660, 'editor remains narrow');
          await rootUploadDialog.getByLabel('Файл', { exact: true }).setInputFiles({ name: 'root.html', mimeType: 'text/html', buffer: Buffer.from('<!doctype html><h1>Корень</h1>') });
          await rootUploadDialog.getByRole('button', { name: 'Загрузить файл', exact: true }).click();
          await page.getByText('Файл загружен.', { exact: true }).waitFor();
          const rootUpload = calls.filter((call) => call.path.includes('/upload?')).at(-1)!;
          assert.equal(new URL(rootUpload.path, origin).searchParams.get('parentId'), null, 'root upload omits parent id');
          assert.deepEqual(JSON.parse(decodeURIComponent(String(rootUpload.headers['x-kb-access']))), { mode: 'custom', actorKeys: [] }, 'root upload defaults to managers only');
          await page.getByRole('button', { name: 'Создать папку', exact: true }).click();
          let dialog = page.getByRole('dialog');
          await dialog.getByLabel('Название', { exact: true }).fill('Новая папка');
          const topAccess = dialog.getByRole('checkbox', { name: /Тестовый руководитель.*доступ по роли/ });
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
          await page.getByRole('searchbox', { name: 'Поиск в папке и вложенных папках', exact: true }).fill('порядок');
          const searchResponse = page.waitForResponse((response: { url(): string }) => new URL(response.url()).searchParams.get('search') === 'порядок');
          await page.getByRole('button', { name: 'Найти', exact: true }).click();
          await searchResponse;
          await page.getByRole('heading', { name: nestedFolder.title, exact: true }).waitFor();
          await page.getByRole('button', { name: 'Архив', exact: true }).click();
          await page.getByRole('heading', { name: `Архив / ${nestedFolder.title}`, exact: true }).waitFor();
          await backToParent.focus(); await backToParent.press('Enter');
          await page.getByRole('heading', { name: `Архив / ${folder.title}`, exact: true }).waitFor();
          assert.equal(new URL(page.url()).searchParams.get('folder'), '1', 'nested folder-back opens its actual parent');
          assert.equal(await page.getByRole('searchbox', { name: 'Поиск в архиве текущей папки', exact: true }).inputValue(), '', 'back clears folder search');
          assert.equal(await page.getByRole('button', { name: 'К материалам', exact: true }).count(), 1, 'back preserves archive mode');
          const parentReload = new URL(calls.filter((call) => call.method === 'GET' && new URL(call.path, origin).pathname === '/api/admin/knowledge-base').at(-1)!.path, origin);
          assert.equal(parentReload.searchParams.get('search'), null, 'parent list does not inherit search filter');
          assert.equal(parentReload.searchParams.get('archived'), '1', 'parent list stays in archive');
          await page.getByRole('button', { name: 'К материалам', exact: true }).click();
          await page.getByRole('button', { name: openFolderName(nestedFolder.title), exact: true }).waitFor();
          await page.getByRole('button', { name: 'Загрузить файл', exact: true }).click();
          dialog = page.getByRole('dialog');
          await dialog.getByLabel('Файл', { exact: true }).setInputFiles({ name: 'instruction.html', mimeType: 'text/html', buffer: Buffer.from('<!doctype html><h1>Тест</h1>') });
          await dialog.getByRole('button', { name: 'Загрузить файл', exact: true }).click();
          await page.getByText('Файл загружен.', { exact: true }).waitFor();
          const upload = calls.filter((call) => call.path.includes('/upload?')).at(-1)!;
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
          const previewBox = await dialog.boundingBox(), frameBox = await frame.boundingBox();
          assert.ok(previewBox && Math.abs(previewBox.x) <= 1 && Math.abs(previewBox.y) <= 1
            && Math.abs(previewBox.width - width) <= 1 && Math.abs(previewBox.height - 1000) <= 1, 'HTML preview fills the viewport');
          assert.ok(frameBox && Math.abs(frameBox.width - width) <= 1 && Math.abs(frameBox.y + frameBox.height - 1000) <= 1, 'iframe fills available viewport area');
          await page.screenshot({ path: path.join(output, `${engine}-${width}-preview.png`), fullPage: true });
          // Keyboard events inside an opaque sandbox iframe do not reach the outer
          // dialog. Its persistent Close button and Escape in dialog chrome remain
          // available without adding a new cross-frame messaging capability.
          await dialog.press('Escape');
          await dialog.waitFor({ state: 'detached' });
          assert.equal(await page.getByRole('button', { name: material.title, exact: true }).evaluate((node: HTMLElement) => node === document.activeElement), true, 'Escape returns focus to file');
          await page.getByRole('article').filter({ has: page.getByRole('heading', { name: material.title, exact: true }) }).getByRole('button', { name: 'В архив', exact: true }).click();
          await page.getByRole('dialog').getByRole('button', { name: 'В архив', exact: true }).click();
          await page.getByText('Материал перенесён в архив. Файлы и история сохранены.', { exact: true }).waitFor();
          await page.getByRole('button', { name: 'Архив', exact: true }).click();
          await page.getByRole('button', { name: 'Восстановить', exact: true }).click();
          await page.getByRole('dialog').getByRole('button', { name: 'Восстановить', exact: true }).click();
          await page.getByText('Материал восстановлен.', { exact: true }).waitFor();
          await page.getByRole('button', { name: 'К материалам', exact: true }).click();
          await page.getByRole('button', { name: material.title, exact: true }).waitFor();
          await backToRoot.click();
          await page.getByRole('button', { name: openFolderName(folder.title), exact: true }).waitFor();
          assert.equal(new URL(page.url()).searchParams.get('folder'), null, 'first-level back returns to root');
          assert.equal(await page.getByRole('button', { name: /^Назад (к списку папок|в папку)/ }).count(), 0);
          await page.getByRole('button', { name: 'Архив', exact: true }).click();
          await page.getByRole('heading', { name: archivedFolder.title, exact: true }).waitFor();
          assert.equal(await page.getByRole('button', { name: /^Открыть папку/ }).count(), 1, 'managers can inspect archived folders');
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

          scenario = 'total access summary';
          accessFixture = true;
          await gotoPage(origin + '/admin/knowledge-base');
          assert.equal(await page.getByText(/Выбрано сотрудников:/).count(), 0, 'cards do not present selected grants as the total access count');
          await page.getByRole('button', { name: 'Настроить', exact: true }).click();
          dialog = page.getByRole('dialog');
          await dialog.getByText('Доступ имеют: 36 из 40 сотрудников', { exact: true }).waitFor();
          assert.match(await dialog.innerText(), /По выбору: 27 · По роли: 9 · Без доступа: 4/);
          assert.match(await dialog.innerText(), /недействующие учётные записи: 1/);
          assert.equal(await dialog.getByText('Выбрано: 27', { exact: false }).count(), 0);
          const selectedEmployee = dialog.getByRole('checkbox', { name: /^Тестовый сотрудник/ });
          const automaticEmployee = dialog.getByRole('checkbox', { name: /^Тестовый руководитель/ });
          assert.equal(await automaticEmployee.isDisabled(), true);
          assert.equal(await automaticEmployee.isChecked(), true);
          assert.equal(await selectedEmployee.isChecked(), true);
          assert.match(await dialog.innerText(), /изменения применятся после сохранения/);
          assert.equal(await dialog.evaluate((node: HTMLElement) => node.scrollWidth <= node.clientWidth + 1), true, 'access summary wraps on narrow screens');
          await dialog.screenshot({ path: path.join(output, `${engine}-${width}-total-access.png`) });
          const previewCalls = () => calls.filter((call) => call.path.endsWith('/access-preview'));
          const beforeEmployeeSearch = previewCalls().length;
          await dialog.getByRole('searchbox', { name: 'Найти сотрудника по ФИО', exact: true }).fill('Нет такого сотрудника');
          await dialog.getByRole('button', { name: 'Найти', exact: true }).click();
          await dialog.getByText('Сотрудники не найдены.', { exact: true }).waitFor();
          assert.equal(await dialog.getByText('Доступ имеют: 36 из 40 сотрудников', { exact: true }).isVisible(), true,
            'empty employee search does not change the global count');
          assert.equal(previewCalls().length, beforeEmployeeSearch, 'search does not refetch the access calculation');
          await dialog.getByRole('searchbox', { name: 'Найти сотрудника по ФИО', exact: true }).fill('');
          await dialog.getByRole('button', { name: 'Найти', exact: true }).click();
          await selectedEmployee.waitFor();
          await dialog.getByRole('button', { name: 'Ещё сотрудники', exact: true }).click();
          const extraEmployee = dialog.getByRole('checkbox', { name: /^Дополнительный сотрудник/ });
          await extraEmployee.waitFor();
          assert.equal(previewCalls().length, beforeEmployeeSearch, 'directory pagination does not change the total or refetch it');
          await extraEmployee.check();
          await dialog.getByText('Доступ имеют: 37 из 40 сотрудников', { exact: true }).waitFor();
          await extraEmployee.uncheck();
          await dialog.getByText('Доступ имеют: 36 из 40 сотрудников', { exact: true }).waitFor();

          let startAccess = () => {}, releaseAccess = () => {};
          delayedAccess = { started: new Promise<void>((resolve) => { startAccess = resolve; }), onStart: () => startAccess(),
            release: new Promise<void>((resolve) => { releaseAccess = resolve; }), finish: () => releaseAccess() };
          await selectedEmployee.uncheck();
          await delayedAccess.started;
          assert.equal(await dialog.getByText(/^Доступ имеют:/).count(), 0, 'outdated count is hidden while changed settings are pending');
          await dialog.getByText('Рассчитываем общий доступ…', { exact: true }).waitFor();
          await selectedEmployee.check();
          await dialog.getByText('Доступ имеют: 36 из 40 сотрудников', { exact: true }).waitFor();
          delayedAccess.finish();
          await page.waitForLoadState('networkidle');
          delayedAccess = null;
          assert.equal(await dialog.getByText('Доступ имеют: 35 из 40 сотрудников', { exact: true }).count(), 0,
            'late cancelled preview cannot overwrite the current count');

          failAccessPreview = true;
          await selectedEmployee.uncheck();
          await dialog.getByRole('alert').filter({ hasText: 'Общее число доступов сейчас недоступно' }).waitFor();
          assert.equal(await dialog.getByText(/^Доступ имеют:/).count(), 0, 'failed calculation never displays the previous total');
          failAccessPreview = false;
          await dialog.getByRole('button', { name: 'Повторить расчёт', exact: true }).click();
          await dialog.getByText('Доступ имеют: 35 из 40 сотрудников', { exact: true }).waitFor();
          await selectedEmployee.check();
          await dialog.getByText('Доступ имеют: 36 из 40 сотрудников', { exact: true }).waitFor();
          await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
          await page.getByText('Изменения сохранены.', { exact: true }).waitFor();
          const savedSelection = calls.filter((call) => call.method === 'PATCH').at(-1)!.body as { access: KnowledgeBaseAccess };
          assert.deepEqual([...savedSelection.access.actorKeys].sort(), [...accessSelections].sort(),
            'summary leaves stored grants, including existing management and inactive keys, unchanged');

          await gotoPage(origin + '/admin/knowledge-base?folder=1');
          await page.getByRole('button', { name: 'Настроить', exact: true }).click();
          dialog = page.getByRole('dialog');
          await dialog.getByText('Доступ имеют: 35 из 40 сотрудников', { exact: true }).waitFor();
          assert.equal((previewCalls().at(-1)!.body as { parentId: number }).parentId, 1, 'preview uses the edited node parent');
          assert.match(await dialog.innerText(), /не имеют доступа к родительской папке: 1/);
          assert.match(await dialog.innerText(), /По выбору: 26 · По роли: 9 · Без доступа: 5/);
          await dialog.getByRole('combobox', { name: 'Правило доступа', exact: true }).selectOption('inherit');
          await dialog.getByText(/Как у родительской папки: 26 · По роли: 9 · Без доступа: 5/).waitFor();
          assert.equal(await dialog.getByText('Доступ имеют: 35 из 40 сотрудников', { exact: true }).isVisible(), true);
          assert.equal(await dialog.getByRole('checkbox').count(), 0, 'inherited access has a summary without an individual-selection list');
          await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
          accessFixture = false;
          assert.deepEqual(errors, []);

          scenario = 'recursive search';
          searchFixture = true;
          await gotoPage(origin + '/admin/knowledge-base');
          const searchBox = page.getByRole('searchbox');
          const lastListRequest = () => new URL(calls.filter((call) => call.method === 'GET'
            && new URL(call.path, origin).pathname === '/api/admin/knowledge-base').at(-1)!.path, origin);
          const searchFor = async (value: string) => {
            await searchBox.fill(value);
            const response = page.waitForResponse((item: { url(): string }) => new URL(item.url()).pathname === '/api/admin/knowledge-base'
              && new URL(item.url()).searchParams.get('search') === value);
            await page.getByRole('button', { name: 'Найти', exact: true }).click();
            await response;
          };
          assert.equal(await page.getByRole('searchbox', { name: 'Поиск по всей Базе знаний', exact: true }).count(), 1);
          assert.equal(await page.getByRole('navigation', { name: /^Расположение/ }).count(), 0, 'ordinary root listing has no search paths');
          await searchFor('командировочные');
          const resultPath = page.getByRole('navigation', { name: `Расположение «${deepMaterial.title}»`, exact: true });
          await resultPath.waitFor();
          assert.equal(await resultPath.innerText(), `База знаний / ${folder.title} / ${nestedFolder.title} / ${deepFolder.title}`,
            'deep result shows the complete root-to-parent path');
          assert.equal(await resultPath.getByRole('button', { name: deepMaterial.title, exact: true }).count(), 0, 'path does not duplicate matching file');
          assert.equal(lastListRequest().searchParams.get('parentId'), null, 'root search spans the full accessible tree');
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'deep long paths do not overflow the page');
          assert.equal(await resultPath.evaluate((node: HTMLElement) => node.scrollWidth <= node.clientWidth + 1), true, 'long path wraps inside result card');
          await page.screenshot({ path: path.join(output, `${engine}-${width}-recursive-search.png`), fullPage: true });
          await page.getByRole('button', { name: 'Далее', exact: true }).click();
          await page.getByRole('navigation', { name: `Расположение «${secondMaterial.title}»`, exact: true }).waitFor();
          assert.equal(lastListRequest().searchParams.get('after'), String(deepMaterial.id), 'second search page sends cursor');
          assert.equal(lastListRequest().searchParams.get('search'), 'командировочные', 'pagination preserves the search');
          await page.getByRole('button', { name: 'Назад', exact: true }).click();
          await resultPath.waitFor();
          assert.equal(lastListRequest().searchParams.get('after'), null, 'previous search page restores first-page cursor');
          await resultPath.getByRole('button', { name: deepFolder.title, exact: true }).focus();
          await resultPath.getByRole('button', { name: deepFolder.title, exact: true }).press('Enter');
          await page.getByRole('heading', { name: deepFolder.title, exact: true }).waitFor();
          await page.getByRole('button', { name: deepMaterial.title, exact: true }).waitFor();
          assert.equal(new URL(page.url()).searchParams.get('folder'), String(deepFolder.id), 'result path opens the selected real parent');
          assert.equal(await searchBox.inputValue(), '', 'path navigation clears search');
          assert.equal(lastListRequest().searchParams.get('search'), null);
          assert.equal(lastListRequest().searchParams.get('after'), null);
          assert.equal(await page.getByRole('navigation', { name: /^Расположение/ }).count(), 0, 'path navigation returns to ordinary folder listing');
          await page.getByRole('navigation', { name: 'Путь папки', exact: true }).getByRole('button', { name: folder.title, exact: true }).click();
          await page.getByRole('button', { name: openFolderName(nestedFolder.title), exact: true }).waitFor();
          await searchFor('командировочные');
          await resultPath.waitFor();
          assert.equal(lastListRequest().searchParams.get('parentId'), String(folder.id), 'folder search stays rooted at the selected folder');
          assert.equal(await page.getByRole('searchbox', { name: 'Поиск в папке и вложенных папках', exact: true }).count(), 1);
          await page.getByRole('button', { name: 'Далее', exact: true }).click();
          await page.getByRole('navigation', { name: `Расположение «${secondMaterial.title}»`, exact: true }).waitFor();
          assert.equal(await page.getByRole('button', { name: 'Далее', exact: true }).isDisabled(), true, 'subtree search has no sibling-folder page');
          await page.getByRole('button', { name: 'Сбросить поиск', exact: true }).click();
          await page.getByRole('button', { name: openFolderName(nestedFolder.title), exact: true }).waitFor();
          assert.equal(lastListRequest().searchParams.get('search'), null, 'clear search restores ordinary folder listing');
          assert.equal(lastListRequest().searchParams.get('after'), null, 'clear search resets pagination');
          assert.equal(await page.getByRole('button', { name: deepMaterial.title, exact: true }).count(), 0, 'clear does not keep descendant results in direct folder view');
          assert.equal(await page.getByText('Страница 2', { exact: true }).count(), 0);
          await searchFor('командировочные');
          await resultPath.waitFor();
          await searchBox.fill('');
          await page.getByRole('button', { name: openFolderName(nestedFolder.title), exact: true }).waitFor();
          assert.equal(lastListRequest().searchParams.get('search'), null, 'empty input, including native search clear, immediately clears the applied query');
          await searchFor('командировочные');
          await resultPath.waitFor();
          await page.getByRole('button', { name: 'Архив', exact: true }).click();
          await page.getByRole('searchbox', { name: 'Поиск в архиве текущей папки', exact: true }).waitFor();
          await page.getByText('Ничего не найдено', { exact: true }).waitFor();
          assert.equal(lastListRequest().searchParams.get('archived'), '1');
          assert.equal(await page.getByRole('navigation', { name: /^Расположение/ }).count(), 0, 'archive keeps direct-folder search and does not show active-tree results');
          await page.getByRole('button', { name: 'К материалам', exact: true }).click();
          await resultPath.waitFor();
          await page.getByRole('button', { name: 'Сбросить поиск', exact: true }).click();
          await page.getByRole('button', { name: openFolderName(nestedFolder.title), exact: true }).waitFor();
          let markStarted = () => {}, releaseDelayed = () => {};
          delayedSearch = { started: new Promise<void>((resolve) => { markStarted = resolve; }), onStart: () => markStarted(),
            release: new Promise<void>((resolve) => { releaseDelayed = resolve; }), finish: () => releaseDelayed() };
          await searchBox.fill('отложенный');
          await page.getByRole('button', { name: 'Найти', exact: true }).click();
          await delayedSearch.started;
          await page.getByRole('button', { name: 'Сбросить поиск', exact: true }).click();
          await page.getByRole('button', { name: openFolderName(nestedFolder.title), exact: true }).waitFor();
          delayedSearch.finish();
          await page.waitForLoadState('networkidle');
          delayedSearch = null;
          assert.equal(await page.getByRole('button', { name: 'Устаревший результат', exact: true }).count(), 0, 'late cancelled search cannot overwrite the normal listing');
          assert.equal(await searchBox.inputValue(), '');
          assert.deepEqual(errors, []);
          searchFixture = false;

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

          // Root/ancestor breadcrumb drops and root destination for a file.
          scenario = 'move root/ancestor';
          resetMoves();
          await gotoMovePage(origin + '/admin/knowledge-base?folder=1');
          await grip(material.title).waitFor();
          await dropOn(grip(material.title), page.getByRole('navigation', { name: 'Путь папки', exact: true }).getByRole('button', { name: 'База знаний', exact: true }));
          dialog = page.getByRole('dialog');
          await dialog.getByRole('button', { name: 'Подтвердить перемещение', exact: true }).waitFor();
          assert.equal((moveRequests('preview').at(-1)!.body as { targetParentId: number | null }).targetParentId, null, 'root breadcrumb previews file move');
          await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
          await moveButton(material.title).click();
          dialog = page.getByRole('dialog');
          await dialog.getByRole('button', { name: 'В корень', exact: true }).click();
          await dialog.getByRole('button', { name: `Выбрать расположение внутри «${longFolder.title}»`, exact: true }).waitFor();
          assert.equal(await dialog.getByRole('button', { name: 'Переместить сюда', exact: true }).isEnabled(), true, 'picker allows file at root');
          await dialog.getByRole('button', { name: 'Переместить сюда', exact: true }).click();
          await dialog.getByRole('button', { name: 'Подтвердить перемещение', exact: true }).click();
          await page.getByRole('status').filter({ hasText: 'в корень Базы знаний' }).waitFor();
          assert.equal(moveNodes.find((node) => node.id === material.id)!.parentId, null, 'root file move commits after preview');
          // A fresh page checks persisted root placement independently of earlier
          // dialogs and SPA navigation. Assert concrete title, frame content, and
          // Close behavior instead of the unrelated global networkidle state.
          const rootPreviewPage = await browser.newPage({ viewport: { width, height: 1000 } });
          try {
            rootPreviewPage.setDefaultTimeout(10_000);
            rootPreviewPage.on('pageerror', (error: Error) => errors.push(error.message));
            await rootPreviewPage.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
            await rootPreviewPage.goto(origin + '/admin/knowledge-base');
            const rootFile = rootPreviewPage.getByRole('button', { name: material.title, exact: true });
            await rootFile.click();
            const rootDialog = rootPreviewPage.getByRole('dialog');
            assert.equal(await rootDialog.locator('iframe').getAttribute('sandbox'), 'allow-scripts', 'root HTML remains isolated');
            await rootPreviewPage.frameLocator('dialog iframe').getByRole('heading', { name: 'Тестовый регламент', exact: true }).waitFor();
            await rootDialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
            await rootDialog.waitFor({ state: 'detached' });
            assert.equal(await rootFile.isVisible(), true, 'closing root preview returns to the root file list');
          } finally { await rootPreviewPage.close(); }
          resetMoves();
          await gotoMovePage(origin + '/admin/knowledge-base?folder=1');
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

          scenario = 'archive navigation and guarded permanent delete';
          resetDeletes();
          const deleteButton = (title: string) => page.getByRole('button', { name: `Удалить навсегда «${title}»`, exact: true });
          const deleteRequests = (action: string) => calls.filter((call) => call.path.endsWith('/delete') && (call.body as { action: string }).action === action);
          await gotoPage(origin + '/admin/knowledge-base');
          assert.equal(await page.getByRole('button', { name: /^Удалить навсегда/ }).count(), 0, 'active materials never expose permanent delete');
          await page.getByRole('button', { name: 'Архив', exact: true }).click();
          await deleteButton(archivedFolder.title).waitFor();
          assert.equal(new URL(page.url()).searchParams.get('archived'), '1');
          await page.getByRole('button', { name: openFolderName(archivedFolder.title), exact: true }).click();
          await page.getByRole('button', { name: openFolderName(archivedChildFolder.title), exact: true }).waitFor();
          assert.equal(await page.getByRole('button', { name: 'Восстановить', exact: true }).count(), 0, 'children of archived parent cannot be restored independently');
          await page.goBack();
          await deleteButton(archivedFolder.title).waitFor();
          await page.goForward();
          await page.getByRole('button', { name: openFolderName(archivedChildFolder.title), exact: true }).waitFor();
          await page.reload();
          await page.getByRole('button', { name: openFolderName(archivedChildFolder.title), exact: true }).waitFor();
          assert.equal(new URL(page.url()).searchParams.get('archived'), '1', 'reload and browser history preserve archive context');
          await page.getByRole('button', { name: openFolderName(archivedChildFolder.title), exact: true }).click();
          await deleteButton(archivedChildFile.title).click();
          dialog = page.getByRole('dialog');
          const confirmation = () => dialog.getByRole('textbox', { name: /^Для подтверждения введите название/ });
          await confirmation().waitFor();
          assert.deepEqual(await dialog.locator('dd').allTextContents(), ['1', '0', '1', '1 КБ']);
          assert.equal(await dialog.getByRole('button', { name: 'Удалить навсегда', exact: true }).isDisabled(), true);
          await confirmation().fill('неверное название');
          assert.equal(await dialog.getByRole('button', { name: 'Удалить навсегда', exact: true }).isDisabled(), true, 'exact name is mandatory');
          await confirmation().fill(archivedChildFile.title);
          const beforeChildDelete = deleteRequests('commit').length;
          await dialog.getByRole('button', { name: 'Удалить навсегда', exact: true }).evaluate((node: HTMLButtonElement) => { node.click(); node.click(); });
          await page.getByRole('status').filter({ hasText: 'Через сайт восстановить нельзя.' }).waitFor();
          assert.equal(deleteRequests('commit').length, beforeChildDelete + 1, 'double click causes only one deletion commit');
          assert.equal(deleteNodes.some((node) => node.id === archivedChildFile.id), false);
          assert.ok(deleteNodes.some((node) => node.id === archivedFolder.id && node.archivedAt === stamp), 'deleting a child does not restore or delete its parent');
          await page.getByRole('button', { name: 'К материалам', exact: true }).click();
          await page.getByRole('button', { name: openFolderName(folder.title), exact: true }).waitFor();
          assert.equal(new URL(page.url()).searchParams.get('folder'), null, 'leaving archived subtree opens nearest live ancestor');
          assert.equal(new URL(page.url()).searchParams.get('archived'), null);

          resetDeletes();
          await gotoPage(origin + '/admin/knowledge-base?archived=1');
          await deleteButton(archivedFolder.title).click();
          dialog = page.getByRole('dialog');
          await confirmation().waitFor();
          assert.deepEqual(await dialog.locator('dd').allTextContents(), ['4', '2', '2', '2 КБ'], 'folder preview includes all nested descendants');
          assert.match(await dialog.getByRole('note').innerText(), /всё её содержимое/);
          assert.equal(await dialog.evaluate((node: HTMLElement) => node.scrollWidth <= node.clientWidth), true);
          await dialog.screenshot({ path: path.join(output, `${engine}-${width}-delete-confirmation.png`) });
          const beforeCancelledDelete = deleteRequests('commit').length;
          await dialog.press('Escape');
          assert.equal(deleteRequests('commit').length, beforeCancelledDelete, 'cancel never deletes');
          await deleteButton(archivedFolder.title).click();
          dialog = page.getByRole('dialog');
          await confirmation().fill(archivedFolder.title);
          await dialog.getByRole('button', { name: 'Удалить навсегда', exact: true }).click();
          await page.getByRole('status').filter({ hasText: 'вместе с содержимым' }).waitFor();
          assert.deepEqual(deleteNodes.map((node) => node.id).sort((a, b) => a - b), [folder.id, archivedRootFile.id], 'only confirmed archived subtree disappears');

          scenario = 'delete conflict and lost response';
          resetDeletes();
          await gotoPage(origin + '/admin/knowledge-base?archived=1');
          await deleteButton(archivedRootFile.title).click();
          dialog = page.getByRole('dialog');
          await confirmation().fill(archivedRootFile.title);
          deleteFailure = 'conflict';
          await dialog.getByRole('button', { name: 'Удалить навсегда', exact: true }).click();
          await dialog.getByRole('alert').filter({ hasText: 'Состав материалов или права доступа изменились' }).waitFor();
          assert.equal(await dialog.getByRole('button', { name: 'Удалить навсегда', exact: true }).count(), 0, 'stale preview cannot be retried');
          await dialog.getByRole('button', { name: 'Закрыть и обновить список', exact: true }).click();
          await deleteButton(archivedRootFile.title).waitFor();
          deleteFailure = 'none'; deletePreviewConflict = true;
          const beforeFailedPreview = deleteRequests('commit').length;
          await deleteButton(archivedRootFile.title).click();
          dialog = page.getByRole('dialog');
          await dialog.getByRole('alert').filter({ hasText: 'Материал уже изменён' }).waitFor();
          assert.equal(await confirmation().count(), 0);
          assert.equal(deleteRequests('commit').length, beforeFailedPreview);
          await dialog.getByRole('button', { name: 'Закрыть и обновить список', exact: true }).click();
          await deleteButton(archivedRootFile.title).waitFor();
          deletePreviewConflict = false; deleteFailure = 'unknown';
          await deleteButton(archivedRootFile.title).click();
          dialog = page.getByRole('dialog');
          await confirmation().fill(archivedRootFile.title);
          const beforeUnknownDelete = deleteRequests('commit').length;
          await dialog.getByRole('button', { name: 'Удалить навсегда', exact: true }).click();
          await dialog.getByRole('alert').filter({ hasText: 'Удаление могло уже выполниться' }).waitFor();
          assert.equal(await dialog.getByRole('button', { name: 'Удалить навсегда', exact: true }).count(), 0, 'unknown result never offers a blind retry');
          await dialog.getByRole('button', { name: 'Закрыть и обновить список', exact: true }).click();
          await deleteButton(archivedRootFile.title).waitFor({ state: 'detached' });
          await deleteButton(archivedFolder.title).waitFor();
          assert.equal(await deleteButton(archivedRootFile.title).count(), 0, 'refresh discovers successful deletion after lost response');
          assert.equal(deleteRequests('commit').length, beforeUnknownDelete + 1, 'refresh does not repeat deletion');
          assert.deepEqual(errors, []);
          await page.waitForLoadState('networkidle');
          deleteFixture = false;
          readOnly = true;
          calls.length = 0;
          await gotoPage(origin + '/admin/knowledge-base?reader=1');
          await page.getByRole('button', { name: openFolderName(folder.title), exact: true }).waitFor();
          assert.equal(await page.getByRole('button', { name: 'Создать папку', exact: true }).count(), 0);
          assert.equal(await page.getByRole('button', { name: 'Статистика использования', exact: true }).count(), 0);
          assert.equal(await page.getByRole('button', { name: 'Настроить', exact: true }).count(), 0);
          assert.equal(await page.getByRole('button', { name: 'Архив', exact: true }).count(), 0);
          assert.equal(await page.getByRole('button', { name: /^Удалить навсегда/ }).count(), 0, 'reader cannot permanently delete');
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
