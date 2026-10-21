import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { knowledgeBaseFilename, knowledgeBaseFileStream, knowledgeBaseHtmlPolicy, openKnowledgeBaseFile,
  removeUncommittedKnowledgeBaseFile, saveKnowledgeBaseUpload } from '../src/shared/lib/knowledgeBaseStorage';
import { KNOWLEDGE_BASE_MAX_FILE_BYTES } from '../src/shared/lib/knowledgeBase';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'kts-kb-storage-test-')));
  const before = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = root;
  t.after(async () => {
    if (before === undefined) delete process.env.UPLOAD_DIR; else process.env.UPLOAD_DIR = before;
    assert.ok(path.basename(root).startsWith('kts-kb-storage-test-'));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
function request(body: BodyInit, signal?: AbortSignal) {
  const result = new Request('https://example.test/upload', { method: 'POST', body, signal, duplex: 'half' } as RequestInit);
  result.arrayBuffer = () => { throw new Error('Whole request buffering is forbidden'); };
  result.formData = () => { throw new Error('Multipart buffering is forbidden'); };
  return result;
}

test('KB streams immutable private files with a controlled MIME, digest and owner-only modes', async t => {
  const root = await fixture(t);
  await chmod(root, 0o775);
  await writeFile(path.join(root, 'public.jpg'), 'public unchanged');
  const bytes = '%PDF-1.7\nsynthetic document';
  const saved = await saveKnowledgeBaseUpload(request(bytes), 'Инструкция.pdf');
  assert.equal(saved.mimeType, 'application/pdf');
  assert.equal(saved.size, Buffer.byteLength(bytes));
  assert.equal(saved.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal((await lstat(path.join(root, saved.storagePath))).mode & 0o7777, 0o600);
  assert.equal((await lstat(path.join(root, 'knowledge-base'))).mode & 0o7777, 0o700);
  assert.equal((await lstat(root)).mode & 0o7777, 0o775);
  assert.equal(await readFile(path.join(root, 'public.jpg'), 'utf8'), 'public unchanged');
  const file = await openKnowledgeBaseFile(saved.storagePath, saved.size);
  assert.equal(await new Response(knowledgeBaseFileStream(file)).text(), bytes);
  await assert.rejects(file.stat(), /closed|bad file descriptor/i);
  await removeUncommittedKnowledgeBaseFile(saved.storagePath);
  assert.deepEqual(await readdir(path.join(root, 'knowledge-base')), []);
});

test('KB rejects executables, SVG and traversal names, mismatched signatures and empty files', async t => {
  const root = await fixture(t);
  for (const name of ['run.exe', 'run.js', 'image.svg', '../a.pdf', 'a\\b.pdf', '/a.pdf', 'a\r\n.pdf']) {
    assert.throws(() => knowledgeBaseFilename(name));
  }
  for (const [name, content] of [['a.pdf', '<html>'], ['a.txt', 'MZbinary'], ['a.png', 'not png'], ['a.html', 'a\0b'], ['a.txt', '']]) {
    await assert.rejects(saveKnowledgeBaseUpload(request(content), name));
  }
  assert.deepEqual(await readdir(path.join(root, 'knowledge-base')), []);
});

test('KB bounds a chunked file during transfer and cleans only its failed upload', async t => {
  const root = await fixture(t);
  const kept = await saveKnowledgeBaseUpload(request('keep'), 'kept.txt');
  let remaining = KNOWLEDGE_BASE_MAX_FILE_BYTES + 1;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    const size = Math.min(remaining, 1024 * 1024);
    if (!size) { controller.close(); return; }
    controller.enqueue(new Uint8Array(size).fill(65)); remaining -= size;
  }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  await assert.rejects(saveKnowledgeBaseUpload(request(stream), 'too-big.txt'), { code: 'TOO_LARGE', status: 413 });
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(path.join(root, 'knowledge-base')), [path.basename(kept.storagePath)]);
  const declared = request('short'); declared.headers.set('content-length', String(KNOWLEDGE_BASE_MAX_FILE_BYTES + 1));
  await assert.rejects(saveKnowledgeBaseUpload(declared, 'declared.txt'), { status: 413 });
});

test('KB cancels interrupted streaming uploads and closes descriptors on download cancellation', async t => {
  const root = await fixture(t);
  const signal = new AbortController();
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({ async pull(controller) {
    if (!sent) { sent = true; controller.enqueue(new Uint8Array([65])); }
    else { signal.abort(); await new Promise(resolve => setTimeout(resolve, 1)); }
  } });
  await assert.rejects(saveKnowledgeBaseUpload(request(stream, signal.signal), 'cancelled.txt'));
  assert.deepEqual(await readdir(path.join(root, 'knowledge-base')), []);
  const saved = await saveKnowledgeBaseUpload(request('keep'), 'kept.txt');
  const file = await openKnowledgeBaseFile(saved.storagePath, saved.size);
  await knowledgeBaseFileStream(file).cancel();
  await assert.rejects(file.stat(), /closed|bad file descriptor/i);
});

test('KB refuses private directory/file symlinks, incorrect sizes/modes and storage path traversal', async t => {
  const root = await fixture(t);
  const outside = path.join(root, 'outside'); await mkdir(outside, { mode: 0o755 });
  await symlink(outside, path.join(root, 'knowledge-base'));
  await assert.rejects(saveKnowledgeBaseUpload(request('data'), 'x.txt'), /Unsafe private storage/);
  assert.deepEqual(await readdir(outside), []);
  await rm(path.join(root, 'knowledge-base'));
  const saved = await saveKnowledgeBaseUpload(request('keep'), 'kept.txt');
  for (const bad of ['../outside/file.txt', '/etc/passwd', 'knowledge-base/../x.txt', 'knowledge-base\\x.txt']) {
    await assert.rejects(openKnowledgeBaseFile(bad, 4));
    await assert.rejects(removeUncommittedKnowledgeBaseFile(bad));
  }
  await assert.rejects(openKnowledgeBaseFile(saved.storagePath, 3), /Unsafe private file/);
  await chmod(path.join(root, saved.storagePath), 0o644);
  await assert.rejects(openKnowledgeBaseFile(saved.storagePath, 4), /Unsafe private file/);
  const linked = `knowledge-base/${randomUUID()}.txt`;
  await symlink(path.join(root, saved.storagePath), path.join(root, linked));
  await assert.rejects(openKnowledgeBaseFile(linked, 4));
  await assert.rejects(removeUncommittedKnowledgeBaseFile(linked), /Unsafe cleanup/);
});

test('KB HTML preserves author script hashes but denies privileged origin, popups, forms, remote requests and frames', async t => {
  await fixture(t);
  const source = '<!doctype html><script>window.example=1;\r\n</script><button onclick="example++">+</button><script src="https://evil.test/x.js"></script>';
  const policy = knowledgeBaseHtmlPolicy(source);
  assert.ok(policy.includes(`'sha256-${createHash('sha256').update('window.example=1;\n').digest('base64')}'`));
  for (const expected of ["connect-src 'none'", "frame-src 'none'", "object-src 'none'", "worker-src 'none'", "form-action 'none'", 'sandbox allow-scripts']) assert.ok(policy.includes(expected));
  assert.doesNotMatch(policy, /allow-same-origin|allow-popups|allow-forms|unsafe-eval|https:/);
  const saved = await saveKnowledgeBaseUpload(request(source), 'instruction.html');
  const handle = await openKnowledgeBaseFile(saved.storagePath, saved.size);
  assert.equal(await handle.readFile('utf8'), source); await handle.close();
  assert.throws(() => knowledgeBaseHtmlPolicy(Array.from({ length: 300 }, (_, i) => `<script>window.n=${i}</script>`).join('')), { code: 'HTML_POLICY_TOO_LARGE' });
});
