/** Real Next HTTP/proxy pipeline; isolated synthetic snapshots, no credentials or business database. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createGzip, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES, SUPPORT_SHARED_JSON_MAX_BYTES } from '../src/shared/lib/supportSharedRoutePlannerLimits';

const PATHNAME = '/api/admin/manager-dashboard/shared/json';

async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

/** Never send the claimed body: auth, origin, rate limit and declared byte checks must answer first. */
async function headersOnly(origin: string, headers: Record<string, string> = {}) {
  let request: ReturnType<typeof httpRequest> | undefined;
  try {
    return await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
      request = httpRequest(origin + PATHNAME, { method: 'POST', headers: {
        origin, 'content-type': 'application/gzip', 'content-length': String(SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES), ...headers,
      } }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }));
        response.on('error', reject);
      });
      request.on('error', reject);
      request.setTimeout(5_000, () => reject(new Error('Rejected JSON upload waited for its body')));
      request.flushHeaders();
    });
  } finally { request?.destroy(); }
}

function snapshot() {
  return {
    snapshot: true, app: 'компоновщик', savedAt: '2026-10-27T08:00:00.000Z',
    orders: [], confirmed: [], zones: [], addrs: [], aliases: {}, contacts: [], tk: [], nomen: [], depots: [],
    opt: { maxPoints: 6, maxWeight: 0, maxVol: 0, innerKm: 15, splitByOrg: false, splitByWh: false },
    winding: 1.3, rate: 0,
    f: { from: '', to: '', ordFrom: '', ordTo: '', zone: [], org: [], dir: [], wh: [], author: [], onlyConfirmed: true },
    files: [], diag: {},
  };
}

/** A full row array, not a huge retained buffer or a large token. Tail padding gives an exact boundary. */
function syntheticRows(size: number, onHash: (hash: string) => void) {
  const [before, after] = JSON.stringify(snapshot()).split('"orders":[]');
  const head = Buffer.from(`${before}"orders":[`);
  const tail = Buffer.from(`]${after}`);
  const row = JSON.stringify({ id: 'synthetic-row', label: 'x'.repeat(1000), weight: 1.25, volume: 0.1 });
  const block = Buffer.from(`${row},`.repeat(64));
  const last = Buffer.from(row);
  return (function* () {
    const hash = createHash('sha256');
    let bytes = 0;
    function part(chunk: Buffer) { bytes += chunk.length; hash.update(chunk); return chunk; }
    yield part(head);
    while (bytes + block.length + last.length + tail.length <= size) yield part(block);
    yield part(last);
    yield part(tail);
    yield part(Buffer.alloc(size - bytes, 0x20));
    assert.equal(bytes, size);
    onHash(hash.digest('hex'));
  })();
}

function expansionBeyondLimit() {
  return (function* () {
    const initial = Buffer.from(JSON.stringify(snapshot()));
    yield initial;
    const spaces = Buffer.alloc(64 * 1024, 0x20);
    const size = SUPPORT_SHARED_JSON_MAX_BYTES + 1;
    for (let offset = initial.length; offset < size; offset += spaces.length) {
      yield spaces.subarray(0, Math.min(spaces.length, size - offset));
    }
  })();
}

async function uploadStream(origin: string, chunks: Iterable<Buffer>) {
  const source = Readable.from(chunks);
  const gzip = createGzip();
  let compressedBytes = 0;
  gzip.on('data', chunk => { compressedBytes += chunk.length; });
  try {
    const response = await fetch(origin + PATHNAME, {
      method: 'POST', headers: { origin, 'content-type': 'application/gzip', 'x-synthetic-auth': 'yes' },
      body: Readable.toWeb(source.pipe(gzip)), duplex: 'half', signal: AbortSignal.timeout(120_000),
    } as RequestInit & { duplex: 'half' });
    return { status: response.status, data: await response.json(), compressedBytes };
  } finally { source.destroy(); gzip.destroy(); }
}

