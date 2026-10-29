import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import ts from 'typescript';

import type { AdminSession } from '../src/shared/lib/adminAuth';
import * as permissions from '../src/shared/lib/dashboardPermissions';
import * as instructions from '../src/shared/lib/dashboardInstructions';
import { dashboardInstructionDownload } from '../src/shared/lib/dashboardInstructionDownload';
import * as profile from '../src/shared/lib/dashboardInstructionProfile';

const baseUrl = 'https://example.test/api/admin/dashboard-instructions';
const salesHtml = '<!doctype html><script>const DASH_NAME = "аналитика_продаж";</script>';
const profitabilityHtml = '<!doctype html><title>Рентабельность сделок V25</title><script>const format = "kts-rent-snapshot"; function parseInvoiceFile(file) { return file; }</script>';
const pdfBytes = Buffer.from('%PDF-1.7\nSynthetic instruction, never personal data.\n%%EOF');
const videoBytes = Buffer.from('\0\0\0\x18ftypmp42Synthetic video, never personal data.');
type InstructionFormat = 'pdf' | 'video';
const formats: InstructionFormat[] = ['pdf', 'video'];
const persisted = (role: AdminSession['role'], dashboardAccess: string[] = []): AdminSession => ({
  role, sessionId: 'synthetic-session', dashboardAccess,
  ...(role === 'manager' || role === 'support_manager' ? { managerId: 71 } : { adminUserId: 31 }),
});
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function safeHeaders(response: Response) {
  for (const [name, value] of Object.entries(instructions.DASHBOARD_INSTRUCTION_HEADERS)) {
    assert.equal(response.headers.get(name), value, name);
  }
}
type RouteContext = { params: Promise<{ kind: string }> };
type Handler = (request: Request, context: RouteContext) => Promise<Response>;

