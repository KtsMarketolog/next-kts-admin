/** Run after build: node --import tsx --test tests/firmware-http.integration.ts */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFirmwareStore } from '../src/shared/lib/firmwareStorage';

test('real standalone firmware HTTP keeps legacy URLs, publishes pairs and hides history', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kts-firmware-http-'));
  let child: ReturnType<typeof spawn> | undefined;
  let output = '';
  try {
    const source = path.resolve('.next/standalone');
    // Never copy deployment env/credentials into this synthetic runtime.
    await cp(source, root, { recursive: true, filter: (entry) => !path.basename(entry).startsWith('.env') && path.basename(entry) !== 'public' });
    const firmwareRoot = path.join(root, 'public/klimatika/prog/firmware/update');
    const legacy = path.join(firmwareRoot, 'hse/gen_1');
    await mkdir(legacy, { recursive: true });
    const original = { c23: Buffer.from('synthetic-original-firmware'), ver: Buffer.from('Version: synthetic-old') };
    for (const kind of ['c23', 'ver'] as const) await writeFile(path.join(legacy, `hse_gen_1.${kind}`), original[kind]);
    const portProbe = createServer();
    await new Promise<void>((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
    const address = portProbe.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;
    await new Promise<void>((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()));
    child = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: String(port),
        DATABASE_URL: '', APP_RELEASE_ID: '', NEXT_TELEMETRY_DISABLED: '1' },
    });
    child.stdout!.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
    child.stderr!.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
    const base = `http://127.0.0.1:${port}`;
    const url = (kind: string) => `${base}/klimatika/prog/firmware/update/hse/gen_1/hse_gen_1.${kind}`;
    let started = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) assert.fail(`Synthetic server exited: ${output}`);
      try { const response = await fetch(url('ver')); if (response.ok) { await response.arrayBuffer(); started = true; break; } }
      catch { /* Only a local synthetic server is being awaited. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(started, `Synthetic server did not become ready: ${output}`);
    async function expectPair(pair: typeof original) {
      for (const kind of ['c23', 'ver'] as const) {
        const response = await fetch(url(kind));
        assert.equal(response.status, 200);
        assert.match(response.headers.get('cache-control')!, /no-store/);
        assert.equal(Number(response.headers.get('content-length')), pair[kind].length);
        assert.equal(response.headers.get('etag'), `"${createHash('sha256').update(pair[kind]).digest('hex')}"`);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), pair[kind]);
      }
    }
    await expectPair(original);
    const store = createFirmwareStore(firmwareRoot);
    const before = await store.overview();
    const next = { c23: Buffer.alloc(64 * 1024, 0x34), ver: Buffer.from('Version: synthetic-new') };
    const published = await store.publish({
      expectedRevision: before.revision,
      c23: new File([next.c23], 'synthetic.c23'), ver: new File([next.ver], 'synthetic.ver'),
      c23Sha256: createHash('sha256').update(next.c23).digest('hex'),
      verSha256: createHash('sha256').update(next.ver).digest('hex'),
    });
    await expectPair(next);
    const partial = await fetch(url('c23'), { headers: { Range: 'bytes=5-25' } });
    assert.equal(partial.status, 206);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), next.c23.subarray(5, 26));
    const head = await fetch(url('ver'), { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), next.ver.length);
    const prefix = '/klimatika/prog/firmware/update';
    for (const suffix of ['/.firmware-store/state.json', `/.firmware-store/releases/${published.current!.id}/hse_gen_1.c23`,
      '/%2efirmware-store/state.json', '/.incoming/x', '/hse/gen_1/hse_gen_1.ver.bak']) {
      const response = await fetch(`${base}${prefix}${suffix}`);
      assert.equal(response.status, 404, suffix);
    }
    await store.rollback({ expectedRevision: published.revision, previousId: published.previous!.id });
    await expectPair(original);
    for (const kind of ['c23', 'ver'] as const) assert.deepEqual(await readFile(path.join(legacy, `hse_gen_1.${kind}`)), original[kind]);
    assert.doesNotMatch(output, /runtime_ready|Database is ready/);
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child!.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    }
    // Exact mktemp directory created by this test; no production paths.
    await rm(root, { recursive: true, force: true });
  }
});
