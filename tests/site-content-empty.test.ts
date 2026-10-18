import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as jsxRuntime from 'react/jsx-runtime';
import ts from 'typescript';

function compile(filename: string, modules: Record<string, unknown>) {
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: filename,
  }).outputText;
  const loaded = { exports: {} as Record<string, unknown> };
  new Function('require', 'module', 'exports', code)((name: string) => {
    if (name === 'react/jsx-runtime') return jsxRuntime;
    assert.ok(name in modules, `Unexpected dependency: ${name}`);
    return modules[name];
  }, loaded, loaded.exports);
  return loaded.exports;
}

const fixtureSlide = { id: 1, title: 'DEMO SLIDE', imageUrl: '/demo-slide.jpg', linkUrl: null };
const fixtureNews = { id: 1, title: 'DEMO NEWS' };
const fixtureCompany = { id: 1, imageUrl: '/demo-company.jpg' };

type Element = { type: unknown; props: Record<string, unknown> };

function loadHome(data: { slides?: unknown[]; news?: unknown[]; companies?: unknown[]; portfolio?: unknown } = {}) {
  const calls: Array<[string, unknown]> = [];
  const read = (kind: string, result: unknown) => async (options: unknown) => {
    calls.push([kind, options]);
    return result;
  };
  const preloads: unknown[] = [];
  const loaded = compile('src/app/page.tsx', {
    'react-dom': { preload: (...args: unknown[]) => preloads.push(args) },
    '@/entities/site/model/defaultGroupCompanies': { DEFAULT_GROUP_COMPANIES: [fixtureCompany] },
    '@/entities/site/model/defaultSlides': { DEFAULT_HERO_SLIDES: [fixtureSlide] },
    '@/entities/site/model/defaultNews': { DEFAULT_NEWS: [fixtureNews] },
    '@/widgets/home/HomeDeferredSections': { HomeDeferredSections: 'deferred' },
    '@/widgets/home/sections/MainPromo/MainPromo': { MainPromo: 'promo' },
    '@/shared/lib/db': {
      getHeroSlides: read('slides', data.slides ?? []),
      getNewsItems: read('news', data.news ?? []),
      getGroupCompanies: read('companies', data.companies ?? []),
      getBrandPortfolio: read('portfolio', data.portfolio ?? { categories: [], brands: [] }),
    },
    '@/widgets/home/sections/MainPromo/MainPromo.images': {
      getHeroSlideImagePropsSet: (slide: typeof fixtureSlide) => ({
        desktop: { src: slide.imageUrl }, tablet: { src: slide.imageUrl }, mobile: { src: slide.imageUrl },
      }),
    },
    '@/shared/lib/seo/rootMetadata': { createHomeMetadata: () => ({}) },
  });
  return { render: loaded.default as () => Promise<Element>, calls, preloads };
}

test('homepage preserves successfully empty managed content and does not preload demo slides', async () => {
  const home = loadHome();
  const children = (await home.render()).props.children as Element[];
  assert.deepEqual(children[0].props.initialSlides, []);
  assert.deepEqual(children[1].props, {
    groupCompanies: [], news: [], brandCategories: [], brandBrands: [],
  });
  assert.deepEqual(home.preloads, []);
  assert.equal(home.calls.length, 4);
  assert.ok(home.calls.every(([, options]) => (options as { activeOnly: boolean }).activeOnly));
});

test('homepage preserves real content and preloads only its first managed slide', async () => {
  const slide = { ...fixtureSlide, id: 42, imageUrl: '/managed.jpg' };
  const news = [{ ...fixtureNews, id: 42 }];
  const companies = [{ ...fixtureCompany, id: 42 }];
  const portfolio = { categories: [{ id: 42 }], brands: [{ id: 100 }] };
  const home = loadHome({ slides: [slide], news, companies, portfolio });
  const children = (await home.render()).props.children as Element[];
  assert.deepEqual(children[0].props.initialSlides, [slide]);
  assert.deepEqual(children[1].props, {
    groupCompanies: companies, news, brandCategories: portfolio.categories, brandBrands: portfolio.brands,
  });
  assert.equal(home.preloads.length, 3);
  assert.ok(home.preloads.every((args) => (args as unknown[])[0] === '/managed.jpg'));
});

const publicRoutes = [
  ['home-slides', 'getHeroSlides', 'slides'],
  ['home-news', 'getNewsItems', 'news'],
  ['group-companies', 'getGroupCompanies', 'companies'],
  ['brand-portfolio', 'getBrandPortfolio', null],
] as const;

