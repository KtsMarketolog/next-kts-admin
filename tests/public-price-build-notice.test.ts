import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';

import * as buildErrors from '../src/shared/lib/priceBuild/errors';
import * as privateMetadata from '../src/shared/lib/seo/privateMetadata';

type PriceResult = { token: string; title: string; categories: unknown[]; showRetailPrices: boolean } | null;

function harness() {
  let result: PriceResult = { token: 'synthetic-token', title: 'Saved price', categories: [{ id: 1 }], showRetailPrices: false };
  let failure: unknown;
  let missing = 0;
  const notFoundError = new Error('SYNTHETIC_NOT_FOUND');
  const modules: Record<string, unknown> = {
    'react/jsx-runtime': jsxRuntime,
    react: { cache: (read: unknown) => read },
    'next/navigation': { notFound: () => { missing++; throw notFoundError; } },
    '@/shared/lib/db': { getPublicWholesalePriceList: async () => { if (failure) throw failure; return result; } },
    '@/shared/lib/phone': { phoneHref: (phone: string) => phone },
    '@/shared/lib/priceBuild/errors': buildErrors,
    '@/shared/lib/seo/privateMetadata': privateMetadata,
    './PriceAnalyticsTracker': { PriceAnalyticsTracker: () => createElement('div', { 'data-analytics': true }) },
    './PriceEventLink': { PriceEventLink: ({ children }: { children: ReactNode }) => createElement('a', {}, children) },
    './PriceRequestForm': { PriceRequestForm: () => createElement('div', { 'data-request-form': true }) },
    './PriceBuildNotice': { PriceBuildNotice: () => createElement('div', { 'data-retry-notice': true }, 'Прайс готовится') },
    './PricePage.module.scss': { default: new Proxy({}, { get: (_, key) => String(key) }) },
  };
  const exports = {} as {
    default(props: { params: Promise<{ token: string }> }): Promise<ReactNode>;
    generateMetadata(props: { params: Promise<{ token: string }> }): Promise<unknown>;
  };
  const code = ts.transpileModule(readFileSync('src/app/price/[token]/page.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  runInNewContext(code, { exports, require(name: string) { assert.ok(name in modules, name); return modules[name]; } });
  const props = () => ({ params: Promise.resolve({ token: 'synthetic-token' }) });
  return {
    render: async () => renderToStaticMarkup(await exports.default(props())),
    metadata: () => exports.generateMetadata(props()),
    fail: (error?: unknown) => { failure = error; },
    setResult: (value: PriceResult) => { result = value; },
    missing: () => missing,
    notFoundError,
  };
}

for (const code of ['PRICE_BUILD_BUSY', 'PRICE_BUILD_TIMEOUT', 'PRICE_BUILD_UNAVAILABLE', 'PRICE_BUILD_ABORTED', 'PRICE_BUILD_FAILED'] as const) {
  test(`price page: ${code} keeps private metadata and shows retry, never 404 or an empty price`, async () => {
    const h = harness();
    h.fail(new buildErrors.PriceBuildError(code));
    assert.deepEqual(await h.metadata(), privateMetadata.createPrivateMetadata());
    const html = await h.render();
    assert.match(html, /data-retry-notice/);
    assert.doesNotMatch(html, /В прайс пока не добавлены товары|data-request-form|data-analytics/);
    assert.equal(h.missing(), 0);

    h.fail();
    const recovered = await h.render();
    assert.match(recovered, /Saved price/);
    assert.match(recovered, /data-request-form/);
    assert.match(recovered, /data-analytics/);
    assert.match(recovered, /\/price\/synthetic-token\/pdf/);
    assert.doesNotMatch(recovered, /data-retry-notice/);
  });
}

test('price page: a genuinely missing price still returns notFound in page and metadata', async () => {
  const h = harness();
  h.setResult(null);
  await assert.rejects(h.render(), (error) => error === h.notFoundError);
  await assert.rejects(h.metadata(), (error) => error === h.notFoundError);
  assert.equal(h.missing(), 2);
});

test('price page: an unrelated failure is not falsely described as a transient build error', async () => {
  const h = harness();
  const error = new Error('Synthetic unrelated failure');
  h.fail(error);
  await assert.rejects(h.render(), (failure) => failure === error);
  await assert.rejects(h.metadata(), (failure) => failure === error);
  assert.equal(h.missing(), 0);
});

test('price page: genuinely empty saved price retains its existing empty-state message', async () => {
  const h = harness();
  h.setResult({ token: 'synthetic-token', title: 'Saved empty price', categories: [], showRetailPrices: false });
  const html = await h.render();
  assert.match(html, /Saved empty price/);
  assert.match(html, /В прайс пока не добавлены товары/);
  assert.doesNotMatch(html, /data-retry-notice/);
});
