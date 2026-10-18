import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as contract from '../src/shared/lib/adminContentOrder';
import { TransactionCommitUnknownError } from '../src/shared/lib/db/transactionOutcome';
import { runPostCommitTasks } from '../src/shared/lib/postCommitTasks';

const { parseAdminContentOrder, readAdminContentOrderBody, AdminContentOrderValidationError } = contract;
const ordered = [{ id: 2, sortOrder: 1 }, { id: 1, sortOrder: 2 }];

function compile<T>(filename: string, modules: Record<string, unknown>, extras: Record<string, unknown> = {}): T {
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', ...Object.keys(extras), code)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency: ${name}`);
    return modules[name];
  }, loaded, loaded.exports, ...Object.values(extras));
  return loaded.exports as T;
}

function request(body: string, headers: Record<string, string> = {}) {
  return new Request('https://example.test/api/admin/slides/reorder', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body,
  });
}

test('content order parser returns only identifiers and canonical positions without mutating input', () => {
  const input = [{ id: 1, sortOrder: 2 }, { id: 2, sortOrder: 1 }];
  assert.deepEqual(parseAdminContentOrder({ items: input }), ordered);
  assert.equal(input[0].id, 1);
  assert.deepEqual(parseAdminContentOrder({ items: [] }), []);
  assert.deepEqual(parseAdminContentOrder({ items: [{ id: Number.MAX_SAFE_INTEGER, sortOrder: 1 }] }), [{ id: Number.MAX_SAFE_INTEGER, sortOrder: 1 }]);
});

test('content order parser rejects fields that could overwrite record content', () => {
  for (const body of [
    { items: ordered, title: 'overwrite' },
    { items: [{ id: 1, sortOrder: 1, title: 'overwrite' }] },
    { items: [{ id: 1, sortOrder: 1, imageUrl: 'overwrite' }] },
    { items: [{ id: 1, sortOrder: 1, isActive: false }] },
  ]) assert.throws(() => parseAdminContentOrder(body), AdminContentOrderValidationError);
});

test('content order parser rejects malformed shapes and coercible identifier/position values', () => {
  for (const body of [null, [], true, 'text', {}, { items: null }, { items: {} }, { items: [null] }, { items: [[]] }]) {
    assert.throws(() => parseAdminContentOrder(body), AdminContentOrderValidationError);
  }
  for (const id of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', true, null, undefined, {}, []]) {
    assert.throws(() => parseAdminContentOrder({ items: [{ id, sortOrder: 1 }] }), AdminContentOrderValidationError);
  }
  for (const sortOrder of [0, -1, 1.5, 2, NaN, Infinity, '1', true, null, undefined, {}, []]) {
    assert.throws(() => parseAdminContentOrder({ items: [{ id: 1, sortOrder }] }), AdminContentOrderValidationError);
  }
});

test('content order parser rejects duplicate ids, duplicate positions and gaps', () => {
  for (const items of [
    [{ id: 1, sortOrder: 1 }, { id: 1, sortOrder: 2 }],
    [{ id: 1, sortOrder: 1 }, { id: 2, sortOrder: 1 }],
    [{ id: 1, sortOrder: 1 }, { id: 2, sortOrder: 3 }],
  ]) assert.throws(() => parseAdminContentOrder({ items }), AdminContentOrderValidationError);
});

test('content order parser accepts 10000 items but never truncates an oversized list', () => {
  const items = Array.from({ length: contract.MAX_ADMIN_CONTENT_ORDER_ITEMS }, (_, index) => ({ id: index + 1, sortOrder: index + 1 }));
  assert.equal(parseAdminContentOrder({ items }).length, 10_000);
  assert.throws(() => parseAdminContentOrder({ items: [...items, { id: 10_001, sortOrder: 10_001 }] }), (error) => {
    assert.ok(error instanceof AdminContentOrderValidationError);
    assert.equal(error.status, 413);
    return true;
  });
});

test('bounded order reader accepts JSON and refuses invalid UTF-8 or malformed JSON', async () => {
  assert.deepEqual(await readAdminContentOrderBody(request(JSON.stringify({ items: ordered }))), ordered);
  for (const body of ['{', '', 'null', '[]', '{"items":null}']) {
    await assert.rejects(readAdminContentOrderBody(request(body)), AdminContentOrderValidationError);
  }
  await assert.rejects(readAdminContentOrderBody(new Request('https://example.test', {
    method: 'PUT', body: new Uint8Array([0xff]),
  })), AdminContentOrderValidationError);
});