for (const [resource, getter, key] of publicRoutes) {
  test(`${resource}: successful empty public read never returns fixture records`, async () => {
    const calls: unknown[] = [];
    const empty = key ? [] : { categories: [], brands: [] };
    const route = compile(`src/app/api/${resource}/route.ts`, {
      '@/shared/lib/db': { [getter]: async (options: unknown) => { calls.push(options); return empty; } },
      '@/entities/site/model/defaultSlides': { DEFAULT_HERO_SLIDES: [fixtureSlide] },
      '@/entities/site/model/defaultNews': { DEFAULT_NEWS: [fixtureNews] },
      '@/entities/site/model/defaultGroupCompanies': { DEFAULT_GROUP_COMPANIES: [fixtureCompany] },
    });
    const response = await (route.GET as () => Promise<Response>)();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), key ? { [key]: [] } : empty);
    assert.deepEqual(calls, [{ activeOnly: true }]);
  });
}

test('critical slideshow renders nothing for an explicitly empty or unusable managed list', () => {
  const promo = compile('src/widgets/home/sections/MainPromo/MainPromo.tsx', {
    '@/entities/site/model/defaultSlides': { DEFAULT_HERO_SLIDES: [fixtureSlide] },
    './MainPromo.images': { getHeroImagePropsSet: () => { throw new Error('No demo image should be prepared'); } },
    './MainPromoEnhancerLoader': { MainPromoEnhancerLoader: 'enhancer' },
  }).MainPromo as (props: { initialSlides?: unknown[] }) => unknown;
  assert.equal(promo({ initialSlides: [] }), null);
  assert.equal(promo({ initialSlides: [{ ...fixtureSlide, imageUrl: '' }] }), null);
});

test('critical slideshow still supports fixtures when no managed data is supplied', () => {
  const promo = compile('src/widgets/home/sections/MainPromo/MainPromo.tsx', {
    '@/entities/site/model/defaultSlides': { DEFAULT_HERO_SLIDES: [fixtureSlide] },
    './MainPromo.images': {},
    './MainPromoEnhancerLoader': { MainPromoEnhancerLoader: 'enhancer' },
  }).MainPromo as (props: { initialSlides?: unknown[] }) => Element | null;
  assert.equal(promo({})?.type, 'section');
});

test('hydrated slideshow distinguishes absent data from intentionally empty data', () => {
  const fallbackSlides = [{ id: 'demo' }];
  const prepare = compile('src/widgets/home/sections/MainPromo/MainPromo.prepare.ts', {
    './MainPromo.model': { fallbackSlides, mapManagedSlide: (slide: unknown) => slide },
  }).prepareSlides as (slides?: unknown[]) => unknown[];
  assert.deepEqual(prepare([]), []);
  assert.deepEqual(prepare([{ ...fixtureSlide, imageUrl: '' }]), []);
  assert.equal(prepare(), fallbackSlides);
  const managed = { ...fixtureSlide, id: 42 };
  assert.deepEqual(prepare([managed]), [managed]);
});

for (const [filename, getter] of [
  ['slidesRepo', 'getHeroSlides'], ['newsRepo', 'getNewsItems'], ['groupCompaniesRepo', 'getGroupCompanies'],
] as const) {
  test(`${filename}: empty active query remains empty and requires no data writes`, async () => {
    const queries: string[] = [];
    const repo = compile(`src/shared/lib/db/${filename}.ts`, {
      './schema': { ensureSiteSchema: async () => {} },
      './client': { query: async (sql: string) => { queries.push(sql); return { rows: [] }; } },
    });
    assert.deepEqual(await (repo[getter] as (options: unknown) => Promise<unknown>)({ activeOnly: true }), []);
    assert.equal(queries.length, 1);
    assert.match(queries[0], /^select /);
    assert.match(queries[0], /where is_active = true/);
  });
}

for (const [resource, remover] of [
  ['slides', 'deleteHeroSlide'], ['news', 'deleteNewsItem'], ['group-companies', 'deleteGroupCompany'],
  ['brand-categories', 'deleteBrandCategory'], ['brands', 'deleteBrandItem'],
] as const) {
  test(`${resource}: successful deletion invalidates the homepage cache`, async () => {
    const removed: number[] = [];
    const revalidated: string[] = [];
    const route = compile(`src/app/api/admin/${resource}/[id]/route.ts`, {
      'next/cache': { revalidatePath: (path: string) => revalidated.push(path) },
      '@/shared/lib/adminAuth': { requireAdmin: async () => null },
      '@/shared/lib/db': { [remover]: async (id: number) => removed.push(id) },
    });
    const response = await (route.DELETE as (request: Request, context: unknown) => Promise<Response>)(
      new Request(`https://example.test/api/admin/${resource}/42`, { method: 'DELETE' }),
      { params: Promise.resolve({ id: '42' }) },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(removed, [42]);
    assert.deepEqual(revalidated, ['/']);
  });
}
