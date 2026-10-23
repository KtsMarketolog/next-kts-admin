/** Real Next HTTP/proxy pipeline; synthetic auth and no business data or files. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
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

type HttpResult = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

/** A denied request must receive a response without sending its claimed body. */
async function headersOnly(origin: string, pathname: string, headers: Record<string, string>) {
  let request: ReturnType<typeof httpRequest> | undefined;
  try {
    return await new Promise<HttpResult>((resolve, reject) => {
      request = httpRequest(origin + pathname, {
        method: 'POST', headers: {
          'content-type': 'multipart/form-data; boundary=synthetic-boundary',
          'content-length': String(20 * 1024 * 1024), ...headers,
        },
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }));
        response.on('error', reject);
      });
      request.on('error', reject);
      request.setTimeout(5_000, () => reject(new Error('Denied upload waited for its body before responding')));
      request.flushHeaders();
    });
  } finally {
    request?.destroy();
  }
}

/** Send one byte beyond the payload cap, but never send the closing boundary. */
async function unfinishedOversizedUpload(origin: string) {
  let request: ReturnType<typeof httpRequest> | undefined;
  let sending: Promise<void> | undefined;
  try {
    return await new Promise<HttpResult>((resolve, reject) => {
      request = httpRequest(`${origin}/api/admin/uploads`, {
        method: 'POST', headers: {
          origin, 'x-synthetic-auth': 'yes', 'content-type': 'multipart/form-data; boundary=synthetic-boundary',
        },
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }));
        response.on('error', reject);
      });
      request.on('error', reject);
      request.setTimeout(10_000, () => reject(new Error('Oversized upload did not return a bounded rejection')));
      const active = request;
      sending = (async () => {
        active.write('--synthetic-boundary\r\nContent-Disposition: form-data; name="file"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n');
        const chunk = Buffer.alloc(64 * 1024, 97);
        for (let index = 0; index < 128; index += 1) {
          if (!active.write(chunk)) await once(active, 'drain');
        }
        active.write('x');
        // No end(): the parser must reject now, before the full body arrives.
      })();
      sending.catch(reject);
    });
  } finally {
    request?.destroy();
    await sending?.catch(() => undefined);
  }
}

function assertPrivateHeaders(headers: HttpResult['headers']) {
  assert.match(String(headers['cache-control']), /private.*no-store/);
  assert.match(String(headers['x-robots-tag']), /noindex/);
  assert.equal(headers['x-content-type-options'], 'nosniff');
}

