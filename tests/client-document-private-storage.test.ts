import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { runInNewContext } from 'node:vm';

import { configuredUploadRoot, nginxWorkerUids, protectClientDocumentRoots } from '../ops/client-documents/protect-storage.mjs';
import { CLIENT_DOCUMENT_PROBE_ORIGINS, CLIENT_DOCUMENT_PROBE_PATHS, resolvePrivacyRedirect, verifyClientDocumentPrivacy } from '../scripts/verify-client-document-privacy.mjs';

const ownerUid = process.getuid!();
const otherUid = ownerUid === 33 ? 34 : 33;

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'kts-private-document-test-')));
  t.after(async () => {
    assert.ok(path.basename(root).startsWith('kts-private-document-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const uploads = path.join(root, 'uploads');
  const documents = path.join(uploads, 'client-documents');
  const company = path.join(documents, '12');
  const document = path.join(company, 'existing.pdf');
  const publicFile = path.join(uploads, 'logo.svg');
  await mkdir(company, { recursive: true, mode: 0o755 });
  await chmod(documents, 0o755);
  await writeFile(document, 'unchanged private document bytes', { mode: 0o640 });
  await writeFile(publicFile, '<svg/>', { mode: 0o644 });
  return { root, uploads, documents, document, publicFile };
}

test('private storage gate preserves all existing files, paths and public siblings; second run is idempotent', async (t) => {
  const f = await fixture(t);
  const documentBefore = await stat(f.document);
  const rootBefore = await stat(f.uploads);
  const publicBefore = await stat(f.publicFile);
  const options = { uploadRoots: [f.uploads], workerUids: [otherUid] };
  assert.deepEqual(await protectClientDocumentRoots(options), { privateRoots: 1, workerUids: [otherUid] });
  assert.equal((await stat(f.documents)).mode & 0o7777, 0o700);
  assert.equal(await readFile(f.document, 'utf8'), 'unchanged private document bytes');
  assert.equal(await readFile(f.publicFile, 'utf8'), '<svg/>');
  assert.equal((await stat(f.document)).ino, documentBefore.ino);
  assert.equal((await stat(f.document)).mtimeMs, documentBefore.mtimeMs);
  assert.equal((await stat(f.document)).mode, documentBefore.mode, 'no recursive chmod or file rewrite');
  assert.equal((await stat(f.uploads)).mode, rootBefore.mode, 'global uploads remain public');
  assert.equal((await stat(f.publicFile)).mode, publicBefore.mode);
  const protectedStat = await stat(f.documents);
  await protectClientDocumentRoots(options);
  assert.equal((await stat(f.documents)).ctimeMs, protectedStat.ctimeMs, 'no needless chmod on an already protected directory');
  await protectClientDocumentRoots({ ...options, checkOnly: true });
});

test('gate covers distinct app/Nginx/public roots and deduplicates upload root symlinks', async (t) => {
  const f = await fixture(t);
  const standalone = path.join(f.root, 'standalone-uploads');
  const linked = path.join(f.root, 'linked-uploads');
  await mkdir(standalone, { mode: 0o755 });
  await symlink(f.uploads, linked);
  const result = await protectClientDocumentRoots({ uploadRoots: [f.uploads, standalone, linked], workerUids: [otherUid] });
  assert.equal(result.privateRoots, 2);
  assert.equal((await stat(path.join(standalone, 'client-documents'))).mode & 0o7777, 0o700);
  assert.deepEqual(await readdir(standalone), ['client-documents']);
});

test('775 public parent stays unchanged while its private child becomes owner-only', async (t) => {
  const f = await fixture(t);
  await chmod(f.uploads, 0o775);
  await protectClientDocumentRoots({ uploadRoots: [f.uploads], workerUids: [otherUid] });
  assert.equal((await stat(f.uploads)).mode & 0o7777, 0o775);
  assert.equal((await stat(f.documents)).mode & 0o7777, 0o700);
  assert.equal(await readFile(f.publicFile, 'utf8'), '<svg/>');
  await protectClientDocumentRoots({ uploadRoots: [f.uploads], workerUids: [otherUid], checkOnly: true });
});

test('world-writable upload parents are rejected without changing either directory', async (t) => {
  const f = await fixture(t);
  await chmod(f.uploads, 0o777);
  await assert.rejects(protectClientDocumentRoots({ uploadRoots: [f.uploads], workerUids: [otherUid] }), /not world-writable/);
  assert.equal((await stat(f.uploads)).mode & 0o7777, 0o777);
  assert.equal((await stat(f.documents)).mode & 0o7777, 0o755);
});

test('check mode never creates directories or fixes an insecure mode silently', async (t) => {
  const f = await fixture(t);
  await assert.rejects(protectClientDocumentRoots({ uploadRoots: [f.uploads], workerUids: [otherUid], checkOnly: true }), /isolation was not confirmed/);
  assert.equal((await stat(f.documents)).mode & 0o7777, 0o755);
  const empty = path.join(f.root, 'empty-uploads');
  await mkdir(empty);
  await assert.rejects(protectClientDocumentRoots({ uploadRoots: [empty], workerUids: [otherUid], checkOnly: true }), /directory is missing/);
  assert.deepEqual(await readdir(empty), []);
});

test('unsafe directory symlinks fail without modifying their targets or other document roots', async (t) => {
  const f = await fixture(t);
  const unsafe = path.join(f.root, 'unsafe-uploads');
  const outside = path.join(f.root, 'unrelated');
  await mkdir(unsafe);
  await mkdir(outside, { mode: 0o755 });
  await chmod(outside, 0o755);
  await symlink(outside, path.join(unsafe, 'client-documents'));
  await assert.rejects(protectClientDocumentRoots({ uploadRoots: [f.uploads, unsafe], workerUids: [otherUid] }), /real directory/);
  assert.equal((await stat(outside)).mode & 0o7777, 0o755);
  assert.equal((await stat(f.documents)).mode & 0o7777, 0o755, 'all existing roots are inspected before any chmod');
});

test('gate refuses root/same-owner workers, absent workers and broad paths', async (t) => {
  const f = await fixture(t);
  for (const workerUids of [[], [0], [ownerUid], [otherUid, ownerUid], [Number.NaN]]) {
    await assert.rejects(protectClientDocumentRoots({ uploadRoots: [f.uploads], workerUids }), /distinct non-root uid/);
  }
  await assert.rejects(protectClientDocumentRoots({ uploadRoots: [f.uploads], workerUids: [otherUid], ownerUid: 0 }), /non-root application owner/);
  for (const uploadRoots of [[], ['/'], ['uploads']]) {
    await assert.rejects(protectClientDocumentRoots({ uploadRoots, workerUids: [otherUid] }), /roots are required|broad or relative/);
  }
  assert.equal((await stat(f.documents)).mode & 0o7777, 0o755);
});

test('worker identity inspection excludes master/tools and includes draining workers', () => {
  assert.deepEqual(nginxWorkerUids('0 nginx: master process /usr/sbin/nginx\n33 nginx: worker process\n33 nginx: worker process is shutting down\n501 node --eval "nginx: worker process"'), [33]);
  assert.throws(() => nginxWorkerUids('0 nginx: master process /usr/sbin/nginx'), /No running Nginx workers/);
  assert.deepEqual(nginxWorkerUids('33 nginx: worker process\n44 nginx: worker process'), [33, 44]);
});

test('production storage discovery matches app precedence and rejects ambiguous roots', () => {
  assert.equal(configuredUploadRoot('', undefined), '/var/www/kts-uploads');
  assert.equal(configuredUploadRoot('UPLOAD_DIR=/srv/private uploads', undefined), '/srv/private uploads');
  assert.equal(configuredUploadRoot('UPLOAD_DIR=/srv/file', '/srv/inherited'), '/srv/file');
  assert.equal(configuredUploadRoot('', '/srv/inherited'), '/srv/inherited');
  assert.equal(configuredUploadRoot('UPLOAD_DIR=  ', '/srv/inherited'), '/var/www/kts-uploads');
  assert.equal(configuredUploadRoot('# UPLOAD_DIR=/commented\n  UPLOAD_DIR = /srv/actual  ', '/srv/inherited'), '/srv/actual');
  for (const source of [
    'UPLOAD_DIR=relative', 'UPLOAD_DIR=${HOME}/uploads', 'UPLOAD_DIR=/a\nUPLOAD_DIR=/b',
    'UPLOAD_DIR="/srv/quoted"', "UPLOAD_DIR='/srv/quoted'", 'UPLOAD_DIR=/srv/actual # comment',
    'UPLOAD_DIR=/srv/actual#comment', 'UPLOAD_DIR=/srv/escaped\\ path', 'export UPLOAD_DIR=/srv/exported',
    '\texport\tUPLOAD_DIR=/srv/exported', 'UPLOAD_DIR',
  ]) {
    assert.throws(() => configuredUploadRoot(source, '/srv/inherited'), /explicit absolute|Duplicate|Unsupported/);
  }
  for (const inherited of ['/srv/path#comment', '/srv/"quoted"', '/srv/$VARIABLE']) {
    assert.throws(() => configuredUploadRoot('', inherited), /explicit absolute/);
  }
});

test('storage gate agrees with the actual PM2 env loader for accepted declarations and empty overrides', async () => {
  const source = await readFile(new URL('../ecosystem.config.cjs', import.meta.url), 'utf8');
  for (const environment of ['', '# UPLOAD_DIR=/ignored', 'UPLOAD_DIR=', '  UPLOAD_DIR = /srv/from-file  ', 'UPLOAD_DIR=/srv/private uploads']) {
    for (const inheritedValue of [undefined, '/srv/inherited']) {
      const loadedModule = { exports: {} as { apps?: Array<{ env: Record<string, string> }> } };
      runInNewContext(source, {
        module: loadedModule,
        __dirname: '/opt/kts/releases/test',
        process: { env: inheritedValue === undefined ? {} : { UPLOAD_DIR: inheritedValue } },
        require: (name: string) => {
          if (name === 'path') return path;
          if (name === 'fs') return {
            existsSync: (file: string) => file.endsWith('/.env.local'),
            readFileSync: (file: string) => { assert.ok(file.endsWith('/.env.local')); return environment; },
          };
          throw new Error(`Unexpected ecosystem import: ${name}`);
        },
      });
      const explicitEnv = loadedModule.exports.apps![0].env;
      const effective = Object.hasOwn(explicitEnv, 'UPLOAD_DIR') ? explicitEnv.UPLOAD_DIR : inheritedValue;
      assert.equal(configuredUploadRoot(environment, inheritedValue), effective?.trim() || '/var/www/kts-uploads');
    }
  }
});

test('mandatory public probes cover every origin, normalized/encoded path and GET/HEAD/OPTIONS', async () => {
  const calls: Array<[string, string, string]> = [];
  const result = await verifyClientDocumentPrivacy({ request: async (origin: string, pathname: string, method: string) => {
    calls.push([origin, pathname, method]);
    return CLIENT_DOCUMENT_PROBE_PATHS.includes(pathname) ? 403 : 404;
  } });
  assert.deepEqual(result, { checked: 128, origins: 4 });
  for (const origin of CLIENT_DOCUMENT_PROBE_ORIGINS) for (const pathname of CLIENT_DOCUMENT_PROBE_PATHS) {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) assert.ok(calls.some((call) => call[0] === origin && call[1] === pathname && call[2] === method));
  }
  await verifyClientDocumentPrivacy({ request: async (_origin: string, pathname: string, method: string) => (
    CLIENT_DOCUMENT_PROBE_PATHS.includes(pathname) ? method === 'OPTIONS' ? 405 : 403 : 404
  ) });
});

test('privacy probes fail closed for missing guards, unauthorized responses, public upload regressions and network failures', async () => {
  for (const status of [200, 301, 401, 404, 500]) {
    await assert.rejects(verifyClientDocumentPrivacy({ request: async () => status }), /expected 403/);
  }
  await assert.rejects(verifyClientDocumentPrivacy({ request: async () => 403 }), /Public upload regression/);
  await assert.rejects(verifyClientDocumentPrivacy({ request: async () => { throw new Error('network unavailable'); } }), /network unavailable/);
  await assert.rejects(verifyClientDocumentPrivacy({ origins: [] }), /At least one/);
});

test('probes follow only unchanged resources on canonical redirects, never login/external origins', () => {
  assert.deepEqual(resolvePrivacyRedirect('http://www.kts-impex.ru', '/uploads/client-documents', 'https://kts-impex.ru/uploads/client-documents/'), {
    origin: 'https://kts-impex.ru', pathname: '/uploads/client-documents/',
  });
  assert.deepEqual(resolvePrivacyRedirect('https://kts-impex.ru', '/uploads/unused/%2e%2e/client-documents/file.pdf', '/uploads/client-documents/file.pdf'), {
    origin: 'https://kts-impex.ru', pathname: '/uploads/client-documents/file.pdf',
  });
  for (const target of ['https://other.example/uploads/client-documents/', 'http://kts-impex.ru/uploads/client-documents/', 'https://user:pass@kts-impex.ru/uploads/client-documents/', '/login']) {
    assert.throws(() => resolvePrivacyRedirect('https://kts-impex.ru', '/uploads/client-documents', target), /redirect origin|different resource/);
  }
});

test('deployment requires owner isolation and public deny checks before canary, activation and successful completion', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
  const gate = workflow.indexOf('node "$RELEASE/ops/client-documents/protect-storage.mjs"');
  const publicBefore = workflow.indexOf('node "$RELEASE/scripts/verify-client-document-privacy.mjs"', gate);
  const backup = workflow.indexOf('if ! "$BACKUP_RUNNER" predeploy; then');
  const canary = workflow.indexOf('KTS_PM2_CANARY=1 KTS_PM2_PORT=3001');
  const canaryProbe = workflow.indexOf('node "$RELEASE/scripts/verify-client-document-privacy.mjs" "http://127.0.0.1:3001"');
  const activate = workflow.indexOf('ACTIVATION_STARTED=1');
  assert.ok(gate > 0 && publicBefore > gate && backup > publicBefore && canary > backup && canaryProbe > canary && activate > canaryProbe);
  const publicAfter = workflow.indexOf('node "$RELEASE/scripts/verify-client-document-privacy.mjs"', activate);
  assert.ok(publicAfter > activate && publicAfter < workflow.indexOf('ACTIVATION_STARTED=0\n          trap - EXIT', activate));
  assert.match(workflow, /name: Verify private document isolation publicly[\s\S]*node scripts\/verify-client-document-privacy\.mjs/);
  assert.doesNotMatch(workflow, /verify-client-document-privacy[^\n]*(?:\|\| true|continue-on-error)/);
});