// The actual route, real permission predicates and real profile detection run
// against synthetic sessions and inert IO. Unexpected imports fail closed: no
// owner snapshot, recipient, filesystem or personal repository can be loaded.
function route(initialSession: AdminSession | null, options: { html?: string | null; failure?: 'auth' | 'profile' | 'file' } = {}) {
  let session = initialSession;
  const calls: string[] = [];
  const modules: Record<string, unknown> = {
    '@/shared/lib/adminAuth': { async getAdminSession() {
      calls.push('auth');
      if (options.failure === 'auth') throw new Error('Synthetic private session detail');
      return session;
    } },
    '@/shared/lib/dashboardPermissions': permissions,
    '@/shared/lib/dashboardInstructions': instructions,
    '@/shared/lib/dashboardInstructionProfile': profile,
    '@/shared/lib/db/topDashboardBlocksRepo': { async getActiveTopDashboardBlockHtmlContent(blockId: number) {
      calls.push(`active-html:${blockId}`);
      if (options.failure === 'profile') throw new Error('Synthetic private database detail');
      return options.html === undefined ? salesHtml : options.html;
    } },
    '@/shared/lib/dashboardInstructionDownload': { async dashboardInstructionDownload(request: Request, kind: string, download: boolean, format: InstructionFormat = 'pdf') {
      calls.push(`file:${kind}:${format}:${download ? 'attachment' : 'inline'}`);
      if (options.failure === 'file') throw new Error('Synthetic private filesystem path');
      return new Response(request.method === 'HEAD' ? null : format === 'video' ? videoBytes : pdfBytes, { headers: {
        ...instructions.DASHBOARD_INSTRUCTION_HEADERS, 'Content-Type': format === 'video' ? 'video/mp4' : 'application/pdf',
      } });
    } },
  };
  const code = ts.transpileModule(readFileSync(new URL('../src/app/api/admin/dashboard-instructions/[kind]/route.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const testModule = { exports: {} as { GET: Handler; HEAD: Handler } };
  new Function('require', 'module', 'exports', 'console', code)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`);
    return modules[name];
  }, testModule, testModule.exports, { error() {} });
  return {
    calls, setSession(next: AdminSession | null) { session = next; },
    async request(kind = 'personal-sales', query = 'dashboardKey=manager%3Adevelopment', method: 'GET' | 'HEAD' = 'GET') {
      const request = new Request(`${baseUrl}/${encodeURIComponent(kind)}?${query}`, { method });
      const response = await testModule.exports[method](request, { params: Promise.resolve({ kind }) });
      safeHeaders(response);
      return response;
    },
  };
}

test('instruction descriptors bind only static manuals to their permitted report families', () => {
  for (const key of ['manager:development', 'manager:support']) {
    assert.equal(instructions.resolveDashboardInstruction('personal-sales', key), instructions.DASHBOARD_INSTRUCTIONS['personal-sales']);
    assert.equal(instructions.resolveDashboardInstruction('sales-analytics', key), null);
    assert.equal(instructions.resolveDashboardInstruction('deal-profitability', key), null);
  }
  assert.equal(instructions.resolveDashboardInstruction('sales-analytics', 'top:7'), instructions.DASHBOARD_INSTRUCTIONS['sales-analytics']);
  assert.equal(instructions.resolveDashboardInstruction('deal-profitability', 'top:10'), instructions.DASHBOARD_INSTRUCTIONS['deal-profitability']);
  for (const kind of ['personal-sales', 'sales-analytics', 'deal-profitability', 'unknown', '__proto__', '../../private.pdf']) {
    for (const key of ['currency-rates', 'route-planner', 'top:*', 'top:0', 'top:01', 'top:1e2', 'top:9007199254740992', '../top:7']) {
      assert.equal(instructions.resolveDashboardInstruction(kind, key), null, `${kind} ${key}`);
    }
  }
});

test('personal PDF and video use the same real role, identity and audience rights before all storage IO', async () => {
  const cases: Array<[string, AdminSession | null, boolean, boolean]> = [
    ['anonymous', null, false, false],
    ['MR', persisted('manager', ['manager:development']), true, false],
    ['MS', persisted('support_manager', ['manager:support']), false, true],
    ['MR forged opposite audience', persisted('manager', ['manager:support']), false, false],
    ['MS forged opposite audience', persisted('support_manager', ['manager:development']), false, false],
    ['revoked MR grant', persisted('manager'), false, false],
    ['TOP inherited review', persisted('top'), true, false],
    ['TOP forged MS grant', persisted('top', ['manager:support']), true, false],
    ['admin', { role: 'admin', sessionId: 'environment-admin' }, true, true],
    ['admintop', persisted('admintop'), true, true],
    ['purchaser forged personal grants', persisted('purchaser', ['manager:development', 'manager:support']), false, false],
    ['wholesale admin forged personal grants', persisted('wholesale_admin', ['manager:development', 'manager:support']), false, false],
    ['legacy admin', { role: 'admin' }, false, false],
    ['legacy MR', { role: 'manager', managerId: 71, dashboardAccess: ['manager:development'] }, false, false],
    ['missing TOP identity', { role: 'top', sessionId: 'legacy' }, false, false],
    ['invalid manager identity', { ...persisted('manager', ['manager:development']), managerId: 0 }, false, false],
  ];
  for (const [label, session, development, support] of cases) {
    for (const [audience, allowed] of [['development', development], ['support', support]] as const) {
      for (const format of formats) {
        const api = route(session);
        const response = await api.request('personal-sales', `dashboardKey=manager%3A${audience}&format=${format}`);
        assert.equal(response.status, allowed ? 200 : session ? 403 : 401, `${label}: ${audience} ${format}`);
        assert.deepEqual(api.calls, allowed ? ['auth', `file:personal-sales:${format}:inline`] : ['auth']);
        if (allowed) assert.deepEqual(Buffer.from(await response.arrayBuffer()), format === 'video' ? videoBytes : pdfBytes);
      }
    }
  }
});

test('Sales PDF and video require the exact block grant and currently active Sales profile', async () => {
  for (const format of formats) {
    for (const role of ['manager', 'support_manager', 'top', 'purchaser', 'wholesale_admin'] as const) {
      for (const assigned of [false, true]) {
        const api = route(persisted(role, [assigned ? 'top:7' : 'top:8']));
        assert.equal((await api.request('sales-analytics', `dashboardKey=top%3A7&format=${format}`)).status, assigned ? 200 : 403, `${role} ${assigned} ${format}`);
        assert.deepEqual(api.calls, assigned ? ['auth', 'active-html:7', `file:sales-analytics:${format}:inline`] : ['auth']);
      }
    }
    for (const session of [persisted('admin'), persisted('admintop'), { ...persisted('top'), canManageTopDashboard: true }]) {
      const api = route(session);
      assert.equal((await api.request('sales-analytics', `dashboardKey=top%3A7&format=${format}`)).status, 200);
    }
    for (const html of [null, '<title>Аналитика продаж</title>', '<script>const DASH_NAME="оптимизация_ассортимента";</script>']) {
      const api = route(persisted('purchaser', ['top:7']), { html });
      assert.equal((await api.request('sales-analytics', `dashboardKey=top%3A7&format=${format}`)).status, 404);
      assert.deepEqual(api.calls, ['auth', 'active-html:7'], 'no manual read for missing, renamed or non-Sales published profile');
    }
  }
});

test('profitability PDF/video require the exact report grant for GET and HEAD before all content IO', async () => {
  for (const format of formats) for (const method of ['GET', 'HEAD'] as const) {
    for (const role of ['manager', 'support_manager', 'top', 'purchaser', 'wholesale_admin'] as const) {
      for (const assigned of [false, true]) {
        const api = route(persisted(role, [assigned ? 'top:10' : 'top:7']), { html: profitabilityHtml });
        const response = await api.request('deal-profitability', `dashboardKey=top%3A10&format=${format}`, method);
        assert.equal(response.status, assigned ? 200 : 403, `${role} ${assigned} ${format} ${method}`);
        assert.deepEqual(api.calls, assigned ? ['auth', 'active-html:10', `file:deal-profitability:${format}:inline`] : ['auth']);
        if (method === 'HEAD') assert.equal(await response.text(), '');
      }
    }
    for (const session of [persisted('admin'), persisted('admintop'), { ...persisted('top'), canManageTopDashboard: true }]) {
      const api = route(session, { html: profitabilityHtml });
      assert.equal((await api.request('deal-profitability', `dashboardKey=top%3A10&format=${format}`, method)).status, 200);
    }
    for (const [session, status] of [[null, 401], [{ role: 'admin' }, 403], [{ ...persisted('manager', ['top:10']), managerId: 0 }, 403]] as const) {
      const api = route(session, { html: profitabilityHtml });
      assert.equal((await api.request('deal-profitability', `dashboardKey=top%3A10&format=${format}`, method)).status, status);
      assert.deepEqual(api.calls, ['auth']);
    }
  }
});

test('TOP manuals reject missing, title-only, cross-family and ambiguous active HTML for both formats', async () => {
  for (const kind of ['sales-analytics', 'deal-profitability']) for (const format of formats) for (const method of ['GET', 'HEAD'] as const) {
    for (const html of [null, '<title>Рентабельность сделок. Аналитика продаж</title>',
      '<script>const DASH_NAME="оптимизация_ассортимента";</script>',
      kind === 'sales-analytics' ? profitabilityHtml : salesHtml, salesHtml + profitabilityHtml]) {
      const api = route(persisted('purchaser', ['top:10']), { html });
      const response = await api.request(kind, `dashboardKey=top%3A10&format=${format}`, method);
      assert.equal(response.status, 404, `${kind} ${format} ${method}`);
      assert.deepEqual(api.calls, ['auth', 'active-html:10']);
      if (method === 'HEAD') assert.equal(await response.text(), '');
    }
  }
});

test('profitability access and active HTML are rechecked after publication changes or grant revocation', async () => {
  for (const format of formats) {
    const fixture = { html: profitabilityHtml };
    const api = route(persisted('support_manager', ['top:10']), fixture);
    const query = `dashboardKey=top%3A10&format=${format}`;
    assert.equal((await api.request('deal-profitability', query)).status, 200);
    fixture.html = salesHtml;
    api.calls.length = 0;
    assert.equal((await api.request('deal-profitability', query, 'HEAD')).status, 404);
    assert.deepEqual(api.calls, ['auth', 'active-html:10']);
    fixture.html = profitabilityHtml;
    api.setSession(persisted('support_manager'));
    api.calls.length = 0;
    assert.equal((await api.request('deal-profitability', query)).status, 403);
    assert.deepEqual(api.calls, ['auth']);
  }
});

test('omitted format preserves PDF URLs and explicit PDF/video reach only the matching stream descriptor', async () => {
  for (const [query, format] of [['', 'pdf'], ['&format=pdf', 'pdf'], ['&format=video', 'video']] as const) {
    for (const attachment of [false, true]) {
      const api = route(persisted('manager', ['manager:development']));
      const response = await api.request('personal-sales', `dashboardKey=manager%3Adevelopment${query}${attachment ? '&download=1' : ''}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), format === 'pdf' ? 'application/pdf' : 'video/mp4');
      assert.deepEqual(api.calls, ['auth', `file:personal-sales:${format}:${attachment ? 'attachment' : 'inline'}`]);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), format === 'pdf' ? pdfBytes : videoBytes);
    }
  }
});

