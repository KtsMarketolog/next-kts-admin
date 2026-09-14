import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import * as workflow from '../src/shared/lib/wholesalePriceWorkflowStatus';

// Execute the repository code with explicitly injected IO. Unexpected imports
// fail closed, so these tests cannot connect to an application database.
function loadRepository<T>(filename: string, dependencies: Record<string, unknown>): T {
  const code = ts.transpileModule(readFileSync(new URL(filename, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const stubModule = { exports: {} };
  new Function('require', 'module', 'exports', code)((name: string) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, stubModule, stubModule.exports);
  return stubModule.exports as T;
}

const discountRow = {
  price_list_id: '1',
  price_title: 'Synthetic price',
  price_group: 'Group',
  company: 'Synthetic company',
  manager: 'Synthetic manager',
  custom_wholesale_price: null as string | null,
  discount_percent: null as string | null,
  price_manually_changed: false,
  effective_wholesale_price: '100' as string | null,
  price_rub: '100' as string | null,
  retail_price: null as string | null,
  wholesale_price: '100' as string | null,
  price_eur: null as string | null,
  price_cny: null as string | null,
};

async function discountReport(rows: Partial<typeof discountRow>[]) {
  const repository = loadRepository<typeof import('../src/shared/lib/db/wholesaleAdminRepo/discountReportRepo')>(
    '../src/shared/lib/db/wholesaleAdminRepo/discountReportRepo.ts',
    {
      '../schema': { ensureSiteSchema: async () => {} },
      '../client': {
        query: async (sql: string) => {
          assert.match(sql, /where i\.visible = true/);
          return { rows: rows.map((row) => ({ ...discountRow, ...row })) };
        },
      },
    },
  );
  return repository.getWholesaleDiscountReportRows();
}

for (const withoutDiscount of ['0', null]) {
  test(`discount report includes ${withoutDiscount === null ? 'implicit' : 'explicit'} zero in mixed groups`, async () => {
    const rows = await discountReport([{ discount_percent: '10' }, { discount_percent: withoutDiscount }]);
    assert.equal(rows[0].discount, 'Разная');
  });
}

test('discount report retains a full percentage discount with a zero final price', async () => {
  const rows = await discountReport([{ discount_percent: '100' }]);
  assert.equal(rows[0].discount, '100%');
});

test('discount report treats a manually entered zero as a full discount, not the fallback price', async () => {
  const rows = await discountReport([
    { price_manually_changed: true, custom_wholesale_price: '0', discount_percent: '10' },
    { discount_percent: '100' },
  ]);
  assert.equal(rows[0].discount, '100%');
});

test('discount report accepts a zero effective manual price and distinguishes it from an empty value', async () => {
  const free = await discountReport([
    { price_manually_changed: true, custom_wholesale_price: null, effective_wholesale_price: '0' },
  ]);
  assert.equal(free[0].discount, '100%');
  const empty = await discountReport([
    { price_manually_changed: true, custom_wholesale_price: ' ', effective_wholesale_price: '90' },
  ]);
  assert.equal(empty[0].discount, '10%');
});

test('discount report distinguishes mixed full and partial discounts', async () => {
  const rows = await discountReport([{ discount_percent: '100' }, { discount_percent: '10' }]);
  assert.equal(rows[0].discount, 'Разная');
});

test('discount report preserves rounding, near-equal discount tolerance and non-discounted groups', async () => {
  const nearEqual = await discountReport([{ discount_percent: '10,04' }, { discount_percent: '10.1' }]);
  assert.equal(nearEqual[0].discount, '10%');
  const different = await discountReport([{ discount_percent: '10' }, { discount_percent: '20' }]);
  assert.equal(different[0].discount, 'Разная');
  const noDiscount = await discountReport([
    { discount_percent: '0' },
    { discount_percent: null },
    { price_manually_changed: true, custom_wholesale_price: '110' },
  ]);
  assert.equal(noDiscount[0].discount, '0%');
});

test('discount report skips rows without a positive base and keeps price lists separate', async () => {
  const rows = await discountReport([
    { discount_percent: '10' },
    { price_rub: '0', wholesale_price: null, discount_percent: '100' },
    { price_list_id: '2', discount_percent: '0' },
  ]);
  assert.deepEqual(rows.map((row) => [row.priceId, row.discount]), [[1, '10%'], [2, '0%']]);
});

for (const period of ['30d', 'all'] as const) {
  test(`manager ${period} summary and empty-price query count only visible items`, async () => {
    const prices = [
      { id: '1', items: Array.from({ length: 7474 }, () => ({ visible: false })) },
      { id: '2', items: [{ visible: true }, { visible: false }, { visible: true }] },
      { id: '3', items: [] },
    ];
    let itemCountQueries = 0;
    const query = async (sql: string, params: unknown[]) => {
      assert.equal(params[0], 9);
      if (sql.includes('from wholesale_managers m')) {
        return { rows: [{ id: '9', name: 'Manager', login: 'manager', email: '', phone: '', role: 'manager', last_login_at: null }] };
      }
      if (sql.includes('with manager_prices as')) {
        itemCountQueries++;
        // Verify the actual SQL contract before providing synthetic aggregate
        // rows. SQL execution itself is deliberately outside this IO-free test.
        assert.match(sql, /count\(i\.id\) filter \(where i\.visible = true\)::(?:integer|text) as item_count/);
        assert.match(sql, /left join wholesale_price_list_items i on i\.price_list_id = pl\.id/);
        assert.match(sql, /where pl\.manager_id = \$1/);
        const counts = prices.map((price) => price.items.filter((item) => item.visible).length);
        if (sql.includes('as total_prices')) {
          assert.deepEqual(params, [9, period === '30d' ? '30 days' : null]);
          return { rows: [{
            total_prices: String(prices.length),
            average_items_per_price: (counts.reduce((sum, count) => sum + count, 0) / counts.length).toFixed(1),
            empty_prices: String(counts.filter((count) => count === 0).length),
          }] };
        }
        return { rows: prices.filter((_, index) => counts[index] === 0).map((price) => ({
          id: price.id, title: `Price ${price.id}`, client_name: 'Client', valid_until: '2999-01-01',
          created_at: new Date().toISOString(), item_count: '0',
        })) };
      }
      return { rows: [] };
    };
    const client = { query };
    const helpers = loadRepository('../src/shared/lib/db/wholesaleAdminRepo/analyticsHelpers.ts', {
      '../client': client,
      '../clientCompaniesRepo': {},
      '@/shared/lib/adminAuth': {},
      '@/shared/lib/wholesalePriceWorkflowStatus': workflow,
    });
    const managerHelpers = loadRepository('../src/shared/lib/db/wholesaleAdminRepo/managerHelpers.ts', { '../client': client });
    const repository = loadRepository<typeof import('../src/shared/lib/db/wholesaleAdminRepo/managerAnalyticsRepo')>(
      '../src/shared/lib/db/wholesaleAdminRepo/managerAnalyticsRepo.ts',
      {
        '../client': client,
        '../schema': { ensureSiteSchema: async () => {} },
        './analyticsHelpers': helpers,
        './managerHelpers': managerHelpers,
      },
    );
    const result = await repository.getWholesaleManagerAnalytics(9, period);
    assert.ok(result);
    assert.equal(itemCountQueries, 2);
    assert.equal(result.summary.totalPrices, 3);
    assert.equal(result.summary.averageItemsPerPrice, 0.7);
    assert.equal(result.summary.emptyPrices, 2);
    assert.deepEqual(result.problemPrices.map((price) => price.id), [1, 3]);
    assert.ok(result.problemPrices.every((price) => price.problems.includes('EMPTY')));
  });
}
