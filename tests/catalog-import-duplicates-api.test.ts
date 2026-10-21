import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as XLSX from 'xlsx';
import * as validation from '../src/entities/catalog/api/catalogImportValidation';
import * as matching from '../src/entities/catalog/api/catalogAdmin/importMatching';
import { parseCatalogExcel } from '../src/entities/catalog/api/catalogExcel';
import { enforceSameOriginRequest } from '../src/shared/lib/originProtection';

function workbook(rows: unknown[][], bookType: 'xlsx' | 'biff8' = 'xlsx') {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Каталог');
  return Buffer.from(XLSX.write(book, { type: 'buffer', bookType }));
}

function request(bytes: Buffer, name = 'Каталог.xlsx', origin = 'https://example.test') {
  const data = new FormData();
  data.set('file', new File([new Uint8Array(bytes)], name));
  return new Request('https://example.test/api/admin/catalog/import', { method: 'POST', headers: { origin }, body: data });
}

function harness(options: { denied?: boolean; limited?: boolean; dbFailure?: Error } = {}) {
  const calls: string[] = [];
  const deps: Record<string, unknown> = {
    '@/entities/catalog/api/catalogExcel': { parseCatalogExcel: (buffer: Buffer) => { calls.push('parse'); return parseCatalogExcel(buffer); } },
    '@/entities/catalog/api/catalogImportValidation': validation,
    '@/entities/catalog/api/catalogAdmin/importMatching': matching,
    '@/entities/catalog/api/catalogAdmin': { replaceCatalogFromRows: async (rows: unknown[]) => {
      calls.push('save'); if (options.dbFailure) throw options.dbFailure;
      return { importedProducts: rows.length, syncedWholesaleProducts: rows.length, categories: 1, subcategories: 1, brands: 1 };
    } },
    '@/entities/catalog/api/catalogRevalidation': { revalidatePublicCatalog: () => { calls.push('revalidate'); } },
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: async () => options.limited ? Response.json({}, { status: 429 }) : null },
    '@/shared/lib/adminAuth': { requireAdminSession: async () => options.denied ? { denied: Response.json({}, { status: 401 }) }
      : { session: { role: 'admin', adminUserId: 1, sessionId: 'synthetic' } } },
    '@/shared/lib/db/securityAuditRepo': { recordSecurityEvent: async () => { calls.push('audit'); } },
    '@/shared/lib/originProtection': { enforceSameOriginRequest },
    '@/shared/lib/rateLimit': { getClientIp: () => '127.0.0.1' },
  };
  const source = readFileSync(new URL('../src/app/api/admin/catalog/import/route.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const output = { exports: {} as { POST: (request: Request) => Promise<Response> } };
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    assert.ok(name in deps, `Unexpected dependency ${name}`); return deps[name];
  }, output, output.exports);
  return { calls, run: output.exports.POST };
}

for (const bookType of ['xlsx', 'biff8'] as const) {
  test(`catalog ${bookType} upload reports actual duplicate rows before any save, revalidation or success audit`, async () => {
    const h = harness();
    const bytes = workbook([
      ['Выгрузка каталога'], [], ['Артикул', 'Наименование', 'Бренд'],
      ['ABC-123', 'Первый товар', 'Первый бренд'], [],
      [' abc-123 ', 'Другой товар', 'Другой бренд'],
    ], bookType);
    const response = await h.run(request(bytes, bookType === 'biff8' ? 'Каталог.xls' : 'Каталог.xlsx'));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, 'CATALOG_DUPLICATE_ARTICLES');
    assert.equal(body.duplicateCount, 1);
    assert.equal(body.truncated, false);
    assert.equal(body.duplicates[0].article.toLowerCase(), 'abc-123');
    assert.deepEqual(body.duplicates[0].rows, [4, 6]);
    assert.equal(body.duplicates[0].totalRows, 2);
    assert.match(body.error, /ABC-123|abc-123/);
    assert.match(response.headers.get('cache-control')!, /private.*no-store/);
    assert.deepEqual(h.calls, ['parse']);
  });
}

test('catalog duplicate refusal can be followed by a corrected import; distinct leading zeros stay distinct', async () => {
  const h = harness();
  const duplicate = await h.run(request(workbook([['Артикул'], ['DUP'], ['dup']])));
  assert.equal(duplicate.status, 400);
  const corrected = await h.run(request(workbook([['Артикул'], ['001'], ['1']])));
  assert.equal(corrected.status, 200);
  assert.equal((await corrected.json()).result.importedProducts, 2);
  assert.deepEqual(h.calls, ['parse', 'parse', 'save', 'revalidate', 'audit']);
});

test('catalog import authentication, origin and limits precede parsing and all catalog changes', async () => {
  const bytes = workbook([['Артикул'], ['DUP'], ['dup']]);
  for (const [options, origin, status] of [
    [{ denied: true }, 'https://example.test', 401],
    [{ limited: true }, 'https://example.test', 429],
    [{}, 'https://evil.test', 403],
  ] as const) {
    const h = harness(options); const response = await h.run(request(bytes, 'Каталог.xlsx', origin));
    assert.equal(response.status, status); assert.deepEqual(h.calls, []);
  }
});

test('existing catalog ambiguity reports a conflict, without success side effects or invented Excel rows', async () => {
  const failure = Object.assign(new Error('В каталоге уже несколько товаров с артикулом ABC. Импорт не выполнен.'), {
    code: 'CATALOG_EXISTING_DUPLICATE_ARTICLES', duplicates: [{ article: 'ABC', productIds: [10, 20], totalProducts: 2 }], duplicateCount: 1, truncated: false,
  });
  Object.setPrototypeOf(failure, matching.CatalogExistingArticleConflictError.prototype);
  const h = harness({ dbFailure: failure });
  const response = await h.run(request(workbook([['Артикул'], ['ABC']])));
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, failure.code); assert.deepEqual(body.duplicates, failure.duplicates);
  assert.equal(body.duplicates[0].rows, undefined);
  assert.deepEqual(h.calls, ['parse', 'save']);
});