test('each GET and HEAD rechecks current session grants, without caching a successful authorization', async () => {
  for (const format of formats) {
    const api = route(persisted('manager', ['manager:development']));
    const query = `dashboardKey=manager%3Adevelopment&format=${format}`;
    assert.equal((await api.request('personal-sales', query)).status, 200);
    api.calls.length = 0;
    api.setSession(persisted('manager'));
    assert.equal((await api.request('personal-sales', query)).status, 403);
    assert.deepEqual(api.calls, ['auth']);
    api.calls.length = 0;
    api.setSession(null);
    const response = await api.request('personal-sales', query, 'HEAD');
    assert.equal(response.status, 401);
    assert.equal(await response.text(), '');
    assert.deepEqual(api.calls, ['auth']);
  }
});

test('bad kind/key pairs, duplicates, unknown fields and traversal fail before all manual/profile IO', async () => {
  const cases: Array<[string, string, number]> = [
    ['unknown', 'dashboardKey=manager%3Adevelopment', 404],
    ['../../private.pdf', 'dashboardKey=manager%3Adevelopment', 404],
    ['__proto__', 'dashboardKey=manager%3Adevelopment', 404],
    ['personal-sales', 'dashboardKey=top%3A7', 404],
    ['sales-analytics', 'dashboardKey=manager%3Asupport', 404],
    ['deal-profitability', 'dashboardKey=manager%3Asupport', 404],
    ['deal-profitability', 'dashboardKey=top%3A010', 404],
    ['personal-sales', '', 400],
    ['personal-sales', 'dashboardKey=', 404],
    ['sales-analytics', 'dashboardKey=top%3A01', 404],
    ['personal-sales', 'dashboardKey=..%2F..%2Fprivate.pdf', 404],
    ['personal-sales', 'dashboardKey=manager%3Adevelopment&dashboardKey=manager%3Asupport', 400],
    ['personal-sales', 'dashboardKey=manager%3Adevelopment&download=1&download=1', 400],
    ['personal-sales', 'dashboardKey=manager%3Adevelopment&download=0', 400],
    ['personal-sales', 'dashboardKey=manager%3Adevelopment&download=', 400],
    ...['managerId', 'snapshotId', 'versionId', 'filename', 'path'].map((name): [string, string, number] =>
      ['personal-sales', `dashboardKey=manager%3Adevelopment&${name}=123`, 400]),
  ];
  for (const [kind, query, status] of cases) {
    for (const method of ['GET', 'HEAD'] as const) {
      for (const format of formats) {
        const api = route(persisted('admin'));
        const response = await api.request(kind, `${query}&format=${format}`, method);
        assert.equal(response.status, status, `${method} ${kind} ${query} ${format}`);
        assert.deepEqual(api.calls, ['auth']);
        if (method === 'HEAD') assert.equal(await response.text(), '');
      }
    }
  }
});

