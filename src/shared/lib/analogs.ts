import rawKnowledgeBase from '@/shared/data/analogs.generated.json';
import { normalizeAnalogBrand } from './analogCatalogMatching';

type SourceId = string;

export type AnalogTechnicalSpecification = {
  label: string;
  value: string;
  unit?: string;
};

type KnowledgeSource = {
  id: SourceId;
  fileName: string;
  label: string;
  kind: 'direct' | 'capacity';
  note?: string;
  tolerancePercent?: number;
};

type DirectItem = {
  brand: string;
  model: string;
  displayName: string;
  aliases: string[];
  sourceRow: number;
  sourceFlagged: boolean;
  metadata: Record<string, unknown>;
};

type DirectGroup = {
  id: string;
  kind: string;
  sourceId: SourceId;
  sourceSheet?: string;
  category: string;
  note?: string;
  items: DirectItem[];
};

type CompressorProduct = {
  brand: string;
  model: string;
  aliases: string[];
  coolingCapacityKw: number;
  rawCoolingCapacity: string;
  sourceRow: number;
  sourceFlagged: boolean;
  refrigerant?: string;
  technicalSpecifications?: AnalogTechnicalSpecification[];
};

type CompressorSeries = {
  id: string;
  kind: 'piston_compressors' | 'scroll_compressors';
  sourceId: SourceId;
  sourceSheet: string;
  category: string;
  refrigerant: string;
  application: string;
  tolerancePercent: number;
  products: CompressorProduct[];
};

type KnowledgeBase = {
  version: number;
  generatedAt: string;
  sources: KnowledgeSource[];
  directGroups: DirectGroup[];
  compressorSeries: CompressorSeries[];
  stats: {
    directGroups: number;
    directItems: number;
    compressorSeries: number;
    compressorItems: number;
    sourceFlaggedItems: number;
  };
};

export type AnalogMatch = {
  brand: string;
  model: string;
  category: string;
  refrigerant: string | null;
  application: string | null;
  coolingCapacityKw: number | null;
  technicalSpecifications?: AnalogTechnicalSpecification[];
  note?: string | null;
  sourceFileName?: string;
  sourceSheet?: string | null;
  sourceRow?: number;
};

export type AnalogResult = {
  id: string;
  brand: string;
  model: string;
  displayName: string;
  category: string;
  sourceId: SourceId;
  sourceLabel: string;
  sourceFileName: string;
  sourceSheet: string | null;
  sourceRow: number;
  note: string | null;
  refrigerant: string | null;
  application: string | null;
  coolingCapacityKw: number | null;
  sourceCoolingCapacityKw: number | null;
  capacityDifferencePercent: number | null;
  tolerancePercent: number | null;
  sourceFlagged: boolean;
  matchType: 'direct' | 'capacity';
  technicalSpecifications: AnalogTechnicalSpecification[];
  catalogAliases?: string[];
};

export type AnalogSearchResponse = {
  query: string;
  normalizedQuery: string;
  refrigerant: string | null;
  sourceBrand?: string | null;
  requiresModelSelection: boolean;
  requiresRefrigerant: boolean;
  availableRefrigerants: string[];
  matches: AnalogMatch[];
  results: AnalogResult[];
  notices: string[];
  total: number;
};

export type PriceListAnalogLink = {
  productId: number;
  groupTitle: string;
  brand: string;
  model: string;
  sourceLabel: string;
};

type PriceListProductInput = {
  id: number;
  title: string;
  sku: string;
  model: string;
  priceGroup: string;
};

export type AnalogCatalogProductInput = {
  title: string;
  sku: string;
  model: string;
  brand?: string;
};

const knowledgeBase = rawKnowledgeBase as unknown as KnowledgeBase;
const sourcesById = new Map(knowledgeBase.sources.map((source) => [source.id, source]));

export const ANALOG_KNOWLEDGE_STATS = knowledgeBase.stats;
export const ANALOG_KNOWLEDGE_GENERATED_AT = knowledgeBase.generatedAt;

export function normalizeAnalogTerm(value: string) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/[ё]/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, '');
}

function normalizeRefrigerant(value: string | null | undefined) {
  const compact = normalizeAnalogTerm(value ?? '').toUpperCase();
  if (!compact) return null;
  if (compact.includes('410')) return 'R410A';
  if (compact.includes('407')) return 'R407C';
  if (compact.includes('404')) return 'R404A';
  if (compact.includes('290')) return 'R290';
  if (compact.includes('134')) return 'R134a';
  if (compact.includes('22')) return 'R22';
  return value?.trim() || null;
}

