import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { normalizeCatalogPriceFields } from '../src/entities/catalog/api/catalogAdmin/helpers';
import { enforceSameOriginRequest } from '../src/shared/lib/originProtection';

type ProductMethod = 'POST' | 'PUT';
type Options = { denied?: boolean; limited?: boolean; failure?: Error };
type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;

function harness(method: ProductMethod, options: Options = {}) {
  const calls: string[] = [];
  const inputs: unknown[][] = [];
  let failure = options.failure;
  const save = async (...args: unknown[]) => {
    calls.push('save');
    inputs.push(args);
    if (failure) throw failure;
    return { id: 17, ...(args.at(-1) as Record<string, unknown>) };
  };
  const dependencies: Record<string, unknown> = {
    '@/entities/catalog/api/catalogAdmin': {
      createCatalogAdminProduct: save,
      updateCatalogAdminProduct: save,
    },
    '@/entities/catalog/api/catalogAdmin/helpers': { normalizeCatalogPriceFields },
    '@/entities/catalog/api/catalogRevalidation': { revalidatePublicCatalog: () => { calls.push('revalidate'); } },
    '@/shared/lib/adminAuth': { requireAdminSession: async () => {
      calls.push('auth');
      return options.denied ? { denied: Response.json({ error: 'Нужен вход' }, { status: 401 }) }
        : { session: { role: 'admin', adminUserId: 1, sessionId: 'synthetic' } };
    } },
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => {
      calls.push('limit');
      return options.limited ? Response.json({ error: 'Лимит' }, { status: 429 }) : null;
    } },
    '@/shared/lib/db/securityAuditRepo': { recordSecurityEvent: async () => { calls.push('audit'); } },
    '@/shared/lib/originProtection': { enforceSameOriginRequest },
    '@/shared/lib/rateLimit': { getClientIp: () => '127.0.0.1' },
  };
  const route = method === 'POST' ? 'products/route.ts' : 'products/[id]/route.ts';
  const source = readFileSync(new URL(`../src/app/api/admin/catalog/${route}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const output = { exports: {} as Record<ProductMethod, Handler> };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`);
    return dependencies[name];
  }, output, output.exports);
  return {
    calls, inputs,
    allowSave: () => { failure = undefined; },
    run: (body: Record<string, unknown>, origin = 'https://example.test', id = '17') => output.exports[method](
      new Request(`https://example.test/api/admin/catalog/products${method === 'PUT' ? `/${id}` : ''}`, {
        method, headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    ),
  };
}

const draft = { title: 'Synthetic product', article: 'syn-a', brand: 'Other brand', priceRub: '123.45' };

for (const method of ['POST', 'PUT'] as const) {
  test(`manual catalog ${method} reports article conflict without success audit or revalidation`, async () => {
    const failure = Object.assign(new Error('Товар с артикулом «syn-a» уже существует. Каталог не изменён.'), {
      code: 'CATALOG_ARTICLE_CONFLICT',
    });
    const h = harness(method, { failure });
    const response = await h.run(draft);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: failure.message, code: failure.code });
    assert.deepEqual(h.calls, ['auth', 'limit', 'save']);
    assert.equal(h.inputs.length, 1);
    assert.equal((h.inputs[0].at(-1) as Record<string, unknown>).article, draft.article);
    if (method === 'PUT') assert.equal(h.inputs[0][0], 17);

    // A conflict does not lock the route into an error state; a corrected form
    // can be saved, and only that successful request emits success side effects.
    h.allowSave();
    const corrected = await h.run({ ...draft, article: 'SYN-B' });
    assert.equal(corrected.status, 200);
    assert.equal((await corrected.json()).product.article, 'SYN-B');
    assert.deepEqual(h.calls, ['auth', 'limit', 'save', 'auth', 'limit', 'save', 'revalidate', 'audit']);
  });

  test(`manual catalog ${method} retains authentication, origin and rate limits before writes`, async () => {
    for (const [options, origin, status, expectedCalls] of [
      [{ denied: true }, 'https://example.test', 401, ['auth']],
      [{}, 'https://outside.test', 403, ['auth']],
      [{ limited: true }, 'https://example.test', 429, ['auth', 'limit']],
    ] as const) {
      const h = harness(method, options);
      const response = await h.run(draft, origin);
      assert.equal(response.status, status);
      assert.deepEqual(h.calls, expectedCalls);
      assert.deepEqual(h.inputs, []);
    }
  });

  test(`manual catalog ${method} keeps existing validation errors without inventing article conflicts`, async () => {
    const failure = new Error('Артикул товара обязателен');
    const h = harness(method, { failure });
    const response = await h.run({ ...draft, article: '' });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: failure.message });
    assert.deepEqual(h.calls, ['auth', 'limit', 'save']);
  });

  test(`manual catalog ${method} still validates prices before repository writes`, async () => {
    const h = harness(method);
    const response = await h.run({ ...draft, priceRub: '-5' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Некорректное значение поля «Цена RUB»/);
    assert.deepEqual(h.calls, ['auth', 'limit']);
    assert.deepEqual(h.inputs, []);
  });
}

test('manual catalog PUT validates product id before any repository writes', async () => {
  const h = harness('PUT');
  const response = await h.run(draft, 'https://example.test', '0');
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Некорректный товар' });
  assert.deepEqual(h.calls, ['auth', 'limit']);
  assert.deepEqual(h.inputs, []);
});
