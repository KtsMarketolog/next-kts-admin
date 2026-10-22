import { catalogArticleKey, normalizeCatalogArticle } from './catalogAdmin/helpers';
import type { CatalogProductInput } from './catalogAdmin/types';

const MAX_DUPLICATE_GROUPS = 100;
const MAX_DUPLICATE_ROWS = 100;
const sourceRows = new WeakMap<CatalogProductInput, number>();

export type CatalogImportDuplicate = {
  article: string;
  rows: number[];
  totalRows: number;
};

// Keep worksheet coordinates out of product data and persistence. In particular,
// filtering blank worksheet rows must not renumber the rows shown to the user.
export function setCatalogImportSourceRow<T extends CatalogProductInput>(input: T, rowNumber: number): T {
  if (!Number.isSafeInteger(rowNumber) || rowNumber < 1) {
    throw new Error('Некорректный номер строки каталога');
  }
  sourceRows.set(input, rowNumber);
  return input;
}

function duplicateMessage(duplicates: CatalogImportDuplicate[], duplicateCount: number) {
  const examples = duplicates.slice(0, 3).map(({ article, rows, totalRows }) => {
    const visibleRows = rows.slice(0, 10);
    const rowList = visibleRows.length === 2 ? visibleRows.join(' и ') : visibleRows.join(', ');
    const remainder = totalRows > visibleRows.length ? ` (всего строк: ${totalRows})` : '';
    return `Артикул «${article}» повторяется в строках ${rowList}${remainder}.`;
  });
  if (duplicateCount > examples.length) examples.push(`Всего повторяющихся артикулов: ${duplicateCount}.`);
  return `${examples.join(' ')} Исправьте файл: каждому артикулу должен соответствовать один товар независимо от бренда. Каталог не изменён.`;
}

export class CatalogImportDuplicateError extends Error {
  readonly code = 'CATALOG_DUPLICATE_ARTICLES';
  readonly duplicates: CatalogImportDuplicate[];
  /** Number of conflicting articles, including groups omitted from the details. */
  readonly duplicateCount: number;
  readonly truncated: boolean;

  constructor(duplicates: CatalogImportDuplicate[], duplicateCount: number, truncated: boolean) {
    super(duplicateMessage(duplicates, duplicateCount));
    this.name = 'CatalogImportDuplicateError';
    this.duplicates = duplicates;
    this.duplicateCount = duplicateCount;
    this.truncated = truncated;
  }
}

export function assertUniqueCatalogArticles(rows: CatalogProductInput[]): void {
  const groups = new Map<string, CatalogImportDuplicate>();
  for (let index = 0; index < rows.length; index += 1) {
    const input = rows[index];
    // Use exactly the persisted article normalization, including its length cap.
    // Do not convert numeric-looking strings: "0012" and "12" are distinct.
    const article = normalizeCatalogArticle(input.article).trim();
    const key = catalogArticleKey(article);
    if (!key) continue;
    const rowNumber = sourceRows.get(input) ?? index + 1;
    const group = groups.get(key);
    if (group) {
      group.totalRows += 1;
      if (group.rows.length < MAX_DUPLICATE_ROWS) group.rows.push(rowNumber);
    } else {
      groups.set(key, { article, rows: [rowNumber], totalRows: 1 });
    }
  }

  const duplicates: CatalogImportDuplicate[] = [];
  let duplicateCount = 0;
  let truncated = false;
  for (const group of groups.values()) {
    if (group.totalRows < 2) continue;
    duplicateCount += 1;
    if (group.totalRows > MAX_DUPLICATE_ROWS) truncated = true;
    if (duplicates.length < MAX_DUPLICATE_GROUPS) duplicates.push(group);
    else truncated = true;
  }
  if (duplicateCount > 0) throw new CatalogImportDuplicateError(duplicates, duplicateCount, truncated);
}