// Knowledge-base alias arrays are immutable module data. Normalize each once,
// rather than repeating Unicode/case normalization for every catalogue product.
// Weak keys retain no user queries or per-price results.
const normalizedAliasesByList = new WeakMap<string[], string[]>();

function normalizedAliasesFor(aliases: string[]) {
  let normalized = normalizedAliasesByList.get(aliases);
  if (!normalized) {
    normalized = aliases.map(normalizeAnalogTerm).filter(Boolean);
    normalizedAliasesByList.set(aliases, normalized);
  }
  return normalized;
}

function aliasScore(aliases: string[], normalizedQuery: string) {
  const normalizedAliases = normalizedAliasesFor(aliases);
  if (normalizedAliases.some((alias) => alias === normalizedQuery)) return 2;
  if (
    normalizedQuery.length >= 4 &&
    normalizedAliases.some((alias) => alias.includes(normalizedQuery) || normalizedQuery.includes(alias))
  ) {
    return 1;
  }
  return 0;
}

function uniqueBy<T>(items: T[], keyOf: (item: T) => string) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceFor(id: SourceId) {
  const source = sourcesById.get(id);
  if (!source) throw new Error(`Unknown analog source: ${id}`);
  return source;
}

function directSpecifications(item: DirectItem): AnalogTechnicalSpecification[] {
  const specified = item.metadata.technicalSpecifications;
  const specs: AnalogTechnicalSpecification[] = Array.isArray(specified)
    ? specified.filter((value): value is AnalogTechnicalSpecification =>
      value !== null && typeof value === 'object' && typeof value.label === 'string' && typeof value.value === 'string')
    : [];
  if (typeof item.metadata.coolingCapacityW === 'number' && Number.isFinite(item.metadata.coolingCapacityW)
      && !specs.some((spec) => /холодопроизводительность/i.test(spec.label))) {
    specs.push({ label: 'Холодопроизводительность по источнику', value: String(item.metadata.coolingCapacityW), unit: 'Вт' });
  }
  if (Array.isArray(item.metadata.sizes) && item.metadata.sizes.length > 0 && !specs.some((spec) => /размер|присоединени/i.test(spec.label))) {
    specs.push({ label: 'Присоединение по источнику', value: item.metadata.sizes.join(' / ') });
  }
  return specs;
}

function isSpecificDirectItem(group: DirectGroup, item: DirectItem) {
  // These old workbook labels name a component family, not a unique product.
  // Keep the source data intact but do not turn a family into an equivalence.
  return !(group.sourceId === 'sanhua' && /^(?:Переходник под пайку|Клап\.?\s*узел)$/iu.test(item.model.trim()));
}

function buildDirectResults(normalizedQuery: string, requestedBrand: string | null) {
  const matches = knowledgeBase.directGroups.flatMap((group) =>
    group.items
      .filter((item) => isSpecificDirectItem(group, item) && (!requestedBrand || normalizeAnalogBrand(item.brand) === requestedBrand))
      .map((item) => ({ group, item, score: aliasScore(item.aliases, normalizedQuery) }))
      .filter((entry) => entry.score > 0),
  );
  const bestScore = matches.reduce((best, match) => Math.max(best, match.score), 0);
  // A model can occupy many source rows (connections, voltages, operating
  // conditions). Cutting those rows here loses valid catalog candidates later.
  const selectedMatches = matches.filter((match) => match.score === bestScore);
  const results = selectedMatches.flatMap(({ group, item }) => {
    const source = sourceFor(group.sourceId);
    const sourceModel = normalizeAnalogTerm(item.model);
    return group.items
      .filter(
        (candidate) =>
          isSpecificDirectItem(group, candidate) && (normalizeAnalogTerm(candidate.model) !== sourceModel ||
          normalizeAnalogBrand(candidate.brand) !== normalizeAnalogBrand(item.brand)),
      )
      .map<AnalogResult>((candidate) => ({
        id: `${group.id}:${candidate.brand}:${candidate.model}`,
        brand: candidate.brand,
        model: candidate.model,
        displayName: candidate.displayName,
        category: group.category,
        sourceId: group.sourceId,
        sourceLabel: source.label,
        sourceFileName: source.fileName,
        sourceSheet: group.sourceSheet ?? null,
        sourceRow: candidate.sourceRow,
        note: group.note || source.note || null,
        refrigerant: null,
        application: null,
        coolingCapacityKw: null,
        sourceCoolingCapacityKw: null,
        capacityDifferencePercent: null,
        tolerancePercent: null,
        sourceFlagged: candidate.sourceFlagged,
        matchType: 'direct',
        technicalSpecifications: directSpecifications(candidate),
        catalogAliases: Array.isArray(candidate.metadata.catalogAliases)
          ? candidate.metadata.catalogAliases.filter((value): value is string => typeof value === 'string') : [],
      }));
  });

  return {
    matches: selectedMatches.map<AnalogMatch>(({ group, item }) => ({
      brand: item.brand,
      model: item.model,
      category: group.category,
      refrigerant: null,
      application: null,
      coolingCapacityKw: null,
      technicalSpecifications: directSpecifications(item),
      note: group.note || sourceFor(group.sourceId).note || null,
      sourceFileName: sourceFor(group.sourceId).fileName,
      sourceSheet: group.sourceSheet ?? null,
      sourceRow: item.sourceRow,
    })),
    results,
  };
}