test('invalid, repeated and traversal format values are rejected before profile or filesystem IO', async () => {
  for (const suffix of ['format=', 'format=mp4', 'format=VIDEO', 'format=unknown', 'format=video%20',
    'format=..%2F..%2Fprivate.mp4', 'format=pdf&format=video', 'format=video&format=video', 'format=pdf&format=pdf']) {
    for (const method of ['GET', 'HEAD'] as const) {
      const api = route(persisted('admin'));
      const response = await api.request('sales-analytics', `dashboardKey=top%3A7&${suffix}`, method);
      assert.equal(response.status, 400, `${method} ${suffix}`);
      assert.deepEqual(api.calls, ['auth']);
      if (method === 'HEAD') assert.equal(await response.text(), '');
    }
  }
});

test('authorized HEAD preserves access/profile checks and download flag without a response body', async () => {
  for (const format of formats) {
    const api = route(persisted('purchaser', ['top:7']));
    const response = await api.request('sales-analytics', `dashboardKey=top%3A7&download=1&format=${format}`, 'HEAD');
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
    assert.deepEqual(api.calls, ['auth', 'active-html:7', `file:sales-analytics:${format}:attachment`]);
    const denied = route(persisted('manager', ['manager:development']));
    assert.equal((await denied.request('personal-sales', `dashboardKey=manager%3Asupport&format=${format}`, 'HEAD')).status, 403);
    assert.deepEqual(denied.calls, ['auth']);
  }
});

