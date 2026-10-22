/** Real Next HTTP pipeline; synthetic routes only, no database or business data. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function main() {
  const repository = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'kts-next-header-policy-')));
  const scopedCsp = "default-src 'none'; script-src blob: 'sha256-synthetic'; connect-src 'none'; sandbox allow-scripts allow-popups";
  let child: ReturnType<typeof spawn> | undefined;
  let output = '';
  try {
    await mkdir(path.join(directory, 'app/api/[...segments]'), { recursive: true });
    await symlink(path.join(repository, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'synthetic-next-header-policy', private: true }));
    await writeFile(path.join(directory, 'next.config.ts'),
      `import config from ${JSON.stringify(path.join(repository, 'next.config'))};\nexport default {headers:config.headers};\n`);
    await writeFile(path.join(directory, 'app/api/[...segments]/route.js'), `
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function GET(request) {
  const status = Number(new URL(request.url).searchParams.get('status'));
  if(status === 401 || status === 403) return Response.json({error:'Synthetic denied'}, {status});
  return new Response('<!doctype html><title>Synthetic report</title>', {headers: {
    'Content-Type':'text/html; charset=utf-8', 'Content-Security-Policy':${JSON.stringify(scopedCsp)},
    'X-Test-Route':'synthetic-handler'
  }});
}
`);
    const port = await unusedPort();
    child = spawn(process.execPath, [path.join(repository, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: directory, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { output = (output + String(chunk)).slice(-65_536); });
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60_000;
    while (true) {
      try {
        const response = await fetch(`${origin}/api/probe`, { signal: AbortSignal.timeout(5_000) });
        if (response.status === 200) break;
      } catch { /* Startup and first compilation can take several seconds. */ }
      if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) throw new Error(`Synthetic Next did not start:\n${output}`);
      await delay(100);
    }
    const report = '/api/admin/top-dashboard/blocks/10/versions/83';
    for (const method of ['GET', 'HEAD']) {
      for (const pathname of ['frame', 'content', 'frame/', 'content/'].map(suffix => `${report}/${suffix}`).concat([
        '/api/admin/knowledge-base/files/7?mode=preview',
        '/api/admin/knowledge-base/files/7/?mode=preview',
        '/api/admin/knowledge-base/files/7?mode=download',
      ])) {
        const response = await fetch(`${origin}${pathname}`, { method, signal: AbortSignal.timeout(10_000) });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('x-test-route'), 'synthetic-handler');
        assert.equal(response.headers.get('content-security-policy'), scopedCsp, `${method} ${pathname}`);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
      }
      for (const status of [401, 403]) {
        for (const pathname of [`${report}/content`, '/api/admin/knowledge-base/files/7']) {
          const response = await fetch(`${origin}${pathname}?status=${status}`, { method, signal: AbortSignal.timeout(10_000) });
          assert.equal(response.status, status);
          assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
          assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
          assert.equal(response.headers.get('content-security-policy'), null);
        }
      }
    }
    for (const pathname of ['/api/probe', `${report}/contentx`, `${report}/content/extra`, '/api/admin/top-dashboard/blocks/10/data', '/api/admin/knowledge-base/files/7/extra', '/api/admin/knowledge-base/nodes']) {
      const response = await fetch(origin + pathname, { signal: AbortSignal.timeout(10_000) });
      const policy = response.headers.get('content-security-policy') ?? '';
      assert.equal(response.status, 200);
      assert.match(policy, /script-src 'self' 'unsafe-inline' 'unsafe-eval' https:\/\/crm\.kts-impex\.ru/);
      assert.doesNotMatch(policy, /script-src blob:/);
    }
    console.log('Real Next HTTP: scoped TOP/knowledge-base GET+HEAD, slash normalization, JSON denials and ordinary API CSP passed');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(5_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
    assert.ok(path.basename(directory).startsWith('kts-next-header-policy-'));
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
