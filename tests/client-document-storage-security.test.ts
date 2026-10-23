import assert from 'node:assert/strict';
import { constants, readFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import ts from 'typescript';
import { readClientDocumentFile, saveClientDocumentUpload } from '../src/shared/lib/clientDocumentStorage';
import { createClientDocumentDownloadResponse } from '../src/shared/lib/clientDocumentDownloadResponse';

test('client document uploads protect the existing subtree, preserving legacy bytes and public siblings', async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'kts-private-document-')));
  const oldRoot = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = root;
  t.after(async () => {
    if (oldRoot === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = oldRoot;
    await rm(root, { recursive: true, force: true });
  });
  const privateRoot = path.join(root, 'client-documents');
  const company = path.join(privateRoot, '13');
  await mkdir(company, { recursive: true, mode: 0o755 });
  await chmod(privateRoot, 0o755);
  await writeFile(path.join(company, 'legacy.pdf'), 'synthetic legacy document');
  await writeFile(path.join(root, 'public.txt'), 'public sibling');
  const publicMode = (await lstat(root)).mode;
  const saved = await saveClientDocumentUpload(13, new File(['new private bytes'], 'Новый счёт.pdf', { type: 'application/pdf' }));
  assert.match(saved.filePath, /^client-documents\/13\/[^/]+\.pdf$/);
  assert.equal((await lstat(privateRoot)).mode & 0o777, 0o700);
  assert.equal((await lstat(company)).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(root, saved.filePath))).mode & 0o777, 0o600);
  assert.equal((await lstat(root)).mode, publicMode, 'public upload root must stay unchanged');
  assert.equal(await readFile(path.join(root, 'public.txt'), 'utf8'), 'public sibling');
  assert.equal((await readClientDocumentFile('client-documents/13/legacy.pdf', 13)).toString(), 'synthetic legacy document');
  assert.equal((await readClientDocumentFile(saved.filePath, 13)).toString(), 'new private bytes');
  await assert.rejects(readClientDocumentFile(saved.filePath, 14), /Некорректный путь/);
  for (const invalid of ['../public.txt', 'client-documents/13/../../public.txt', '/etc/passwd', 'client-documents\\13\\legacy.pdf']) {
    await assert.rejects(readClientDocumentFile(invalid, 13), /Некорректный путь/);
  }
  await symlink(path.join(root, 'public.txt'), path.join(company, 'link.pdf'));
  await assert.rejects(readClientDocumentFile('client-documents/13/link.pdf', 13));
  await symlink(company, path.join(privateRoot, '14'));
  await assert.rejects(readClientDocumentFile('client-documents/14/legacy.pdf', 14), /Небезопасный каталог/);
  await assert.rejects(saveClientDocumentUpload(14, new File(['test'], 'test.pdf')), /Небезопасный каталог/);
  const response = await createClientDocumentDownloadResponse({ ...saved, id: 1, companyId: 13,
    title: 'Document', isVisible: true, createdAt: '', updatedAt: '' });
  assert.equal(await response.text(), 'new private bytes');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.match(response.headers.get('content-disposition')!, /^attachment;/);
  assert.deepEqual((await readdir(company)).sort(), ['legacy.pdf', 'link.pdf', path.basename(saved.filePath)].sort());
});

test('a symlinked private root cannot redirect uploads or change the target permissions', async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'kts-document-root-link-')));
  const oldRoot = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = root;
  t.after(async () => {
    if (oldRoot === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = oldRoot;
    await rm(root, { recursive: true, force: true });
  });
  const outside = path.join(root, 'unchanged');
  await mkdir(outside, { mode: 0o755 });
  await chmod(outside, 0o755);
  await symlink(outside, path.join(root, 'client-documents'));
  await assert.rejects(saveClientDocumentUpload(13, new File(['secret'], 'test.pdf')), /Небезопасный каталог/);
  assert.equal((await lstat(outside)).mode & 0o777, 0o755);
  assert.deepEqual(await readdir(outside), []);
});

test('failed, aborted or inconsistent document reads create no directories or files', async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'kts-document-read-failure-')));
  const oldRoot = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = root;
  t.after(async () => {
    if (oldRoot === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = oldRoot;
    await rm(root, { recursive: true, force: true });
  });
  const unreadable = new File(['synthetic'], 'example.pdf');
  Object.defineProperty(unreadable, 'arrayBuffer', { value: async () => { throw new Error('synthetic read failure'); } });
  await assert.rejects(saveClientDocumentUpload(13, unreadable), /synthetic read failure/);

  const inconsistent = new File(['synthetic'], 'example.pdf');
  Object.defineProperty(inconsistent, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
  await assert.rejects(saveClientDocumentUpload(13, inconsistent), /Размер документа/);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(saveClientDocumentUpload(13, new File(['synthetic'], 'example.pdf'), { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(await readdir(root), []);
});

test('partial document writes remove only the new file and keep existing documents', async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'kts-document-partial-write-')));
  const oldRoot = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = root;
  t.after(async () => {
    if (oldRoot === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = oldRoot;
    await rm(root, { recursive: true, force: true });
  });
  const companyDirectory = path.join(root, 'client-documents', '13');
  await mkdir(companyDirectory, { recursive: true });
  await writeFile(path.join(companyDirectory, 'existing.pdf'), 'existing private bytes');

  const compiled = ts.transpileModule(readFileSync('src/shared/lib/clientDocumentStorage.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const instance = { exports: {} };
  const dependencies: Record<string, unknown> = {
    crypto: { randomUUID: () => 'synthetic-unique-file' },
    fs: { constants },
    path: { default: path },
    'fs/promises': {
      ...fsPromises,
      open: async (filename: string, flags: string | number, mode?: number) => {
        const handle = await fsPromises.open(filename, flags, mode);
        if (flags !== 'wx') return handle;
        return {
          stat: () => handle.stat(),
          close: () => handle.close(),
          writeFile: async (bytes: Buffer) => {
            await handle.writeFile(bytes.subarray(0, 3));
            throw Object.assign(new Error('synthetic disk-full failure'), { code: 'ENOSPC' });
          },
        };
      },
    },
  };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`);
    return dependencies[name];
  }, instance, instance.exports);
  const storage = instance.exports as typeof import('../src/shared/lib/clientDocumentStorage');
  await assert.rejects(storage.saveClientDocumentUpload(13, new File(['partial synthetic upload'], 'example.pdf')), /disk-full/);
  assert.deepEqual(await readdir(companyDirectory), ['existing.pdf']);
  assert.equal(await readFile(path.join(companyDirectory, 'existing.pdf'), 'utf8'), 'existing private bytes');
});
