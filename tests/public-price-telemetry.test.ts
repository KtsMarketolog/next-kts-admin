import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

type TelemetryRepo = typeof import('../src/shared/lib/db/wholesalePriceTelemetryRepo');
type Session = { role: string; managerId?: number; adminUserId?: number } | null;
type TrackedEvent = import('../src/shared/lib/db/analyticsRepo').TrackAnalyticsEventInput;

// Execute actual repository and route control flow with only IO/auth replaced.
// Unexpected dependencies fail closed, so no application database is reachable.
function load<T>(filename: string, dependencies: Record<string, unknown>): T {
  const code = ts.transpileModule(readFileSync(new URL(filename, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const output = { exports: {} };
  new Function('require', 'module', 'exports', code)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, output, output.exports);
  return output.exports as T;
}

function repository() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let schemaChecks = 0;
  const rows = [
    { id: '13', token: 'active-token', client_name: ' Synthetic Client ', manager_id: '7', is_active: true, valid_until: '2001-01-01' },
    { id: '14', token: 'inactive-token', client_name: 'Inactive', manager_id: '7', is_active: false, valid_until: '2999-01-01' },
    { id: '15', token: 'unassigned-token', client_name: '', manager_id: null, is_active: true, valid_until: null },
  ];
  const repo = load<TelemetryRepo>('../src/shared/lib/db/wholesalePriceTelemetryRepo.ts', {
    './schema': { ensureSiteSchema: async () => { schemaChecks++; } },
    './client': { query: async (raw: string, params: unknown[]) => {
      const sql = raw.replace(/\s+/g, ' ').trim();
      calls.push({ sql, params });
      assert.match(sql, /^select id::text, token, client_name, manager_id::text from wholesale_price_lists /);
      assert.match(sql, /where token = \$1 and is_active = true limit 1$/);
      assert.doesNotMatch(sql, /\b(?:join|update|insert|delete)\b|wholesale_products|wholesale_price_list_items|valid_until/i);
      return { rows: rows.filter((row) => row.token === params[0] && row.is_active) };
    } },
  });
  return { repo, calls, schemaChecks: () => schemaChecks };
}

function handler(kind: 'event' | 'view', options: { limited?: boolean; session?: Session; reopened?: boolean } = {}) {
  const data = repository();
  const events: TrackedEvent[] = [];
  const views: unknown[][] = [];
  const rates: string[] = [];
  let priorLookups = 0;
  const failFullAssembly = () => { throw new Error('Telemetry must not assemble the price or build analogs'); };
  const modules = {
    '@/shared/lib/adminAuth': {
      getAdminSession: async () => options.session ?? null,
      isManagerSessionRole: (role?: string) => role === 'manager' || role === 'support_manager',
    },
    '@/shared/lib/db/wholesalePriceTelemetryRepo': data.repo,
    '@/shared/lib/db/analyticsRepo': { trackAnalyticsEvent: async (input: TrackedEvent) => { events.push(input); } },
    '@/shared/lib/db': {
      getPublicWholesalePriceList: failFullAssembly,
      buildPriceListAnalogLinks: failFullAssembly,
      query: async () => { priorLookups++; return { rows: [{ count: options.reopened ? '1' : '0' }] }; },
      recordWholesalePriceView: async (...args: unknown[]) => { views.push(args); },
    },
    '@/shared/lib/publicSession': {
      PUBLIC_PRICE_SESSION_COOKIE: 'test-session',
      getOrCreateSessionCookie: () => ({ sessionId: 'synthetic-session' }),
      applySessionCookie: (headers: Headers) => { headers.set('set-cookie', 'test-session=synthetic-session'); },
    },
    '@/shared/lib/rateLimit': { checkDbRateLimit: async (key: string) => {
      assert.equal(data.calls.length, 0, 'rate limiting must happen before the price lookup');
      rates.push(key);
      return { allowed: !options.limited, retryAfter: options.limited ? 12 : 0 };
    } },
  };
  const route = load<{ POST: (request: Request, context: { params: Promise<{ token: string }> }) => Promise<Response> }>(
    `../src/app/api/price/[token]/${kind}/route.ts`, modules,
  );
  return { ...data, events, views, rates, priorLookups: () => priorLookups,
    run: (request: Request, token = 'active-token') => route.POST(request, { params: Promise.resolve({ token }) }) };
}

function eventRequest(body: unknown = { eventType: 'public_price_product_opened', metadata: { productId: 123, source: 'product_card' } }) {
  return new Request('https://example.test/api/price/active-token/event', { method: 'POST', body: JSON.stringify(body) });
}

test('telemetry lookup preserves active/token eligibility and informational expiry with one small SELECT', async () => {
  const h = repository();
  assert.deepEqual(await h.repo.getPublicWholesalePriceTelemetry(' active-token '), {
    id: 13, token: 'active-token', clientName: ' Synthetic Client ', managerId: 7,
  });
  assert.deepEqual(h.calls[0].params, ['active-token']);
  assert.equal(await h.repo.getPublicWholesalePriceTelemetry('inactive-token'), null);
  assert.equal(await h.repo.getPublicWholesalePriceTelemetry('missing-token'), null);
  assert.deepEqual(await h.repo.getPublicWholesalePriceTelemetry('unassigned-token'), {
    id: 15, token: 'unassigned-token', clientName: '', managerId: null,
  });
  assert.equal(h.calls.length, 4);
});

test('invalid tokens never reach schema initialization or database access', async () => {
  const h = repository();
  for (const token of ['', ' ', 'bad/token', 'bad token', 'a'.repeat(161)]) {
    assert.equal(await h.repo.getPublicWholesalePriceTelemetry(token), null);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.schemaChecks(), 0);
});

for (const kind of ['event', 'view'] as const) {
  test(`${kind} records telemetry using identity metadata without assembling products or analogs`, async () => {
    const h = handler(kind);
    const response = await h.run(eventRequest(), ' active-token ');
    assert.equal(response.status, 200);
    assert.equal(h.calls.length, 1);
    assert.equal(h.rates.length, 2);
    assert.ok(h.rates.some((key) => key.includes(':token:active-token:session:synthetic-session')));
    assert.ok(response.headers.has('set-cookie'));
    if (kind === 'event') {
      assert.equal(h.events.length, 1);
      assert.deepEqual({ ...h.events[0], ip: undefined, userAgent: undefined, referer: undefined }, {
        eventType: 'public_price_product_opened', actorType: 'client', actorUserId: null,
        managerId: 7, clientId: 'synthetic client', priceListId: 13, token: 'active-token', sessionId: 'synthetic-session',
        ip: undefined, userAgent: undefined, referer: undefined,
        metadata: { productId: 123, productTitle: '', priceItemId: null, quantity: null, selectedItems: null, totalQuantity: null, source: 'product_card' },
      });
    } else {
      assert.equal(h.views.length, 1);
      assert.deepEqual(h.views[0].slice(0, 2), [13, 'active-token']);
      assert.equal(h.priorLookups(), 1);
    }
  });

  test(`${kind} rate-limited requests stop before price lookup, auth and analytics writes`, async () => {
    const h = handler(kind, { limited: true });
    const response = await h.run(eventRequest());
    assert.equal(response.status, kind === 'event' ? 429 : 200);
    assert.equal(h.calls.length, 0);
    assert.equal(h.priorLookups(), 0);
    assert.equal(h.events.length + h.views.length, 0);
    if (kind === 'event') assert.equal(response.headers.get('retry-after'), '12');
    else assert.deepEqual(await response.json(), { ok: true, limited: true });
  });

  test(`${kind} rejects missing/inactive/invalid prices without recording analytics`, async () => {
    for (const token of ['missing-token', 'inactive-token', 'bad/token']) {
      const h = handler(kind);
      assert.equal((await h.run(eventRequest(), token)).status, 404);
      assert.equal(h.events.length + h.views.length, 0);
      if (token === 'bad/token') assert.equal(h.rates.length + h.calls.length, 0);
    }
  });
}

test('event keeps actor attribution for both manager roles and admins', async () => {
  for (const [session, actorType, actorUserId] of [
    [{ role: 'manager', managerId: 8 }, 'manager', 8],
    [{ role: 'support_manager', managerId: 9 }, 'manager', 9],
    [{ role: 'admin', adminUserId: 10 }, 'admin', 10],
  ] as const) {
    const h = handler('event', { session });
    assert.equal((await h.run(eventRequest())).status, 200);
    assert.equal(h.events[0].actorType, actorType);
    assert.equal(h.events[0].actorUserId, actorUserId);
  }
});

test('view preserves reopened state and manager identity', async () => {
  const h = handler('view', { reopened: true, session: { role: 'support_manager', managerId: 9 } });
  assert.equal((await h.run(eventRequest())).status, 200);
  const input = h.views[0][2] as Record<string, unknown>;
  assert.equal(input.reopened, true);
  assert.equal(input.actorType, 'manager');
  assert.equal(input.actorUserId, 9);
  assert.equal(input.clientName, ' Synthetic Client ');
});

test('event rejects unsupported or malformed bodies before loading a price', async () => {
  for (const body of ['{', JSON.stringify({ eventType: 'price_deleted' }), 'null']) {
    const h = handler('event');
    const response = await h.run(new Request('https://example.test/event', { method: 'POST', body }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'INVALID_EVENT' });
    assert.equal(h.calls.length + h.events.length, 0);
  }
});

test('event bounds the actual body even when Content-Length is missing or understates its size', async () => {
  const headerVariants: HeadersInit[] = [{}, { 'content-length': '2' }, { 'content-length': '16385' }];
  for (const headers of headerVariants) {
    const h = handler('event');
    const response = await h.run(new Request('https://example.test/event', {
      method: 'POST', headers, body: JSON.stringify({ eventType: 'public_price_product_opened', metadata: { source: 'x'.repeat(16384) } }),
    }));
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { ok: false, error: 'BODY_TOO_LARGE' });
    assert.equal(h.calls.length + h.events.length, 0);
  }
});