test('auth, profile and file failures return private generic errors, including empty HEAD errors', async () => {
  for (const format of formats) {
    for (const failure of ['auth', 'profile', 'file'] as const) {
      for (const method of ['GET', 'HEAD'] as const) {
        const api = route(persisted('admin'), { failure });
        const response = await api.request('sales-analytics', `dashboardKey=top%3A7&format=${format}`, method);
        assert.equal(response.status, 500);
        const body = await response.text();
        assert.doesNotMatch(body, /Synthetic|private|filesystem|session detail/);
        if (method === 'HEAD') assert.equal(body, '');
      }
    }
  }
});

const originals = {
  'personal-sales': '30391904310a5962e4d3336e704c9d45781f01d55de1ff7a9c0f614afdd51269',
  'sales-analytics': 'bef931d0b3f37eac436265ba0cd9d2b667df57f46b79f85a1d4b8943f89260e5',
  'deal-profitability': '2ce4a01ccb3ce4df0f5231ee7c47b830a4026da6911ba8fcab2f5890780947cf',
} as const;
const videoOriginals = {
  'personal-sales': '594c406eb321b5a0bfb76c50c76b9f8e690312a2695310dd796565f5cedcc7fa',
  'sales-analytics': '8011e72362892465e95e545c0d0083fb6fcc440684eb9fa1e9e4114e15fdaed6',
  'deal-profitability': '1312225b412fb6c207ba46cb3ac432d20b73898465c8127a970357617de49691',
} as const;
const asset = (kind: instructions.DashboardInstructionKind, format: InstructionFormat = 'pdf') => {
  const instruction = instructions.DASHBOARD_INSTRUCTIONS[kind];
  return readFileSync(new URL(`../assets/dashboard-instructions/${format === 'video' ? instruction.video.filename : instruction.filename}`, import.meta.url));
};
const downloadRequest = (init: RequestInit = {}) => new Request(`${baseUrl}/personal-sales?dashboardKey=manager%3Adevelopment`, init);

