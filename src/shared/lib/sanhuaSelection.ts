/** Reference-table filtering only. This module does not decode models or size equipment. */
export type SanhuaSpecification = { label: string; value: string; unit?: string };

export type SanhuaCatalogMatch = {
  productId: number;
  title: string;
  sku: string;
  model: string;
  stock: number;
  stockMoscow: number;
  stockVolzhsk: number;
  unit: string;
  isExpected: boolean;
};

export type SanhuaSelectionCandidate = {
  id: string;
  brand: string;
  model: string;
  category: string;
  sourceFlagged: boolean;
  technicalSpecifications: SanhuaSpecification[];
  sourceLabel: string;
  sourceFileName: string;
  sourceSheet: string | null;
  sourceRow: number;
  note: string | null;
  catalogMatches: SanhuaCatalogMatch[];
};

export const SANHUA_SELECTION_FAMILIES = [
  {
    id: 'check-valves', category: 'Обратные клапаны',
    checklist: [
      'Сверьте прямое или угловое исполнение и направление потока.',
      'Проверьте обычную или усиленную пружину и место установки. Смена пружины требует расчёта специалиста.',
    ],
    missing: 'Нужны размеры угловых моделей, полная таблица исполнений и условия допустимой замены пружины.',
  },
  {
    id: 'ball-valves', category: 'Шаровые вентили',
    checklist: [
      'Проверьте, нужен ли сервисный штуцер: вариант без него не считается автоматической заменой.',
      'При переходе SBV → GBV сверяйте конкретные модели и присоединение, а не только название серии.',
    ],
    missing: 'Нужны подтверждённые пары SBV → GBV и полная таблица размеров, соединений и сервисного штуцера.',
  },
  {
    id: 'solenoid-valves', category: 'Соленоидные вентили',
    checklist: [
      'Проверьте нормально закрытое или нормально открытое исполнение, проходное сечение и соединение.',
      'Катушка подбирается отдельно: проверьте совместимость с клапаном, напряжение и AC/DC.',
      'Меньшее проходное сечение допустимо только после расчёта специалиста.',
    ],
    missing: 'Нужны состояние NC/NO, проходное сечение и матрица совместимых катушек. Уточнить A03/B03 и напряжение MQ-A0322G: в методике 220 V, в таблице 230 V.',
  },
  {
    id: 'sight-glasses', category: 'Смотровые стекла',
    checklist: [
      'Сверьте пайку или резьбу и исполнение соединений: «мама-мама», «папа-папа» или «мама-папа».',
      'Для резьбового соединения проверьте, нужны ли отдельные гайки и какой у них размер.',
    ],
    missing: 'Нужны полные сведения о пайке/резьбе для каждой модели и таблица соответствующих гаек.',
  },
  {
    id: 'filter-driers', category: 'Фильтры-осушители',
    checklist: [
      'Сверьте тип сердечника, корпус, размер и способ присоединения.',
      'Изменение корпуса не применяется автоматически. Уменьшение корпуса требует расчёта специалиста.',
    ],
    missing: 'Нужны явные размеры соединений, типы сердечников и корпуса по каждой модели. Устранить расхождения E/F между моделью и наименованием.',
  },
] as const;

export type SanhuaFamilyId = (typeof SANHUA_SELECTION_FAMILIES)[number]['id'];

export const SANHUA_INCOMPLETE_BLOCKS = [
  {
    category: 'Фильтры разборные',
    missing: 'В методике есть только заголовок о твёрдых сердечниках. Нужны модели корпусов и сердечников, размеры и совместимость. В пошаговый подбор не включены.',
  },
  {
    category: 'ТРВ',
    missing: 'Нужны режимы и таблицы производительности, подбор вставок и адаптеров, подтверждение хладагентов; уточнить RFKD/RFGD. Расчётный подбор в сервис не включён.',
  },
] as const;

const sizeLabels = new Set(['Размер (дюймы)', 'Размер (метрика)']);
const executionLabel = 'Соединение / исполнение';

function hasValue(value: string) {
  return Boolean(value.trim()) && !/^(?:-|—|нет|н\/д|не указано)$/iu.test(value.trim());
}

export function sanhuaSpecificationKey(specification: SanhuaSpecification) {
  return JSON.stringify([specification.label, specification.value, specification.unit ?? '']);
}