function buildCapacityResults(normalizedQuery: string, requestedRefrigerant: string | null, requestedBrand: string | null) {
  const matches = knowledgeBase.compressorSeries.flatMap((series) =>
    series.products
      .filter((product) => !requestedBrand || normalizeAnalogBrand(product.brand) === requestedBrand)
      .map((product) => ({ series, product, score: aliasScore(product.aliases, normalizedQuery) }))
      .filter((entry) => entry.score > 0),
  );
  const bestScore = matches.reduce((best, match) => Math.max(best, match.score), 0);
  const bestMatches = matches.filter((match) => match.score === bestScore);
  const availableRefrigerants = Array.from(
    new Set(bestMatches.map(({ series, product }) => normalizeRefrigerant(product.refrigerant || series.refrigerant)).filter(Boolean)),
  ) as string[];
  const requiresRefrigerant = availableRefrigerants.length > 1 && !requestedRefrigerant;
  const selectedMatches = bestMatches
    .filter(({ series, product }) => {
      if (!requestedRefrigerant) return !requiresRefrigerant;
      return normalizeRefrigerant(product.refrigerant || series.refrigerant) === requestedRefrigerant;
    });

  const results = selectedMatches.flatMap(({ series, product }) => {
    const source = sourceFor(series.sourceId);
    const sourceModel = normalizeAnalogTerm(product.model);
    return series.products
      .filter((candidate) => {
        if (
          normalizeAnalogTerm(candidate.model) === sourceModel &&
          normalizeAnalogBrand(candidate.brand) === normalizeAnalogBrand(product.brand)
        ) {
          return false;
        }
        const difference = Math.abs(((candidate.coolingCapacityKw - product.coolingCapacityKw) / product.coolingCapacityKw) * 100);
        return difference <= series.tolerancePercent + Number.EPSILON;
      })
      .map<AnalogResult>((candidate) => ({
        id: `${series.id}:${product.brand}:${product.model}:${product.sourceRow}:${candidate.brand}:${candidate.model}:${candidate.sourceRow}`,
        brand: candidate.brand,
        model: candidate.model,
        displayName: `${candidate.brand} ${candidate.model}`,
        category: series.category,
        sourceId: series.sourceId,
        sourceLabel: source.label,
        sourceFileName: source.fileName,
        sourceSheet: series.sourceSheet,
        sourceRow: candidate.sourceRow,
        note: source.note || null,
        refrigerant: normalizeRefrigerant(candidate.refrigerant || series.refrigerant),
        application: series.application,
        coolingCapacityKw: candidate.coolingCapacityKw,
        sourceCoolingCapacityKw: product.coolingCapacityKw,
        capacityDifferencePercent: ((candidate.coolingCapacityKw - product.coolingCapacityKw) / product.coolingCapacityKw) * 100,
        tolerancePercent: series.tolerancePercent,
        sourceFlagged: candidate.sourceFlagged,
        matchType: 'capacity',
        technicalSpecifications: [
          { label: 'Хладагент', value: normalizeRefrigerant(candidate.refrigerant || series.refrigerant) ?? 'Не указан' },
          { label: 'Режим по источнику', value: series.application },
          ...(candidate.technicalSpecifications ?? []),
        ],
      }));
  });

  return {
    availableRefrigerants,
    requiresRefrigerant,
    matches: selectedMatches.map<AnalogMatch>(({ series, product }) => ({
      brand: product.brand,
      model: product.model,
      category: series.category,
      refrigerant: normalizeRefrigerant(product.refrigerant || series.refrigerant),
      application: series.application,
      coolingCapacityKw: product.coolingCapacityKw,
      technicalSpecifications: product.technicalSpecifications ?? [],
      note: sourceFor(series.sourceId).note ?? null,
      sourceFileName: sourceFor(series.sourceId).fileName,
      sourceSheet: series.sourceSheet,
      sourceRow: product.sourceRow,
    })),
    results,
  };
}