test('bounded order reader rejects oversized declared bodies before reading', async () => {
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({ pull() { reads += 1; } }, { highWaterMark: 0 });
  const incoming = new Request('https://example.test', {
    method: 'PUT', headers: { 'Content-Length': String(contract.MAX_ADMIN_CONTENT_ORDER_BODY_BYTES + 1) },
    body, duplex: 'half',
  } as RequestInit);
  await assert.rejects(readAdminContentOrderBody(incoming), (error) => error instanceof AdminContentOrderValidationError && error.status === 413);
  assert.equal(reads, 0);
});

test('bounded order reader caps chunked bodies without a length header and cancels the stream', async () => {
  let cancelled = false;
  let chunks = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { chunks += 1; controller.enqueue(new Uint8Array(64 * 1024)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  await assert.rejects(readAdminContentOrderBody(new Request('https://example.test', {
    method: 'PUT', body, duplex: 'half',
  } as RequestInit)), (error) => error instanceof AdminContentOrderValidationError && error.status === 413);
  assert.equal(chunks, 17);
  assert.equal(cancelled, true);
});

test('bounded order reader processes many tiny chunks with just one deadline and abort listener', async () => {
  let deadlines = 0;
  let cleaned = 0;
  const local = compile<typeof contract>('src/shared/lib/adminContentOrder.ts', {}, {
    setTimeout: () => { deadlines += 1; return 1; },
    clearTimeout: () => { cleaned += 1; },
  });
  const bytes = new TextEncoder().encode(JSON.stringify({ items: ordered }).padEnd(65_536));
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.byteLength) controller.close();
      else controller.enqueue(bytes.subarray(offset, ++offset));
    },
  }, { highWaterMark: 0 });
  assert.deepEqual(await local.readAdminContentOrderBody(new Request('https://example.test', {
    method: 'PUT', body, duplex: 'half',
  } as RequestInit)), ordered);
  assert.equal(offset, bytes.byteLength);
  assert.equal(deadlines, 1);
  assert.equal(cleaned, 1);
  assert.equal(body.locked, false);
});

test('bounded order reader releases a stalled stream after its total time limit', async () => {
  let expire: (() => void) | undefined;
  let cleared = false;
  let cancelled = false;
  const local = compile<typeof contract>('src/shared/lib/adminContentOrder.ts', {}, {
    setTimeout: (callback: () => void, delay: number) => { assert.equal(delay, 10_000); expire = callback; return 1; },
    clearTimeout: () => { cleared = true; },
  });
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise<void>(() => {}); } });
  const promise = local.readAdminContentOrderBody(new Request('https://example.test', {
    method: 'PUT', body, duplex: 'half',
  } as RequestInit));
  assert.ok(expire);
  expire();
  await assert.rejects(promise, (error) => error instanceof local.AdminContentOrderValidationError && error.status === 408);
  assert.equal(cancelled, true);
  assert.equal(cleared, true);
  assert.equal(body.locked, false);
});

test('bounded order reader handles cancellation without waiting for another network chunk', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const pending = readAdminContentOrderBody(new Request('https://example.test', {
    method: 'PUT', body, duplex: 'half', signal: controller.signal,
  } as RequestInit));
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof AdminContentOrderValidationError && error.status === 408);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

type Repository = typeof import('../src/shared/lib/db/adminContentOrderRepo');

function repository(ids: (string | number)[] = [1, 2], failUpdate = false) {
  const commands: { sql: string; values?: unknown[] }[] = [];
  const events: string[] = [];
  const transactionOptions: unknown[] = [];
  const loaded = compile<Repository>('src/shared/lib/db/adminContentOrderRepo.ts', {
    '../adminContentOrder': contract,
    './schema': { ensureSiteSchema: async () => { events.push('schema'); } },
    './client': {
      withTransaction: async (callback: (client: unknown) => Promise<unknown>, options: unknown) => {
        transactionOptions.push(options);
        events.push('begin');
        try {
          const result = await callback({ query: async (sql: string, values?: unknown[]) => {
            commands.push({ sql, values });
            if (sql.startsWith('select')) return { rows: ids.map((id) => ({ id })) };
            if (failUpdate && sql.startsWith('update')) throw new Error('Synthetic update failure');
            return { rows: [] };
          } });
          events.push('commit');
          return result;
        } catch (error) {
          events.push('rollback');
          throw error;
        }
      },
    },
  });
  return { ...loaded, commands, events, transactionOptions };
}

