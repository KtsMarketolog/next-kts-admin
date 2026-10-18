import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

type Route = {
  POST: (request: Request, context: { params: Promise<{ token: string }> }) => Promise<Response>;
};
type Item = {
  id: number; productTitle: string; model: string; sku: string; variantTitle: string;
  priceEur: string | null; priceRub: string | null; priceCny: string | null; wholesalePrice: string | null;
};

const fixtureItems: Item[] = [
  { id: 11, productTitle: 'Компрессор <A>', model: 'Model A', sku: 'SKU-A', variantTitle: 'Большой',
    priceEur: '10,25', priceRub: '900', priceCny: '2', wholesalePrice: '99999' },
  { id: 12, productTitle: 'Клапан', model: '', sku: 'SKU-B', variantTitle: 'Малый',
    priceEur: null, priceRub: null, priceCny: null, wholesalePrice: '1 250,5' },
  { id: 13, productTitle: 'Труба', model: 'Model C', sku: 'SKU-C', variantTitle: 'Средний',
    priceEur: '0', priceRub: null, priceCny: '6,3', wholesalePrice: null },
];

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function harness(options: {
  denied?: 'session' | 'global'; missing?: boolean; items?: Item[];
  mailFailure?: boolean; historyFailure?: boolean; analyticsFailure?: boolean;
} = {}) {
  const order: string[] = [];
  const itemCalls: Array<{ token: string; ids: number[] }> = [];
  const rates: Array<{ key: string; limit: number; window: number }> = [];
  const mails: Array<Record<string, string>> = [];
  const histories: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const measured: string[] = [];
  const statuses: number[] = [];
  const errors: unknown[][] = [];
  const metadata = {
    id: 18, token: 'active-price', title: 'Согласованный прайс', clientName: 'Тестовый клиент',
    clientCompanyId: 31, managerId: 7, supportManagerId: 8,
    managerEmail: 'manager@example.test', supportManagerEmail: 'support@example.test',
    validUntil: '2001-01-01',
  };
  const forbidden = () => { throw new Error('Full price assembly and analog matching are forbidden in request processing'); };
  const dependencies: Record<string, unknown> = {
    nodemailer: { createTransport: () => ({ sendMail: async (mail: Record<string, string>) => {
      order.push('mail');
      if (options.mailFailure) throw new Error('Synthetic mail failure');
      mails.push(plain(mail));
    } }) },
    '@/shared/lib/db': {
      getPublicWholesalePriceList: forbidden,
      buildPriceListAnalogLinks: forbidden,
      getPublicWholesalePriceListMetadata: async (token: string) => {
        order.push(`access:${token}`);
        return options.missing ? null : metadata;
      },
      getPublicWholesaleRequestItems: async (token: string, ids: number[]) => {
        order.push('items');
        itemCalls.push({ token, ids: plain(ids) });
        return [...(options.items ?? fixtureItems)].filter((item) => ids.includes(item.id)).reverse();
      },
      createClientPriceRequest: async (input: Record<string, unknown>) => {
        order.push('history');
        if (options.historyFailure) throw new Error('Synthetic history failure');
        histories.push(plain(input));
      },
      trackAnalyticsEvent: async (input: Record<string, unknown>) => {
        order.push('analytics');
        if (options.analyticsFailure) throw new Error('Synthetic analytics failure');
        events.push(plain(input));
      },
    },
    '@/shared/lib/publicSession': {
      PUBLIC_PRICE_SESSION_COOKIE: 'test-session',
      getOrCreateSessionCookie: () => ({ sessionId: 'synthetic-session' }),
      applySessionCookie: (headers: Headers) => headers.set('Set-Cookie', 'test-session=synthetic-session'),
    },
    '@/shared/lib/rateLimit': { checkDbRateLimit: async (key: string, limit: number, window: number) => {
      order.push(key.endsWith(':global') ? 'global' : 'session');
      rates.push({ key, limit, window });
      const denied = options.denied === (key.endsWith(':global') ? 'global' : 'session');
      return { allowed: !denied, retryAfter: denied ? 42 : 0 };
    } },
    '@/shared/lib/pricePerformance': { createPricePerformanceTrace: (operation: string) => {
      assert.equal(operation, 'request');
      return {
        measure: async <T>(stage: string, work: () => Promise<T>) => { measured.push(stage); return work(); },
        measureSync: <T>(stage: string, work: () => T) => { measured.push(stage); return work(); },
        finish: (status: number) => statuses.push(status),
        header: () => 'total;dur=1',
      };
    } },
  };
  const output = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL('../src/app/api/price/[token]/request/route.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, {
    module: output, exports: output.exports, Response, URL, Buffer,
    process: { env: { SMTP_USER: 'synthetic@example.test', SMTP_PASSWORD: 'synthetic-no-real-secret',
      SMTP_TO: 'notify@example.test;MANAGER@example.test', SMTP_HOST: 'smtp.invalid' } },
    console: { error: (...args: unknown[]) => errors.push(args) },
    require: (name: string) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}; no external IO is permitted`);
      return dependencies[name];
    },
  });
  const route = output.exports as Route;
  return { metadata, order, itemCalls, rates, mails, histories, events, measured, statuses, errors,
    run: (body: unknown = { items: [{ id: 11, quantity: 2 }] }, headers: HeadersInit = {}, raw = false) => route.POST(
      new Request('https://example.test/api/price/active-price/request', {
        method: 'POST', headers: { 'user-agent': 'Synthetic test', referer: 'https://example.test/price/active-price', ...headers },
        body: raw ? String(body) : JSON.stringify(body),
      }), { params: Promise.resolve({ token: 'active-price' }) },
    ),
  };
}

test('price request checks active access before limits and never builds the full price', async () => {
  const h = harness({ missing: true });
  const response = await h.run();
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, error: 'NOT_FOUND' });
  assert.deepEqual(h.order, ['access:active-price']);
  assert.equal(h.itemCalls.length + h.rates.length + h.mails.length, 0);
  assert.deepEqual(h.statuses, [404]);
  assert.equal(response.headers.get('server-timing'), 'total;dur=1');
});

for (const denied of ['session', 'global'] as const) {
  test(`price request denied by ${denied} limit performs no item lookup, pricing or delivery`, async () => {
    const h = harness({ denied });
    const response = await h.run();
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '42');
    assert.ok(response.headers.has('set-cookie'));
    assert.deepEqual(h.order, ['access:active-price', 'session', ...(denied === 'global' ? ['global'] : [])]);
    assert.equal(h.itemCalls.length + h.histories.length + h.events.length + h.mails.length, 0);
    assert.ok(!h.measured.includes('body'));
    assert.ok(!h.measured.includes('pricing'));
  });
}

test('invalid request bodies do not load any catalogue items or send mail', async () => {
  const invalid: unknown[] = [null, {}, { items: [] }, { items: [{ id: 11, quantity: 0 }] },
    { items: [{ id: 11, quantity: 1000 }] }, { items: [{ id: 11, quantity: 1.5 }] },
    { items: [{ id: -11, quantity: 1 }] }, { items: Array.from({ length: 101 }, (_, id) => ({ id: id + 1, quantity: 1 })) }];
  for (const body of invalid) {
    const h = harness();
    const response = await h.run(body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: 'INVALID_ITEMS' });
    assert.equal(h.itemCalls.length + h.mails.length + h.histories.length + h.events.length, 0);
  }
  const broken = harness();
  assert.equal((await broken.run('{', {}, true)).status, 400);
  assert.equal(broken.itemCalls.length, 0);
});

test('actual body size is bounded before JSON parsing, even without a trustworthy Content-Length', async () => {
  const headerVariants: Record<string, string>[] = [{}, { 'content-length': '2' }, { 'content-length': '32769' }];
  for (const headers of headerVariants) {
    const h = harness();
    const response = await h.run({ items: [{ id: 11, quantity: 1 }], comment: 'я'.repeat(32768) }, headers);
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { ok: false, error: 'BODY_TOO_LARGE' });
    assert.equal(h.itemCalls.length + h.mails.length + h.histories.length + h.events.length, 0);
    if (headers['content-length'] === '32769') assert.deepEqual(h.order, []);
  }
});

test('only requested item ids are queried; unavailable items prevent delivery and persistence', async () => {
  const h = harness();
  const response = await h.run({ items: [{ id: 11, quantity: 1 }, { id: 999, quantity: 1 }] });
  assert.equal(response.status, 400);
  assert.deepEqual(h.itemCalls, [{ token: 'active-price', ids: [11, 999] }]);
  assert.equal(h.mails.length + h.histories.length + h.events.length, 0);
  assert.ok(!h.measured.includes('pricing'));
});

test('selected-item optimization preserves quantities, currency formulas, recipients, saved history and audit metadata', async () => {
  const h = harness();
  const response = await h.run({
    items: [{ id: 11, quantity: 2 }, { id: 12, quantity: 3 }, { id: 13, quantity: 1 }],
    comment: '  Заказ <высокий>\r\nСогласован  ',
    rubConversion: { date: '18.10.2026', rates: { EUR: 100.2, CNY: 12.34 }, itemIds: [11, 13] },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(h.order, ['access:active-price', 'session', 'global', 'items', 'mail', 'history', 'analytics']);
  assert.deepEqual(h.rates, [
    { key: 'public_price_request:token:active-price:session:synthetic-session', limit: 10, window: 600000 },
    { key: 'public_price_request:global', limit: 300, window: 600000 },
  ]);
  assert.deepEqual(h.itemCalls, [{ token: 'active-price', ids: [11, 12, 13] }]);
  assert.equal(h.mails[0].to, 'notify@example.test, MANAGER@example.test, ktsmarketolog@yandex.ru, support@example.test');
  assert.equal(h.mails[0].subject, 'Заявка из индивидуального прайса: Согласованный прайс');
  assert.match(h.mails[0].html, /Компрессор &lt;A&gt;/);
  assert.match(h.mails[0].html, /Заказ &lt;высокий&gt;<br>Согласован/);
  assert.match(h.mails[0].text, /Итого позиций: 6/);
  const history = h.histories[0];
  assert.deepEqual({ ...history, items: undefined, totalPriceLabel: undefined, rubConversionInfo: undefined, convertedBreakdownLabel: undefined }, {
    companyId: 31, priceListId: 18, token: 'active-price', priceTitle: 'Согласованный прайс', clientName: 'Тестовый клиент',
    managerId: 7, supportManagerId: 8, comment: 'Заказ <высокий>\nСогласован', totalQuantity: 6, totalConvertedRub: 3982,
    items: undefined, totalPriceLabel: undefined, rubConversionInfo: undefined, convertedBreakdownLabel: undefined,
  });
  assert.deepEqual(history.items, [
    { priceItemId: 11, productTitle: 'Компрессор <A>', model: 'Model A', sku: 'SKU-A', variantTitle: 'Большой', quantity: 2,
      prices: [
        { amount: 10.25, currency: 'EUR', lineTotal: 20.5, convertedRubAmount: 1027, convertedRubLineTotal: 2054 },
        { amount: 900, currency: 'RUB', lineTotal: 1800, convertedRubAmount: 900, convertedRubLineTotal: 1800 },
        { amount: 2, currency: 'CNY', lineTotal: 4, convertedRubAmount: 25, convertedRubLineTotal: 50 },
      ] },
    { priceItemId: 12, productTitle: 'Клапан', model: '', sku: 'SKU-B', variantTitle: 'Малый', quantity: 3,
      prices: [{ amount: 1250.5, currency: '', lineTotal: 3751.5, convertedRubAmount: null, convertedRubLineTotal: null }] },
    { priceItemId: 13, productTitle: 'Труба', model: 'Model C', sku: 'SKU-C', variantTitle: 'Средний', quantity: 1,
      prices: [{ amount: 6.3, currency: 'CNY', lineTotal: 6.3, convertedRubAmount: 78, convertedRubLineTotal: 78 }] },
  ]);
  const event = h.events[0];
  assert.equal(event.eventType, 'public_price_request_sent');
  assert.equal(event.managerId, 7);
  assert.equal(event.priceListId, 18);
  assert.equal(event.sessionId, 'synthetic-session');
  const audit = event.metadata as Record<string, unknown>;
  assert.deepEqual(audit.totalByCurrency, { EUR: 20.5, RUB: 1800, CNY: 10.3, amount: 3751.5 });
  assert.deepEqual(audit.rubConversion, { totalRub: 3982, date: '18.10.2026', rates: { EUR: 100.2, CNY: 12.34 } });
  assert.equal(audit.totalQuantity, 6);
  assert.equal(audit.itemCount, 3);
  assert.equal(audit.hasComment, true);
  assert.deepEqual(h.measured, ['access', 'session_limit', 'global_limit', 'body', 'items', 'pricing', 'delivery', 'history', 'analytics']);
  assert.deepEqual(h.statuses, [200]);
});

test('repeated item ids retain the existing first-quantity behavior without duplicate item queries', async () => {
  const h = harness();
  assert.equal((await h.run({ items: [{ id: 12, quantity: 2 }, { id: 12, quantity: 9 }] })).status, 200);
  assert.deepEqual(h.itemCalls[0].ids, [12]);
  assert.equal(h.histories[0].totalQuantity, 2);
});

test('fresh metadata is reloaded for every request instead of retaining stale assignment or recipients', async () => {
  const h = harness();
  assert.equal((await h.run()).status, 200);
  h.metadata.managerId = 99;
  h.metadata.managerEmail = 'new-manager@example.test';
  h.metadata.title = 'Новый заголовок';
  assert.equal((await h.run()).status, 200);
  assert.equal(h.histories[1].managerId, 99);
  assert.equal(h.histories[1].priceTitle, 'Новый заголовок');
  assert.match(h.mails[1].to, /new-manager@example\.test/);
  assert.equal(h.order.filter((stage) => stage === 'access:active-price').length, 2);
});

test('access revoked between requests is honored before loading selected items or charging limits', async () => {
  const options = { missing: false };
  const h = harness(options);
  assert.equal((await h.run()).status, 200);
  const itemLookups = h.itemCalls.length;
  const rateChecks = h.rates.length;
  options.missing = true;
  assert.equal((await h.run()).status, 404);
  assert.equal(h.itemCalls.length, itemLookups);
  assert.equal(h.rates.length, rateChecks);
  assert.equal(h.mails.length, 1);
});

test('mail failure does not create successful history or analytics; existing partial-failure handling is preserved', async () => {
  const failed = harness({ mailFailure: true });
  assert.equal((await failed.run()).status, 500);
  assert.equal(failed.histories.length + failed.events.length, 0);
  assert.deepEqual(failed.statuses, [500]);
  const historyFailed = harness({ historyFailure: true });
  assert.equal((await historyFailed.run()).status, 200);
  assert.equal(historyFailed.mails.length, 1);
  assert.equal(historyFailed.events.length, 1);
  const auditFailed = harness({ analyticsFailure: true });
  assert.equal((await auditFailed.run()).status, 200);
  assert.equal(auditFailed.mails.length, 1);
  assert.equal(auditFailed.histories.length, 1);
});