export function searchAnalogs(query: string, refrigerant?: string | null, sourceBrand?: string | null): AnalogSearchResponse {
  const cleanQuery = query.trim().slice(0, 180);
  const normalizedQuery = normalizeAnalogTerm(cleanQuery);
  const requestedRefrigerant = normalizeRefrigerant(refrigerant);
  const requestedBrand = normalizeAnalogBrand((sourceBrand ?? '').trim().slice(0, 120)) || null;
  if (normalizedQuery.length < 2) {
    return {
      query: cleanQuery,
      normalizedQuery,
      refrigerant: requestedRefrigerant,
      sourceBrand: requestedBrand,
      requiresModelSelection: false,
      requiresRefrigerant: false,
      availableRefrigerants: [],
      matches: [],
      results: [],
      notices: [],
      total: 0,
    };
  }

  const direct = buildDirectResults(normalizedQuery, requestedBrand);
  const capacity = buildCapacityResults(normalizedQuery, requestedRefrigerant, requestedBrand);
  const results = uniqueBy([...direct.results, ...capacity.results], (result) => JSON.stringify([
    result.sourceId, result.sourceSheet, result.sourceRow, normalizeAnalogTerm(result.brand), normalizeAnalogTerm(result.model),
    result.refrigerant, result.application, result.technicalSpecifications,
  ]))
    .sort((first, second) => {
      if (first.sourceFlagged !== second.sourceFlagged) return first.sourceFlagged ? 1 : -1;
      const firstDifference = Math.abs(first.capacityDifferencePercent ?? 0);
      const secondDifference = Math.abs(second.capacityDifferencePercent ?? 0);
      return firstDifference - secondDifference || first.brand.localeCompare(second.brand, 'ru') || first.model.localeCompare(second.model, 'ru');
    });
  const notices = Array.from(new Set(results.map((result) => result.note).filter(Boolean))) as string[];
  const matches = uniqueBy([...direct.matches, ...capacity.matches], (match) => JSON.stringify([
    match.brand, normalizeAnalogTerm(match.model), match.refrigerant, match.application,
    match.sourceFileName, match.sourceSheet, match.sourceRow, match.technicalSpecifications,
  ]));
  const matchedModels = uniqueBy(matches, (match) => `${normalizeAnalogBrand(match.brand)}:${normalizeAnalogTerm(match.model)}`);
  const requiresModelSelection = matchedModels.length > 1;
  const visibleResults = requiresModelSelection ? [] : results;

  return {
    query: cleanQuery,
    normalizedQuery,
    refrigerant: requestedRefrigerant,
    sourceBrand: requestedBrand,
    requiresModelSelection,
    requiresRefrigerant: capacity.requiresRefrigerant,
    availableRefrigerants: capacity.availableRefrigerants.sort(),
    matches,
    results: visibleResults,
    notices: requiresModelSelection ? [] : notices,
    total: visibleResults.length,
  };
}

/** Explicit source rows only. The server must intersect these with the active catalogue. */
export function getSanhuaKnowledgeCandidates(): AnalogResult[] {
  return uniqueBy(knowledgeBase.directGroups.filter((group) => group.kind === 'sanhua').flatMap((group) =>
    group.items.filter((item) => /^sanhua(?:\s|$)/i.test(item.brand)).map((item) => ({
      id: `${group.id}:${item.brand}:${item.model}`,
      brand: item.brand, model: item.model, displayName: item.displayName, category: group.category,
      sourceId: group.sourceId, sourceLabel: sourceFor(group.sourceId).label,
      sourceFileName: sourceFor(group.sourceId).fileName, sourceSheet: group.sourceSheet ?? null,
      sourceRow: item.sourceRow, note: group.note || sourceFor(group.sourceId).note || null,
      refrigerant: null, application: null, coolingCapacityKw: null, sourceCoolingCapacityKw: null,
      capacityDifferencePercent: null, tolerancePercent: null, sourceFlagged: item.sourceFlagged,
      matchType: 'direct' as const, technicalSpecifications: directSpecifications(item),
      catalogAliases: Array.isArray(item.metadata.catalogAliases)
        ? item.metadata.catalogAliases.filter((value): value is string => typeof value === 'string') : [],
    }))), (item) => [item.brand, item.model, item.sourceRow, item.sourceId].join(':'));
}

