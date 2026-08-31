import assert from 'node:assert/strict';
import test from 'node:test';

import {
  catalogPagePath,
  catalogRedirectPath,
  getCatalogTotalPages,
  hasUnsupportedCatalogQuery,
  normalizeCatalogRouteParam,
  readCatalogPage,
} from '../src/entities/catalog/api/catalogSeo';
import { buildCatalogCollectionJsonLd } from '../src/entities/catalog/lib/catalogStructuredData';

test('catalog route parameters preserve canonical case and reject malformed encoding', () => {
  assert.equal(normalizeCatalogRouteParam('  Carel  '), 'Carel');
  assert.equal(normalizeCatalogRouteParam('datchiki%2Ddavleniya'), 'datchiki-davleniya');
  assert.equal(normalizeCatalogRouteParam('%E0%A4%A'), '');
  assert.equal(normalizeCatalogRouteParam(undefined), '');
});

test('catalog query filtering distinguishes crawlable pagination from unsupported filters', () => {
  assert.equal(hasUnsupportedCatalogQuery({}), false);
  assert.equal(hasUnsupportedCatalogQuery({ page: '2' }), false);
  assert.equal(hasUnsupportedCatalogQuery({ page: '0' }), true);
  assert.equal(hasUnsupportedCatalogQuery({ page: ['2', '3'] }), true);
  assert.equal(hasUnsupportedCatalogQuery({ page: '2' }, false), true);
  assert.equal(hasUnsupportedCatalogQuery({ brand: 'carel' }), true);
  assert.equal(hasUnsupportedCatalogQuery({ page: '2', utm_source: 'test' }), true);
});

test('catalog pagination accepts positive integer pages and builds canonical page paths', () => {
  assert.equal(readCatalogPage(undefined), 1);
  assert.equal(readCatalogPage('1'), 1);
  assert.equal(readCatalogPage('12'), 12);
  assert.equal(readCatalogPage(['3', '4']), 3);
  assert.equal(readCatalogPage('0'), 1);
  assert.equal(readCatalogPage('-2'), 1);
  assert.equal(readCatalogPage('not-a-page'), 1);

  assert.equal(getCatalogTotalPages(0, 36), 1);
  assert.equal(getCatalogTotalPages(36, 36), 1);
  assert.equal(getCatalogTotalPages(37, 36), 2);
  assert.equal(catalogPagePath('/catalog/brands/carel', 1), '/catalog/brands/carel');
  assert.equal(catalogPagePath('/catalog/brands/carel', 2), '/catalog/brands/carel?page=2');
  assert.equal(
    catalogRedirectPath('/catalog/brands/carel', { page: '2', source: ['a', 'b'] }),
    '/catalog/brands/carel?page=2&source=a&source=b',
  );
});

test('catalog collection JSON-LD contains CollectionPage, breadcrumbs and paged ItemList positions', () => {
  const data = buildCatalogCollectionJsonLd({
    name: 'Carel',
    description: 'Оборудование Carel',
    path: '/catalog/brands/carel?page=2',
    breadcrumbs: [
      { name: 'Главная', path: '/' },
      { name: 'Carel', path: '/catalog/brands/carel' },
    ],
    items: [{ name: 'Товар 1' }, { name: 'Товар 2' }],
    positionOffset: 36,
  });

  const graph = (data as { '@graph': Array<Record<string, any>> })['@graph'];
  assert.equal(graph[0]['@type'], 'CollectionPage');
  assert.equal(graph[1]['@type'], 'BreadcrumbList');
  assert.equal(graph[2]['@type'], 'ItemList');
  assert.equal(graph[2]?.itemListElement[0].position, 37);
  assert.equal(graph[2]?.itemListElement[1].position, 38);
});