export function formatSanhuaSpecification(specification: SanhuaSpecification) {
  return `${specification.value}${specification.unit ? ` ${specification.unit}` : ''}`;
}

export function getSanhuaSizes(candidate: SanhuaSelectionCandidate) {
  return candidate.technicalSpecifications.filter((specification) => sizeLabels.has(specification.label) && hasValue(specification.value));
}

export function getSanhuaExecution(candidate: SanhuaSelectionCandidate) {
  return candidate.technicalSpecifications.find((specification) => specification.label === executionLabel && hasValue(specification.value))?.value ?? null;
}

/** Incomplete and contradictory rows remain outside this guided reference UI. */
export function getSanhuaEligibleCandidates(candidates: readonly SanhuaSelectionCandidate[]) {
  // Compare explicit fields across all rows of the same model before excluding
  // incomplete rows. Otherwise a partial conflicting row could be overlooked.
  const valuesByModel = new Map<string, Map<string, string>>();
  const conflictingModels = new Set<string>();
  for (const candidate of candidates) {
    if (!/^sanhua(?:\s|$)/iu.test(candidate.brand.trim())) continue;
    const model = normalizeLookup(candidate.model);
    const fields = valuesByModel.get(model) ?? new Map<string, string>();
    valuesByModel.set(model, fields);
    for (const spec of candidate.technicalSpecifications) {
      if ((!sizeLabels.has(spec.label) && spec.label !== executionLabel) || !hasValue(spec.value)) continue;
      const value = JSON.stringify([spec.value.trim(), spec.unit ?? '']);
      const previous = fields.get(spec.label);
      if (previous !== undefined && previous !== value) conflictingModels.add(model);
      fields.set(spec.label, value);
    }
  }
  return candidates.filter((candidate) => {
    if (candidate.sourceFlagged || !/^sanhua(?:\s|$)/iu.test(candidate.brand.trim()) || !hasValue(candidate.model)) return false;
    if (conflictingModels.has(normalizeLookup(candidate.model))) return false;
    if (!SANHUA_SELECTION_FAMILIES.some((family) => family.category === candidate.category)) return false;
    if (!candidate.catalogMatches.some((match) => Number.isInteger(match.productId) && match.productId > 0)) return false;
    if (!getSanhuaSizes(candidate).length || !getSanhuaExecution(candidate)) return false;
    return true;
  });
}

export function getSanhuaTableOptions(candidates: readonly SanhuaSelectionCandidate[], familyId: string) {
  const category = SANHUA_SELECTION_FAMILIES.find((family) => family.id === familyId)?.category;
  const familyCandidates = getSanhuaEligibleCandidates(candidates).filter((candidate) => candidate.category === category);
  const sizes = new Map<string, SanhuaSpecification>();
  const executions = new Set<string>();
  for (const candidate of familyCandidates) {
    for (const size of getSanhuaSizes(candidate)) sizes.set(sanhuaSpecificationKey(size), size);
    executions.add(getSanhuaExecution(candidate)!);
  }
  return {
    sizes: [...sizes].map(([value, specification]) => ({ value, label: formatSanhuaSpecification(specification) })),
    executions: [...executions].sort((a, b) => a.localeCompare(b, 'ru')),
    count: familyCandidates.length,
  };
}

function normalizeLookup(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/[^a-zа-яё0-9]/gu, '');
}

export function filterSanhuaCandidates(
  candidates: readonly SanhuaSelectionCandidate[],
  filters: { familyId: string; size?: string; execution?: string; query?: string },
) {
  const category = SANHUA_SELECTION_FAMILIES.find((family) => family.id === filters.familyId)?.category;
  if (!category) return [];
  const query = normalizeLookup(filters.query ?? '');
  return getSanhuaEligibleCandidates(candidates).filter((candidate) => {
    if (candidate.category !== category) return false;
    if (filters.size && !getSanhuaSizes(candidate).some((size) => sanhuaSpecificationKey(size) === filters.size)) return false;
    if (filters.execution && getSanhuaExecution(candidate) !== filters.execution) return false;
    if (!query) return true;
    return [candidate.model, ...candidate.catalogMatches.flatMap((match) => [match.title, match.model, match.sku])]
      .some((value) => normalizeLookup(value).includes(query));
  });
}