export function searchAnalogsForCatalogProduct(
  query: string,
  product: AnalogCatalogProductInput,
  refrigerant?: string | null,
  sourceBrand?: string | null,
): AnalogSearchResponse {
  const cleanQuery = query.trim().slice(0, 180);
  const normalizedQuery = normalizeAnalogTerm(cleanQuery);
  const productTerms = Array.from(
    new Set([product.title, product.model, product.sku].map(normalizeAnalogTerm).filter((term) => term.length >= 2)),
  );
  const requestedBrand = sourceBrand || product.brand;
  const directSearch = searchAnalogs(cleanQuery, refrigerant, requestedBrand);
  const candidateMatches = uniqueBy(
    [directSearch, ...productTerms.map((term) => searchAnalogs(term, refrigerant, requestedBrand))].flatMap((search) => search.matches),
    (match) => [normalizeAnalogTerm(match.brand), normalizeAnalogTerm(match.model)].join(':'),
  );
  const specificCandidateMatches = candidateMatches.filter((candidate) => {
    const candidateBrand = normalizeAnalogTerm(candidate.brand);
    const candidateModel = normalizeAnalogTerm(candidate.model);

    return !candidateMatches.some((other) => {
      const otherModel = normalizeAnalogTerm(other.model);
      return (
        normalizeAnalogTerm(other.brand) === candidateBrand &&
        otherModel.length > candidateModel.length &&
        otherModel.startsWith(candidateModel) &&
        productTerms.some((term) => term.includes(otherModel))
      );
    });
  });

  const rankedMatches = specificCandidateMatches
    .map((match) => {
      const modelTerm = normalizeAnalogTerm(match.model);
      const score = productTerms.reduce((best, productTerm) => {
        if (productTerm === modelTerm) return Math.max(best, 3);
        if (productTerm.includes(modelTerm)) return Math.max(best, 2);
        if (productTerm.length >= 4 && modelTerm.includes(productTerm)) return Math.max(best, 1);
        return best;
      }, 0);
      return { match, score };
    })
    .filter(({ score }) => score > 0)
    .sort((first, second) => second.score - first.score);
  const bestScore = rankedMatches[0]?.score ?? 0;
  const bestMatches = rankedMatches.filter(({ score }) => score === bestScore);

  if (bestScore < 2 || bestMatches.length !== 1) return directSearch;

  const resolvedSearch = searchAnalogs(bestMatches[0].match.model, refrigerant, bestMatches[0].match.brand);
  return {
    ...resolvedSearch,
    query: cleanQuery,
    normalizedQuery,
  };
}

export function buildPriceListAnalogLinks(products: PriceListProductInput[]) {
  const productsByTerm = new Map<string, PriceListProductInput[]>();
  for (const product of products) {
    for (const value of [product.model, product.sku, product.title]) {
      const key = normalizeAnalogTerm(value);
      if (!key) continue;
      const existing = productsByTerm.get(key) ?? [];
      existing.push(product);
      productsByTerm.set(key, existing);
    }
  }

  const linksByProductId = new Map<number, PriceListAnalogLink[]>();
  for (const product of products) {
    const results = uniqueBy(
      [product.model, product.sku]
        .filter(Boolean)
        .flatMap((term) => {
          const initial = searchAnalogs(term);
          if (!initial.requiresRefrigerant) return initial.results;
          return initial.availableRefrigerants.flatMap((refrigerant) => searchAnalogs(term, refrigerant).results);
        }),
      (result) => normalizeAnalogTerm(result.model),
    );
    const links = uniqueBy(
      results.flatMap((result) =>
        (productsByTerm.get(normalizeAnalogTerm(result.model)) ?? [])
          .filter((candidate) => candidate.id !== product.id)
          .map<PriceListAnalogLink>((candidate) => ({
            productId: candidate.id,
            groupTitle: candidate.priceGroup,
            brand: result.brand,
            model: result.model,
            sourceLabel: result.sourceLabel,
          })),
      ),
      (link) => String(link.productId),
    ).slice(0, 12);
    if (links.length > 0) linksByProductId.set(product.id, links);
  }
  return linksByProductId;
}