test('all bundled original PDFs stream byte-identically with fixed safe inline/attachment names', async () => {
  for (const kind of Object.keys(originals) as instructions.DashboardInstructionKind[]) {
    const source = asset(kind);
    assert.equal(source.subarray(0, 5).toString(), '%PDF-');
    assert.equal(sha256(source), originals[kind]);
    for (const attachment of [false, true]) {
      const response = await dashboardInstructionDownload(downloadRequest(), kind, attachment);
      assert.equal(response.status, 200);
      safeHeaders(response);
      assert.equal(response.headers.get('Content-Type'), 'application/pdf');
      assert.equal(response.headers.get('Content-Length'), String(source.length));
      assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
      assert.equal(response.headers.get('Content-Disposition'), `${attachment ? 'attachment' : 'inline'}; filename="${instructions.DASHBOARD_INSTRUCTIONS[kind].filename}"; filename*=UTF-8''${encodeURIComponent(instructions.DASHBOARD_INSTRUCTIONS[kind].downloadName)}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(sha256(bytes), originals[kind]);
      assert.deepEqual(bytes, source);
    }
  }
});

test('all bundled original MP4s stream byte-identically with video MIME and safe inline/attachment names', async () => {
  for (const kind of Object.keys(videoOriginals) as instructions.DashboardInstructionKind[]) {
    const source = asset(kind, 'video');
    const descriptor = instructions.DASHBOARD_INSTRUCTIONS[kind].video;
    assert.equal(source.subarray(4, 8).toString(), 'ftyp');
    assert.equal(sha256(source), videoOriginals[kind]);
    assert.equal(descriptor.filename, `${kind}-${instructions.DASHBOARD_INSTRUCTIONS[kind].version}.mp4`);
    for (const attachment of [false, true]) {
      const response = await dashboardInstructionDownload(downloadRequest(), kind, attachment, 'video');
      assert.equal(response.status, 200);
      safeHeaders(response);
      assert.equal(response.headers.get('Content-Type'), 'video/mp4');
      assert.equal(response.headers.get('Content-Length'), String(source.length));
      assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
      assert.equal(response.headers.get('Content-Disposition'), `${attachment ? 'attachment' : 'inline'}; filename="${descriptor.filename}"; filename*=UTF-8''${encodeURIComponent(descriptor.downloadName)}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(sha256(bytes), videoOriginals[kind]);
      assert.deepEqual(bytes, source);
    }
  }
});

test('MP4 initial probing and seeks return exact bounded ranges for all videos', async () => {
  for (const kind of Object.keys(videoOriginals) as instructions.DashboardInstructionKind[]) {
    const bytes = asset(kind, 'video');
    const seek = Math.floor(bytes.length / 2);
    for (const [range, start, end] of [
      ['bytes=0-1', 0, 1], ['bytes=0-4095', 0, 4095],
      [`bytes=${seek}-${seek + 8191}`, seek, seek + 8191],
      [`bytes=${bytes.length - 4096}-`, bytes.length - 4096, bytes.length - 1],
      ['bytes=-4096', bytes.length - 4096, bytes.length - 1],
      [`bytes=${bytes.length - 2}-${bytes.length + 100}`, bytes.length - 2, bytes.length - 1],
    ] as const) {
      const response = await dashboardInstructionDownload(downloadRequest({ headers: { range } }), kind, false, 'video');
      assert.equal(response.status, 206, `${kind} ${range}`);
      safeHeaders(response);
      assert.equal(response.headers.get('Content-Type'), 'video/mp4');
      assert.equal(response.headers.get('Content-Range'), `bytes ${start}-${end}/${bytes.length}`);
      assert.equal(response.headers.get('Content-Length'), String(end - start + 1));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
    }
    const head = await dashboardInstructionDownload(downloadRequest({ method: 'HEAD', headers: { range: 'bytes=0-1' } }), kind, false, 'video');
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('Content-Type'), 'video/mp4');
    assert.equal(head.headers.get('Content-Length'), String(bytes.length));
    assert.equal(head.headers.get('Content-Range'), null);
    assert.equal(await head.text(), '');
    const fallback = await dashboardInstructionDownload(downloadRequest({ headers: { range: 'bytes=0-1', 'if-range': '"old"' } }), kind, false, 'video');
    assert.equal(fallback.status, 200);
    assert.equal(fallback.headers.get('Content-Range'), null);
    assert.equal(sha256(Buffer.from(await fallback.arrayBuffer())), videoOriginals[kind]);
  }
});

test('PDF ranges support fixed, clamped, open and suffix byte boundaries and If-Range falls back to full content', async () => {
  const bytes = asset('personal-sales');
  for (const [range, start, end] of [
    ['bytes=0-0', 0, 0], ['bytes=2-15', 2, 15],
    [`bytes=${bytes.length - 12}-`, bytes.length - 12, bytes.length - 1],
    ['bytes=-12', bytes.length - 12, bytes.length - 1],
    [`bytes=${bytes.length - 12}-${bytes.length + 100}`, bytes.length - 12, bytes.length - 1],
    [`bytes=-${bytes.length + 1}`, 0, bytes.length - 1],
  ] as const) {
    const response = await dashboardInstructionDownload(downloadRequest({ headers: { range } }), 'personal-sales', false);
    assert.equal(response.status, 206, range);
    safeHeaders(response);
    assert.equal(response.headers.get('Content-Range'), `bytes ${start}-${end}/${bytes.length}`);
    assert.equal(response.headers.get('Content-Length'), String(end - start + 1));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end + 1));
  }
  const response = await dashboardInstructionDownload(downloadRequest({ headers: { range: 'bytes=0-3', 'if-range': '"stale"' } }), 'personal-sales', false);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Range'), null);
  assert.equal(sha256(Buffer.from(await response.arrayBuffer())), originals['personal-sales']);
});

