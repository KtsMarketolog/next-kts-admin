/**
 * Real HTTP + installed Next.js Node request adapter, with the production cron
 * handler and an allowlisted synthetic pruning function. No database module is
 * imported and no stored event is deleted.
 *
 * node --import tsx tests/dashboard-usage-cron.http.integration.ts
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest, type OutgoingHttpHeaders } from 'node:http';
import { runInNewContext } from 'node:vm';
import { NodeNextRequest } from 'next/dist/server/base-http/node';
import { NextRequestAdapter, signalFromNodeResponse } from 'next/dist/server/web/spec-extension/adapters/next-request';
import ts from 'typescript';

const secret = 'synthetic_http_retention_secret_0000000000';
const path = '/api/cron/dashboard-usage';
const expectedResult = { ok: true, deleted: 25, remaining: false, skipped: null, cutoff: '2026-09-08T00:00:00Z' };
const routeCode = ts.transpileModule(readFileSync('src/app/api/cron/dashboard-usage/route.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

async function main() {
  let calls = 0;
  let failPrune = false;
  let legacyGuard = true;
  const errors: string[] = [];
  const observations: Array<{ bodyPresent: boolean; contentLength: string | null; transferEncoding: string | null }> = [];
  const modules: Record<string, unknown> = {
    'node:crypto': { timingSafeEqual },
    '@/shared/lib/db/dashboardUsageRepo': { pruneExpiredDashboardUsage: async () => {
      calls++;
      if (failPrune) throw new Error('synthetic private database detail');
      return expectedResult;
    } },
  };
  const routeExports: Record<string, (request: Request) => Promise<Response>> = {};
  runInNewContext(routeCode, {
    exports: routeExports, Buffer, Response, Request, Headers, ReadableStream,
    AbortController, AbortSignal, setTimeout, clearTimeout,
    console: { error: (message: string) => errors.push(message) },
    process: { env: { DASHBOARD_USAGE_CRON_SECRET: secret } },
    require: (name: string) => {
      assert.ok(name in modules, `Unexpected dependency; no real database/network module may be imported: ${name}`);
      return modules[name];
    },
  });

  const bareWebRequest = new Request(`http://127.0.0.1${path}`, { method: 'POST' });
  assert.equal(bareWebRequest.body, null, 'bare Web Request unit fixture does not model Next.js HTTP POST');
  assert.equal(bareWebRequest.body ? 400 : 200, 200, 'old truthiness guard misleadingly accepts the unit fixture');
  assert.equal(routeExports.GET, undefined, 'pruning remains POST-only');

  const server = createServer(async (incoming, outgoing) => {
    try {
      assert.equal(incoming.url, path);
      assert.equal(incoming.method, 'POST');
      const adapted = NextRequestAdapter.fromNodeNextRequest(new NodeNextRequest(incoming), signalFromNodeResponse(outgoing));
      observations.push({ bodyPresent: adapted.body !== null, contentLength: adapted.headers.get('content-length'), transferEncoding: adapted.headers.get('transfer-encoding') });
      const response = legacyGuard
        ? Response.json({ error: 'Request body is not accepted' }, { status: adapted.body ? 400 : 200 })
        : await routeExports.POST(adapted);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'unexpected fixture error');
      outgoing.writeHead(500).end('Synthetic fixture failed');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = `http://127.0.0.1:${address.port}${path}`;

  const rawPost = (headers: OutgoingHttpHeaders = {}, body?: Buffer) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = httpRequest(endpoint, { method: 'POST', headers: { authorization: `Bearer ${secret}`, ...headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Synthetic HTTP request timed out')));
    outgoing.end(body);
  });

  try {
    const broken = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${secret}` } });
    assert.equal(broken.status, 400, 'old guard rejects a genuinely empty HTTP POST after the Next adapter');
    await broken.arrayBuffer();
    assert.equal(observations.at(-1)?.bodyPresent, true, 'Next exposes an empty stream, not null');
    assert.equal(calls, 0);
    legacyGuard = false;

    const empty = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${secret}` } });
    assert.equal(empty.status, 200, 'real bodyless scheduler-style request succeeds');
    assert.deepEqual(await empty.json(), expectedResult);
    assert.equal(empty.headers.get('cache-control'), 'private, no-store');
    assert.equal(empty.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(calls, 1);

    const zeroLength = await rawPost({ 'Content-Length': '0' });
    assert.equal(zeroLength.status, 200);
    assert.deepEqual(JSON.parse(zeroLength.body), expectedResult);
    assert.equal(calls, 2);
    const chunkedEmpty = await rawPost({ 'Transfer-Encoding': 'chunked' });
    assert.equal(chunkedEmpty.status, 200, 'zero-byte chunked HTTP request is also empty');
    assert.equal(observations.at(-1)?.transferEncoding, 'chunked');
    assert.equal(calls, 3);

    for (const [headers, body] of [
      [{ 'Content-Type': 'application/json' }, Buffer.from('{"cutoff":"2100-01-01","table":"admin_users"}')],
      [{ 'Content-Type': 'text/plain' }, Buffer.from(' ')],
      [{ 'Content-Type': 'application/octet-stream' }, Buffer.from([0])],
      [{ 'Transfer-Encoding': 'chunked' }, Buffer.from('{"actor":1}')],
    ] as const) {
      const rejected = await rawPost(headers, body);
      assert.equal(rejected.status, 400, 'every actual nonempty body is rejected, regardless of content or encoding');
      assert.equal(calls, 3, 'rejected bytes never reach pruning');
      assert.equal(rejected.body.includes(secret), false);
    }

    const denied = await rawPost({ authorization: 'Bearer synthetic-wrong-token' });
    assert.equal(denied.status, 401);
    assert.equal(calls, 3);
    failPrune = true;
    const failure = await rawPost();
    assert.equal(failure.status, 503);
    assert.equal(failure.body.includes('private database'), false);
    assert.equal(calls, 4);
    assert.deepEqual(errors, ['DASHBOARD_USAGE_RETENTION_FAILED']);
    failPrune = false;

    // Exercise the exact scheduler transport, still pointed only at this fixture.
    const childResult = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/dashboard-usage-prune.mjs'], {
        env: { NODE_ENV: 'test', DASHBOARD_USAGE_CRON_SECRET: secret, DASHBOARD_USAGE_CRON_URL: endpoint },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(childResult.status, 0, childResult.stderr);
    assert.deepEqual(JSON.parse(childResult.stdout), { ok: true, deleted: 25, remaining: false, skipped: null });
    assert.equal(childResult.stderr, '');
    assert.equal(calls, 5);
    assert.ok(observations.every((item) => item.bodyPresent), 'all real Next.js POST requests have a body stream');
    console.log('PASS: old empty-POST failure reproduced; real Next adapter accepts empty POST, rejects payloads, preserves auth/errors, and scheduler CLI succeeds. Pruning was mocked throughout.');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
