/** Catalog identities are deliberately separate from engineering equivalence. */
export type AnalogCatalogIdentity = {
  id: number;
  title: string;
  sku: string;
  model: string;
  brand: string;
};

export type AnalogCatalogCandidate = { brand: string; model: string; aliases?: readonly string[] };
export type AnalogCatalogMatch<T> = { product: T; matchedBy: 'model' | 'sku' | 'title'; matchKind: 'exact' | 'normalized-span' };

function normalize(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '');
}

export function normalizeAnalogBrand(value: string) {
  const key = normalize(value);
  const aliases: Record<string, string> = {
    sanhuaновая: 'sanhua', sanhuaстарая: 'sanhua', санхуа: 'sanhua',
    becool: 'becool', спсbecool: 'becool', ридан: 'ridan',
    'сopeland': 'copeland', copelandliquidinjection: 'copeland', copelandvaporinjection: 'copeland',
    invotechliquidinjection: 'invotech', invotechvaporinjection: 'invotech',
    weishansliquidinjection: 'weishans', weishansvaporinjection: 'weishans',
    ebmpapst: 'ebm',
  };
  return aliases[key] ?? key;
}

type SearchText = { text: string; key: string; offsets: number[] };
function searchText(value: string): SearchText {
  const text = value.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
  const offsets: number[] = [];
  let key = '';
  for (let index = 0; index < text.length; index++) {
    if (/[a-zа-я0-9]/.test(text[index])) { key += text[index]; offsets.push(index); }
  }
  return { text, key, offsets };
}

// Ignore formatting INSIDE a complete model, not extra suffixes or digits.
// The original offsets distinguish "CLX.2 104L..." from "CLX.20"/"CLX.2-A".
function completeSpan(field: SearchText, key: string) {
  if (key.length < 4) return false;
  let from = 0;
  while (from < field.key.length) {
    const index = field.key.indexOf(key, from);
    if (index < 0) return false;
    const start = field.offsets[index];
    const end = field.offsets[index + key.length - 1] + 1;
    const before = field.text.slice(0, start);
    const after = field.text.slice(end);
    if (!/[a-zа-я0-9]$/.test(before) && !/^[a-zа-я0-9]/.test(after)
      && !/[a-zа-я0-9][./_+\-]$/.test(before) && !/^[./_+\-][a-zа-я0-9]/.test(after)) return true;
    from = index + 1;
  }
  return false;
}

function hasModelExtension(field: SearchText, key: string) {
  if (key.length < 4) return false;
  let from = 0;
  while (from < field.key.length) {
    const index = field.key.indexOf(key, from);
    if (index < 0) return false;
    const start = field.offsets[index];
    const end = field.offsets[index + key.length - 1] + 1;
    const before = field.text.slice(0, start);
    const after = field.text.slice(end);
    if (!/[a-zа-я0-9]$/.test(before) && !/[a-zа-я0-9][./_+\-]$/.test(before)
      && /^(?:[a-zа-я0-9]|[./_+\-][a-zа-я0-9])/.test(after)) return true;
    from = index + 1;
  }
  return false;
}

type IndexedProduct<T> = {
  product: T;
  fields: Record<'model' | 'sku' | 'title', SearchText>;
  identityTitle: SearchText;
};
export type AnalogCatalogIndex<T extends AnalogCatalogIdentity = AnalogCatalogIdentity> = {
  entries: IndexedProduct<T>[];
  byBrand: Map<string, IndexedProduct<T>[]>;
};

export function createAnalogCatalogIndex<T extends AnalogCatalogIdentity>(products: readonly T[]): AnalogCatalogIndex<T> {
  const entries = products.map((product) => ({
    product, fields: { model: searchText(product.model), sku: searchText(product.sku), title: searchText(product.title) },
    // Parentheses often list replacements, not the identity of the item sold.
    // Only explicit source manufacturer-code aliases may use that suffix.
    identityTitle: searchText(product.title.split('(')[0]),
  }));
  const byBrand = new Map<string, IndexedProduct<T>[]>();
  for (const entry of entries) {
    const brand = normalizeAnalogBrand(entry.product.brand);
    if (!brand) continue; // An unknown brand cannot establish safe identity.
    const bucket = byBrand.get(brand) ?? [];
    bucket.push(entry);
    byBrand.set(brand, bucket);
  }
  return { entries, byBrand };
}

function matchEntry<T extends AnalogCatalogIdentity>(entry: IndexedProduct<T>, keys: readonly string[], allowTitleReferences = false) {
  const title = allowTitleReferences ? entry.fields.title : entry.identityTitle;
  for (const matchedBy of ['model', 'sku', 'title'] as const) {
    const field = matchedBy === 'title' ? title : entry.fields[matchedBy];
    if (keys.includes(field.key)) {
      if (matchedBy === 'model' && hasModelExtension(entry.identityTitle, field.key)) continue;
      return { product: entry.product, matchedBy, matchKind: 'exact' as const };
    }
  }
  for (const matchedBy of ['model', 'title'] as const) {
    const field = matchedBy === 'title' ? title : entry.fields[matchedBy];
    if (keys.some((key) => completeSpan(field, key) && (matchedBy !== 'model' || !hasModelExtension(entry.identityTitle, key)))) {
      return { product: entry.product, matchedBy, matchKind: 'normalized-span' as const };
    }
  }
  return null;
}

export function matchAnalogCatalogProducts<T extends AnalogCatalogIdentity>(
  candidate: AnalogCatalogCandidate, index: AnalogCatalogIndex<T>,
): AnalogCatalogMatch<T>[] {
  const brand = normalizeAnalogBrand(candidate.brand);
  if (!brand) return [];
  const modelKey = normalize(candidate.model);
  const aliases = Array.from(new Set((candidate.aliases ?? []).map(normalize).filter((key) => key.length >= 2 && key !== modelKey)));
  if (modelKey.length < 2 && aliases.length === 0) return [];
  return (index.byBrand.get(brand) ?? []).flatMap((entry) => {
    const match = (modelKey.length >= 2 ? matchEntry(entry, [modelKey]) : null) ?? matchEntry(entry, aliases, true);
    return match ? [match] : [];
  });
}

/** Resolve the user's own catalog SKU/title; unlike results this may search any brand. */
export function findCatalogSearchProducts<T extends AnalogCatalogIdentity>(query: string, index: AnalogCatalogIndex<T>): T[] {
  const key = normalize(query);
  if (key.length < 2) return [];
  const matches = index.entries.flatMap((entry) => {
    const match = matchEntry(entry, [key], true);
    if (!match) return [];
    const score = match.matchKind === 'exact' ? (match.matchedBy === 'sku' ? 3 : 2) : 1;
    return [{ product: match.product, score }];
  });
  const best = matches.reduce((score, match) => Math.max(score, match.score), 0);
  // Do not truncate ambiguous matches into an apparently unique match.
  return matches.filter((match) => match.score === best).map((match) => match.product);
}