async function main() {
  const repository = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'kts-next-route-json-')));
  const storage = path.join(directory, 'private-json');
  let child: ReturnType<typeof spawn> | undefined;
  let output = '';
  try {
    await mkdir(path.join(directory, 'app/api/[...segments]'), { recursive: true });
    await mkdir(storage);
    await symlink(path.join(repository, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'synthetic-next-route-json', private: true }));
    await writeFile(path.join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'ES2022', moduleResolution: 'bundler', paths: { '@/*': [path.join(repository, 'src/*')] },
      esModuleInterop: true, jsx: 'preserve', skipLibCheck: true,
    } }));
    await writeFile(path.join(directory, 'next.config.ts'), `
import config from ${JSON.stringify(path.join(repository, 'next.config'))};
// Actual proxy.ts must exclude this route from Next request-body cloning.
export default { headers: config.headers, experimental: { proxyClientMaxBodySize: '1kb' } };
`);
    const proxy = await readFile(path.join(repository, 'src/proxy.ts'), 'utf8');
    await writeFile(path.join(directory, 'proxy.ts'), proxy.replaceAll("'@/", `'${repository}/src/`));
    await writeFile(path.join(directory, 'app/api/[...segments]/route.ts'), `
import { prepareSupportSharedRoutePlannerUpload, openVerifiedSupportSharedRoutePlannerFile } from ${JSON.stringify(path.join(repository, 'src/shared/lib/supportSharedRoutePlannerData'))};
import { SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES } from ${JSON.stringify(path.join(repository, 'src/shared/lib/supportSharedRoutePlannerLimits'))};
import { createUploadRequestGuard } from ${JSON.stringify(path.join(repository, 'src/shared/lib/uploadRequestGuard'))};
import { enforceSameOriginRequest } from ${JSON.stringify(path.join(repository, 'src/shared/lib/originProtection'))};
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
let current: {storagePath:string,fileSize:number,sha256:string}|null = null;
let busy = false;
const headers = {'Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow, noarchive'};
export async function GET() {
  if (current) {
    const verified = await openVerifiedSupportSharedRoutePlannerFile(current.storagePath,current.fileSize,current.sha256);
    verified.destroy();
  }
  return Response.json({snapshot:current && {fileSize:current.fileSize,sha256:current.sha256}}, {headers});
}
export async function POST(request: Request) {
  const untouched = {...headers,'x-test-body-used':String(request.bodyUsed)};
  if(request.headers.get('x-synthetic-auth') !== 'yes') return Response.json({error:'Synthetic unauthorized'},{status:401,headers:untouched});
  const originError = enforceSameOriginRequest(request); if(originError) return originError;
  if(request.headers.get('x-synthetic-rate-limit') === 'yes') return Response.json({error:'Synthetic limited'},{status:429,headers:untouched});
  const length = request.headers.get('content-length');
  if(length !== null && (!/^\\d+$/.test(length) || Number(length)>SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES)) return Response.json({error:'Synthetic compressed-size rejection'},{status:413,headers:untouched});
  if(busy) return Response.json({error:'Synthetic busy'}, {status:409,headers:untouched});
  busy = true;
  const guard = createUploadRequestGuard(request,{maxBytes:SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES,idleTimeoutMs:10000,totalTimeoutMs:120000});
  let pending;
  try {
    const prepared = await prepareSupportSharedRoutePlannerUpload(guard.request); pending=prepared.pending;
    guard.assertActive();
    const storagePath = await pending.commit();
    guard.assertActive();
    current={storagePath,fileSize:pending.fileSize,sha256:pending.sha256};
    pending.preserve();
    return Response.json({snapshot:{fileSize:current.fileSize,sha256:current.sha256}}, {status:201,headers});
  } catch(error) {
    const failure = guard.error || error;
    return Response.json({error:failure.message,code:failure.code}, {status:guard.error?.status || (/SIZE/.test(failure.code) ? 413 : 400),headers});
  } finally { guard.dispose(); await pending?.discard(); busy=false; }
}
`);
    const port = await unusedPort();
    const environment: NodeJS.ProcessEnv = { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'development', TOP_DASHBOARD_DATA_DIR: storage };
    for (const key of ['DATABASE_URL', 'ADMIN_PASSWORD', 'ADMIN_SESSION_SECRET', 'EMPLOYEE_PASSWORD_ENCRYPTION_KEY']) delete environment[key];
    child = spawn(process.execPath, [path.join(repository, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { output = (output + String(chunk)).slice(-32_768); });
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60_000;
    while (true) {
      try { if ((await fetch(origin + PATHNAME, { signal: AbortSignal.timeout(5_000) })).status === 200) break; }
      catch { /* Startup/first compile. */ }
      if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline || /Module not found|Failed to compile/.test(output)) throw new Error('Synthetic Next did not start');
      await delay(250);
    }
    for (const [requestHeaders, status] of [
      [{}, 401],
      [{'x-synthetic-auth':'yes','x-synthetic-rate-limit':'yes'},429],
      [{'x-synthetic-auth':'yes','content-length':String(SUPPORT_SHARED_JSON_COMPRESSED_MAX_BYTES+1)},413],
      [{'x-synthetic-auth':'yes',origin:'https://foreign.example'},403],
    ] as const) {
      const rejected = await headersOnly(origin, requestHeaders);
      assert.equal(rejected.status,status);
      if(status!==403) assert.equal(rejected.headers['x-test-body-used'],'false');
    }
    assert.deepEqual(await readdir(storage), [], 'Denied requests must not create private files');
    let expectedHash = '';
    const started = performance.now();
    const accepted = await uploadStream(origin, syntheticRows(SUPPORT_SHARED_JSON_MAX_BYTES, hash => { expectedHash = hash; }));
    assert.equal(accepted.status,201,JSON.stringify(accepted.data));
    assert.equal(accepted.data.snapshot.fileSize,SUPPORT_SHARED_JSON_MAX_BYTES);
    assert.equal(accepted.data.snapshot.sha256,expectedHash);
    assert.ok(accepted.compressedBytes>1024,'Actual transport must exceed the deliberately tiny Next proxy cap');
    const retained = await (await fetch(origin+PATHNAME)).json();
    assert.deepEqual(retained,accepted.data);
    const malformed = await fetch(origin+PATHNAME,{method:'POST',headers:{origin,'x-synthetic-auth':'yes','content-type':'application/gzip'},body:new Uint8Array(gzipSync('{"incomplete":'))});
    assert.equal(malformed.status,400);
    assert.equal((await uploadStream(origin,expansionBeyondLimit())).status,413);
    assert.deepEqual(await (await fetch(origin+PATHNAME)).json(),retained,'Rejected JSON must leave the current snapshot unchanged');
    assert.deepEqual(await readdir(path.join(storage,'.incoming')),[],'Rejected JSON must leave no pending file');
    assert.doesNotMatch(output,/Body exceeded|exceeded.*proxyClientMaxBodySize/i);
    console.log(JSON.stringify({result:'passed',rawBytes:SUPPORT_SHARED_JSON_MAX_BYTES,compressedBytes:accepted.compressedBytes,
      elapsedSeconds:Math.round((performance.now()-started)/100)/10,
      checks:'real Next/proxy 500 MiB streamed JSON, SHA-256, pre-body auth/origin/rate/501 MiB headers, rejection preserves current file'}));
  } catch(error) { console.error(output); throw error; }
  finally {
    if(child && child.exitCode===null && child.signalCode===null) {
      child.kill('SIGTERM'); await Promise.race([once(child,'exit'),delay(5000)]);
      if(child.exitCode===null && child.signalCode===null) { child.kill('SIGKILL'); await once(child,'exit'); }
    }
    assert.ok(path.basename(directory).startsWith('kts-next-route-json-'));
    await rm(directory,{recursive:true,force:true});
  }
}

main().catch(error=>{console.error(error);process.exitCode=1;});