// Instrument real read-only file descriptors while executing the helper's real
// source, so cancellation/HEAD/error tests can prove handle closure without
// writing fixtures or relying on process-wide descriptor-count timing.
function trackedDownload(format: InstructionFormat = 'pdf') {
  let lastHandle: Awaited<ReturnType<typeof open>>;
  let closed: Promise<void> = Promise.resolve();
  const exports: { dashboardInstructionDownload?: typeof dashboardInstructionDownload } = {};
  const modules: Record<string, unknown> = {
    'node:path': { default: path }, 'node:stream': { Readable }, './dashboardInstructions': instructions,
    'node:fs/promises': { async open(filename: string, flags: string) {
      assert.equal(flags, 'r');
      assert.equal(filename, path.join(process.cwd(), 'assets', 'dashboard-instructions', `personal-sales-v34.${format === 'video' ? 'mp4' : 'pdf'}`));
      lastHandle = await open(filename, flags);
      // Node FileHandle emits close; @types/node 20 leaves its EventEmitter base as a TODO.
      closed = new Promise<void>((resolve) => { (lastHandle as typeof lastHandle & EventEmitter).once('close', resolve); });
      return lastHandle;
    } },
  };
  const code = ts.transpileModule(readFileSync(new URL('../src/shared/lib/dashboardInstructionDownload.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'exports', code)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`); return modules[name];
  }, exports);
  return {
    get: (init: RequestInit = {}) => exports.dashboardInstructionDownload!(downloadRequest(init), 'personal-sales', false, format),
    async assertClosed() { await closed; assert.equal(lastHandle.fd, -1); },
  };
}

test('PDF/video HEAD describes the full file even with Range, and all invalid ranges close descriptors', { timeout: 5_000 }, async () => {
  for (const format of formats) {
    const helper = trackedDownload(format);
    const bytes = asset('personal-sales', format);
    const head = await helper.get({ method: 'HEAD', headers: { range: 'bytes=0-3' } });
    assert.equal(head.status, 200);
    safeHeaders(head);
    assert.equal(await head.text(), '');
    assert.equal(head.headers.get('Content-Length'), String(bytes.length));
    assert.equal(head.headers.get('Content-Range'), null);
    await helper.assertClosed();
    for (const range of ['bytes=-0', 'bytes=-', 'bytes=8-2', `bytes=${bytes.length}-`, 'bytes=0-1,5-6', 'bytes=9007199254740992-', 'bytes=0-9007199254740992', 'items=0-1']) {
      const response = await helper.get({ headers: { range } });
      assert.equal(response.status, 416, range);
      safeHeaders(response);
      assert.equal(response.headers.get('Content-Range'), `bytes */${bytes.length}`);
      assert.equal(await response.text(), '');
      await helper.assertClosed();
    }
  }
});

test('pre-aborted, interrupted and consumer-cancelled downloads close their read-only file handles', { timeout: 5_000 }, async () => {
  for (const format of formats) {
    const helper = trackedDownload(format);
    const before = new AbortController();
    before.abort();
    await assert.rejects(helper.get({ signal: before.signal }), /Download cancelled/);
    await helper.assertClosed();

    const during = new AbortController();
    const response = await helper.get({ signal: during.signal });
    const body = response.arrayBuffer();
    during.abort();
    await assert.rejects(body, /Download cancelled/);
    await helper.assertClosed();

    const cancelled = await helper.get();
    await cancelled.body!.cancel('Reader closed manual');
    await helper.assertClosed();
  }
});