const resources = [
  ['slides', 'hero_slides'], ['news', 'news_items'],
  ['group-companies', 'group_companies'], ['brand-categories', 'brand_categories'],
] as const;

for (const [kind, table] of resources) {
  test(`${kind}: atomic reorder locks membership and writes only order columns once`, async () => {
    const repo = repository(['1', '2']);
    assert.deepEqual(await repo.reorderAdminContent(kind, ordered), ordered);
    assert.deepEqual(repo.events, ['schema', 'begin', 'commit']);
    assert.deepEqual(repo.transactionOptions, [{ trackCommitOutcome: true }]);
    assert.match(repo.commands[0].sql, /set local lock_timeout = '5s'/);
    assert.match(repo.commands[1].sql, /set local statement_timeout = '10s'/);
    assert.equal(repo.commands[2].sql, `lock table ${table} in share row exclusive mode`);
    assert.equal(repo.commands[3].sql, `select id from ${table} order by id limit 10001`);
    const writes = repo.commands.filter((entry) => entry.sql.startsWith('update'));
    assert.equal(writes.length, 1);
    assert.match(writes[0].sql, /set sort_order = desired.sort_order, updated_at = now\(\)/);
    assert.match(writes[0].sql, /unnest\(\$1::bigint\[\], \$2::integer\[\]\)/);
    assert.doesNotMatch(writes[0].sql, /title|image_url|is_active|link_url|\bkey\b|delete|insert/);
    assert.deepEqual(writes[0].values, [[2, 1], [1, 2]]);
  });
}

test('repository rejects stale/missing/extra collection membership before any update', async () => {
  for (const ids of [[1], [1, 2, 3], [1, 3], []]) {
    const repo = repository(ids);
    await assert.rejects(repo.reorderAdminContent('slides', ordered), repo.AdminContentOrderConflictError);
    assert.deepEqual(repo.events, ['schema', 'begin', 'rollback']);
    assert.equal(repo.commands.some((entry) => entry.sql.startsWith('update')), false);
  }
});

test('repository supports a truly empty collection without deleting anything', async () => {
  const repo = repository([]);
  assert.deepEqual(await repo.reorderAdminContent('news', []), []);
  assert.deepEqual(repo.events, ['schema', 'begin', 'commit']);
  assert.equal(repo.commands.length, 4);
});

test('repository rejects unexpected kinds and invalid payloads before schema/database access', async () => {
  const repo = repository();
  for (const kind of ['__proto__', 'toString', 'hero_slides;delete from news_items']) {
    await assert.rejects(repo.reorderAdminContent(kind as contract.AdminContentOrderKind, ordered), /Unsupported/);
  }
  await assert.rejects(repo.reorderAdminContent('slides', [{ id: 1, sortOrder: 2 }]), AdminContentOrderValidationError);
  assert.deepEqual(repo.events, []);
  assert.deepEqual(repo.commands, []);
});

test('repository throws update failures through the transaction for rollback, never a partial success', async () => {
  const repo = repository([1, 2], true);
  await assert.rejects(repo.reorderAdminContent('news', ordered), /Synthetic update failure/);
  assert.deepEqual(repo.events, ['schema', 'begin', 'rollback']);
});

function route(options: { denied?: boolean; error?: Error; cacheError?: boolean } = {}) {
  const repo = repository();
  const writes: unknown[][] = [];
  const revalidations: string[] = [];
  let authorized = false;
  const loaded = compile<typeof import('../src/shared/lib/adminContentOrderRoute')>('src/shared/lib/adminContentOrderRoute.ts', {
    'next/cache': { revalidatePath: (path: string) => { revalidations.push(path); if (options.cacheError) throw new Error('cache secret'); } },
    './adminAuth': { requireAdmin: async () => { authorized = true; return options.denied ? Response.json({ error: 'Forbidden' }, { status: 403 }) : null; } },
    './adminContentOrder': { ...contract, readAdminContentOrderBody: async (incoming: Request) => {
      assert.equal(authorized, true);
      return readAdminContentOrderBody(incoming);
    } },
    './db/adminContentOrderRepo': { ...repo, reorderAdminContent: async (...args: unknown[]) => {
      writes.push(args);
      if (options.error) throw options.error;
      return ordered;
    } },
    './db/transactionOutcome': { TransactionCommitUnknownError },
    './postCommitTasks': { runPostCommitTasks },
  });
  return { ...loaded, writes, revalidations, repo };
}