async function main() {
  const repository = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'kts-next-resource-upload-')));
  let child: ReturnType<typeof spawn> | undefined;
  let output = '';
  try {
    await mkdir(path.join(directory, 'app/api/[...segments]'), { recursive: true });
    await symlink(path.join(repository, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'synthetic-next-resource-upload', private: true }));
    await writeFile(path.join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ES2022', moduleResolution: 'bundler', paths: { '@/*': [path.join(repository, 'src/*')] },
      esModuleInterop: true, jsx: 'preserve', skipLibCheck: true,
    } }));
    await writeFile(path.join(directory, 'next.config.ts'), `
import config from ${JSON.stringify(path.join(repository, 'next.config'))};
// A deliberately tiny proxy cap proves these bounded routes bypass cloning.
export default { headers: config.headers, experimental: { proxyClientMaxBodySize: '1kb' } };
`);
    const proxySource = await readFile(path.join(repository, 'src/proxy.ts'), 'utf8');
    await writeFile(path.join(directory, 'proxy.ts'), proxySource.replaceAll("'@/", `'${repository}/src/`));
    await writeFile(path.join(directory, 'app/api/[...segments]/route.ts'), `
import { readBoundedMultipartUpload, BoundedMultipartUploadError } from ${JSON.stringify(path.join(repository, 'src/shared/lib/boundedMultipartUpload'))};
import { UploadRequestError } from ${JSON.stringify(path.join(repository, 'src/shared/lib/uploadRequestGuard'))};
import { enforceSameOriginRequest } from ${JSON.stringify(path.join(repository, 'src/shared/lib/originProtection'))};
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export function GET() { return Response.json({synthetic:true}); }
export async function POST(request: Request) {
  if (request.headers.get('x-synthetic-auth') !== 'yes') return Response.json({error:'Synthetic unauthorized'}, {status:401, headers:{'x-test-body-used':String(request.bodyUsed)}});
  const denied = enforceSameOriginRequest(request); if(denied) return denied;
  if(request.headers.get('x-synthetic-company') === 'denied') return Response.json({error:'Synthetic company denied'}, {status:403, headers:{'x-test-body-used':String(request.bodyUsed)}});
  const pathname = new URL(request.url).pathname;
  const maxFileBytes = (pathname.includes('/catalog/import') ? 25 : pathname.includes('/documents') ? 20 : 8) * 1024 * 1024;
  try {
    const form = await readBoundedMultipartUpload(request, {maxFileBytes,maxBodyBytes:maxFileBytes+256*1024,maxFields:0,allowedTextFields:[],idleTimeoutMs:3000,totalTimeoutMs:15000});
    const file = form.get('file');
    if(!(file instanceof File)) return Response.json({error:'File required'}, {status:400});
    return Response.json({bytes:file.size,name:file.name});
  } catch(error) {
    if(error instanceof UploadRequestError || error instanceof BoundedMultipartUploadError) return Response.json({error:error.message,code:error.code},{status:error.status});
    throw error;
  }
}
`);
    const port = await unusedPort();
    const environment: NodeJS.ProcessEnv = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'development' };
    for (const name of ['DATABASE_URL', 'ADMIN_PASSWORD', 'ADMIN_SESSION_SECRET', 'EMPLOYEE_PASSWORD_ENCRYPTION_KEY']) {
      delete (environment as Record<string, string | undefined>)[name];
    }
    child = spawn(process.execPath, [path.join(repository, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { output = (output + String(chunk)).slice(-32_768); });
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60_000;
    while (true) {
      try {
        const response = await fetch(`${origin}/api/probe`, { signal: AbortSignal.timeout(5_000) });
        if (response.status === 200) break;
      } catch { /* Next startup/first compilation. */ }
      if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline || /Module not found|Failed to compile/.test(output)) {
        throw new Error('Synthetic Next did not start; see captured compiler output.');
      }
      await delay(250);
    }

    const routes = [
      ['/api/admin/uploads', 8], ['/api/admin/clients/19/documents', 20], ['/api/admin/catalog/import', 25],
    ] as const;
    for (const [pathname, megabytes] of routes) {
      for (const trailingSlash of ['', '/']) {
        const unauthorized = await headersOnly(origin, pathname + trailingSlash, { origin });
        // Normalization may redirect a trailing slash without touching the body.
        assert.equal(unauthorized.status, trailingSlash ? 308 : 401, pathname + trailingSlash);
        if (!trailingSlash) {
          assert.equal(unauthorized.headers['x-test-body-used'], 'false');
          assertPrivateHeaders(unauthorized.headers);
        }
      }
      const deniedOrigin = await headersOnly(origin, pathname, { origin: 'https://foreign.example', 'x-synthetic-auth': 'yes' });
      assert.equal(deniedOrigin.status, 403);
      assertPrivateHeaders(deniedOrigin.headers);
      for (const additional of [0, 1]) {
        const form = new FormData();
        form.set('file', new File([new Uint8Array(megabytes * 1024 * 1024 + additional)], 'проверка.bin'));
        const response = await fetch(origin + pathname, {
          method: 'POST', body: form, headers: { origin, 'x-synthetic-auth': 'yes' }, signal: AbortSignal.timeout(20_000),
        });
        assert.equal(response.status, additional ? 413 : 200, `${pathname} ${megabytes} MiB + ${additional}`);
        assert.match(response.headers.get('cache-control') ?? '', /private.*no-store/);
        const data = await response.json();
        if (!additional) {
          assert.equal(data.bytes, megabytes * 1024 * 1024);
          assert.equal(data.name, 'проверка.bin');
        } else assert.equal(data.code, 'TOO_LARGE');
      }
    }
    const forbiddenCompany = await headersOnly(origin, '/api/admin/clients/19/documents', {
      origin, 'x-synthetic-auth': 'yes', 'x-synthetic-company': 'denied',
    });
    assert.equal(forbiddenCompany.status, 403);
    assert.equal(forbiddenCompany.headers['x-test-body-used'], 'false');
    const unfinished = await unfinishedOversizedUpload(origin);
    assert.equal(unfinished.status, 413);
    assert.equal(JSON.parse(unfinished.body).code, 'TOO_LARGE');
    assertPrivateHeaders(unfinished.headers);
    const action = await fetch(`${origin}/api/admin/uploads`, {
      method: 'POST', body: 'synthetic', headers: { origin, 'x-synthetic-auth': 'yes', 'next-action': 'synthetic' },
    });
    assert.equal(action.status, 404);
    assert.doesNotMatch(output, /Body exceeded|exceeded.*proxyClientMaxBodySize/i);
    console.log('Real Next HTTP: 8/20/25 MiB boundaries, streamed oversized 413, pre-body auth/ACL/CSRF, proxy bypass and private headers passed');
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(5_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
    assert.ok(path.basename(directory).startsWith('kts-next-resource-upload-'));
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
