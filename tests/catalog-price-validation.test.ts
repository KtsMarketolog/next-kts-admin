import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as XLSX from 'xlsx';

import * as helpers from '../src/entities/catalog/api/catalogAdmin/helpers';
import type { CatalogProductInput } from '../src/entities/catalog/api/catalogAdmin/types';
import { parseCatalogExcel } from '../src/entities/catalog/api/catalogExcel';

const fields = ['priceEur', 'priceRub', 'priceCny', 'generalDiscount', 'manualDiscount', 'manualDiscountRop'] as const;
const labels = {
  priceEur: 'Цена EUR', priceRub: 'Цена RUB', priceCny: 'Цена CNY',
  generalDiscount: 'Общая скидка', manualDiscount: 'Ручная скидка', manualDiscountRop: 'Ручная скидка РОП',
};
const product = { article: 'SYNTHETIC', title: 'Synthetic product', priceRub: '100.00' };

// Load the actual implementation, injecting every IO dependency explicitly.
// Unknown imports fail closed: application DB/network access is never available.
function load<T>(filename: string, dependencies: Record<string, unknown>): T {
  const source = readFileSync(new URL(filename, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const testModule = { exports: {} };
  new Function('require', 'module', 'exports', code)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, testModule, testModule.exports);
  return testModule.exports as T;
}

function coreWithoutIo() {
  const calls: string[] = [];
  const forbidden = (name: string) => async () => { calls.push(name); throw new Error(`Unexpected IO: ${name}`); };
  const core = load<typeof import('../src/entities/catalog/api/catalogAdmin/core')>(
    '../src/entities/catalog/api/catalogAdmin/core.ts', {
      '@/shared/lib/db': { ensureSiteSchema: forbidden('site schema') },
      '@/shared/lib/db/client': { query: forbidden('query'), withTransaction: forbidden('transaction') },
      '../catalogDb': { ensureCatalogSchema: forbidden('catalog schema') },
      './helpers': helpers,
      './productQueries': { getCatalogAdminProductById: forbidden('product read') },
    },
  );
  return { core, calls };
}

test('catalog prices preserve supported Russian formats, numeric JSON values and explicit blanks idempotently', () => {
  const accepted: Array<[unknown, string | null]> = [
    [null, null], [undefined, null], ['', null], [' \t\n\u00a0', null],
    [0, '0'], ['0.00', '0.00'], [1000, '1000'], [1e3, '1000'], [1e-2, '0.01'],
    ['1 000,50', '1000.50'], ['1\u00a0000.50', '1000.50'], ['1\u202f000,50', '1000.50'],
    [' 12 345 678,90 ', '12345678.90'], ['0001.20', '0001.20'], ['125', '125'],
    ['999999999.00', '999999999.00'], [999999999, '999999999'],
  ];
  for (const [value, expected] of accepted) {
    const normalized = helpers.normalizeCatalogPrice(value);
    assert.equal(normalized, expected, String(value));
    assert.equal(helpers.normalizeCatalogPrice(normalized), expected, 'normalizing a stored value must be idempotent');
  }
  assert.equal(helpers.normalizeCatalogPriceFields({ generalDiscount: '125' }).generalDiscount, '125', 'numeric validation must not introduce a new 100% business limit');
});

test('malformed catalog prices fail explicitly instead of stripping characters or becoming null', () => {
  const rejected: unknown[] = [
    -1, '-1', '-100', '−1', '+1', 'abc123', '1e3', '1E+3', '0x10', '100 ₽', '10%', '=2+3', '1/2', '1_000',
    '1,2,3', '1.2.3', '1,234.56', '1.234,56', '0.001', '.5', '1.', '1,', '999999999.01',
    1000000000, 1e-7, NaN, Infinity, -Infinity, 'NaN', 'Infinity',
    true, false, [], [12], {}, { toString: () => '12' },
    '12 34', '1  000', '1000 000', '1\n000', '1\t000', '1\u200b000', '1 000, 50', 'word',
  ];
  for (const value of rejected) {
    assert.throws(() => helpers.normalizeCatalogPrice(value, 'Цена RUB'), /Некорректное значение поля «Цена RUB»/, String(value));
  }
});

for (const field of fields) {
  test(`core rejects invalid ${field} on create and update before any schema/query/transaction IO`, async () => {
    const { core, calls } = coreWithoutIo();
    for (const value of ['1e3', true, [12]]) {
      const input = { ...product, [field]: value } as CatalogProductInput;
      const correctField = (error: unknown) => error instanceof Error && error.message.includes(`«${labels[field]}»`);
      await assert.rejects(core.createCatalogAdminProduct(input), correctField);
      await assert.rejects(core.updateCatalogAdminProduct(45, input), correctField);
    }
    assert.deepEqual(calls, []);
  });
}

test('a malformed final import price rejects the whole batch before any IO, not after writing its prefix', async () => {
  const { core, calls } = coreWithoutIo();
  const rows = Array.from({ length: 2001 }, (_, index) => ({ ...product, article: `SYNTHETIC-${index}` }));
  const invalid = { ...rows.at(-1)!, manualDiscountRop: '1e3' };
  rows[rows.length - 1] = invalid;
  await assert.rejects(core.replaceCatalogFromRows(rows), /Ручная скидка РОП/);
  assert.deepEqual(calls, []);
});

function route(method: 'POST' | 'PUT') {
  const writes: CatalogProductInput[] = [];
  const effects: string[] = [];
  const persist = async (input: CatalogProductInput) => { writes.push(input); return { id: 45, ...input }; };
  type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
  const handlers = load<Record<'POST' | 'PUT', Handler>>(
    method === 'POST' ? '../src/app/api/admin/catalog/products/route.ts' : '../src/app/api/admin/catalog/products/[id]/route.ts', {
      '@/entities/catalog/api/catalogAdmin': {
        createCatalogAdminProduct: persist,
        updateCatalogAdminProduct: async (_id: number, input: CatalogProductInput) => persist(input),
      },
      '@/entities/catalog/api/catalogAdmin/helpers': helpers,
      '@/entities/catalog/api/catalogRevalidation': { revalidatePublicCatalog: () => { effects.push('revalidate'); } },
      '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => null },
      '@/shared/lib/adminAuth': { requireAdminSession: async () => ({ session: { role: 'admin', adminUserId: 1, sessionId: 'synthetic' } }) },
      '@/shared/lib/db/securityAuditRepo': { recordSecurityEvent: async () => { effects.push('audit'); } },
      '@/shared/lib/originProtection': { enforceSameOriginRequest: () => null },
      '@/shared/lib/rateLimit': { getClientIp: () => '127.0.0.1' },
    },
  );
  return {
    writes, effects,
    run: (body: unknown) => handlers[method](new Request('https://example.test/api/admin/catalog/products/45', {
      method, body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
    }), { params: Promise.resolve({ id: '45' }) }),
  };
}

for (const method of ['POST', 'PUT'] as const) {
  test(`${method} validates raw price and discount types before coercion, with no write or success side effects`, async () => {
    const api = route(method);
    for (const field of fields) {
      for (const value of ['1e3', true, {}, [12]]) {
        const response = await api.run({ ...product, [field]: value });
        assert.equal(response.status, 400, `${field}: ${JSON.stringify(value)}`);
        assert.ok((await response.json()).error.includes(`«${labels[field]}»`));
      }
    }
    assert.deepEqual(api.writes, []);
    assert.deepEqual(api.effects, []);
  });

  test(`${method} retains explicit blank/null clearing and accepts numeric JSON exponents as numbers`, async () => {
    const api = route(method);
    for (const blank of ['', '  ', null]) {
      const response = await api.run({ ...product, ...Object.fromEntries(fields.map((field) => [field, blank])) });
      assert.equal(response.status, 200);
      assert.deepEqual(Object.fromEntries(fields.map((field) => [field, api.writes.at(-1)![field]])), Object.fromEntries(fields.map((field) => [field, null])));
    }
    const numericResponse = await api.run('{"article":"SYNTHETIC","title":"Synthetic","priceRub":1e3,"generalDiscount":125}');
    assert.equal(numericResponse.status, 200);
    assert.equal(api.writes.at(-1)!.priceRub, '1000');
    assert.equal(api.writes.at(-1)!.generalDiscount, '125');
  });
}

for (const bookType of ['xlsx', 'biff8'] as const) {
  test(`${bookType} raw numeric currency/percent masks stay compatible but a textual exponent rejects the entire import`, async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Артикул', 'Наименование', 'Цена RUB', 'Общая скидка'],
      ['NUMERIC', 'Raw numeric values', 1000, 0.1],
      ['RUSSIAN', 'Russian separators', '1\u202f000,50', '10,5'],
      ['INVALID', 'Scientific text', '1e3', 10],
    ]);
    sheet.C2.z = '#,##0.00 "₽"';
    sheet.D2.z = '0%';
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Synthetic');
    const rows = parseCatalogExcel(Buffer.from(XLSX.write(workbook, { type: 'buffer', bookType })));
    assert.equal(rows[0].priceRub, '1000');
    assert.equal(rows[0].generalDiscount, '0.1', 'a 10% display mask must not rescale the raw discount');
    assert.equal(helpers.normalizeCatalogPriceFields(rows[0]).priceRub, '1000');
    assert.equal(helpers.normalizeCatalogPriceFields(rows[1]).priceRub, '1000.50');
    assert.equal(helpers.normalizeCatalogPriceFields(rows[1]).generalDiscount, '10.5');
    assert.equal(rows[2].priceRub, '1e3');
    const { core, calls } = coreWithoutIo();
    await assert.rejects(core.replaceCatalogFromRows(rows), /Цена RUB/);
    assert.deepEqual(calls, []);
  });
}