test('reorder route authorizes before parsing or querying the database', async () => {
  const api = route({ denied: true });
  const response = await api.handleAdminContentReorder(request('{'), 'slides');
  assert.equal(response.status, 403);
  assert.deepEqual(api.writes, []);
  assert.deepEqual(api.revalidations, []);
});

test('reorder route rejects invalid content without writing and reports not-saved', async () => {
  const api = route();
  const response = await api.handleAdminContentReorder(request(JSON.stringify({ items: [{ id: 1, sortOrder: 1, title: 'forbidden' }] })), 'news');
  assert.equal(response.status, 400);
  assert.equal((await response.json()).saveState, 'not_saved');
  assert.deepEqual(api.writes, []);
});

test('reorder route returns acknowledged positions and revalidates only after committed save', async () => {
  const api = route();
  const response = await api.handleAdminContentReorder(request(JSON.stringify({ items: ordered })), 'slides');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, items: ordered });
  assert.deepEqual(api.writes, [['slides', ordered]]);
  assert.deepEqual(api.revalidations, ['/']);
});

test('reorder route preserves saved success when only cache invalidation fails', async () => {
  const api = route({ cacheError: true });
  const response = await api.handleAdminContentReorder(request(JSON.stringify({ items: ordered })), 'news');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.items, ordered);
  assert.equal(body.warnings[0].code, 'CONTENT_ORDER_CACHE_REFRESH_FAILED');
  assert.doesNotMatch(JSON.stringify(body), /cache secret/);
});

test('reorder route reports membership conflicts as 409 with no cache refresh', async () => {
  const loadedRepo = repository();
  // Each compiled fixture defines its own error class; use the handler's fixture class.
  const compiled = compile<typeof import('../src/shared/lib/adminContentOrderRoute')>('src/shared/lib/adminContentOrderRoute.ts', {
    'next/cache': { revalidatePath: () => assert.fail('Must not revalidate') },
    './adminAuth': { requireAdmin: async () => null },
    './adminContentOrder': contract,
    './db/adminContentOrderRepo': { ...loadedRepo, reorderAdminContent: async () => { throw new loadedRepo.AdminContentOrderConflictError(); } },
    './db/transactionOutcome': { TransactionCommitUnknownError },
    './postCommitTasks': { runPostCommitTasks },
  });
  const response = await compiled.handleAdminContentReorder(request(JSON.stringify({ items: ordered })), 'slides');
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'CONTENT_ORDER_CONFLICT');
});

test('reorder route reports lost commit acknowledgement as unknown, with no automatic retry', async () => {
  const api = route({ error: new TransactionCommitUnknownError() });
  const response = await api.handleAdminContentReorder(request(JSON.stringify({ items: ordered })), 'slides');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).saveState, 'unknown');
  assert.equal(api.writes.length, 1);
  assert.deepEqual(api.revalidations, []);
});

test('reorder route hides raw database error details and does not acknowledge failed writes', async () => {
  const api = route({ error: new Error('password=private; sensitive SQL') });
  const response = await api.handleAdminContentReorder(request(JSON.stringify({ items: ordered })), 'slides');
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.saveState, 'not_saved');
  assert.doesNotMatch(JSON.stringify(body), /password|private|sensitive/);
  assert.equal(api.writes.length, 1);
  assert.deepEqual(api.revalidations, []);
});

for (const [kind] of resources) {
  test(`${kind}: PUT route uses the authenticated atomic handler for its own collection`, async () => {
    const calls: unknown[][] = [];
    const loaded = compile<{ PUT: (request: Request) => Promise<Response> }>(`src/app/api/admin/${kind}/reorder/route.ts`, {
      '@/shared/lib/adminContentOrderRoute': { handleAdminContentReorder: async (...args: unknown[]) => { calls.push(args); return Response.json({ ok: true }); } },
    });
    const incoming = request(JSON.stringify({ items: ordered }));
    assert.equal((await loaded.PUT(incoming)).status, 200);
    assert.deepEqual(calls, [[incoming, kind]]);
  });
}
