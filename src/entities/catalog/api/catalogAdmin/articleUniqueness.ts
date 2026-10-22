import type { PoolClient } from 'pg';
import { catalogArticleKey, normalizeCatalogArticle } from './helpers';

export class CatalogArticleConflictError extends Error {
  readonly code = 'CATALOG_ARTICLE_CONFLICT';

  constructor(article: string) {
    super(`Товар с артикулом «${normalizeCatalogArticle(article)}» уже есть в каталоге (в том числе среди неактивных). Каждому артикулу должен соответствовать один товар независимо от бренда. Изменения не сохранены.`);
    this.name = 'CatalogArticleConflictError';
  }
}

/** Must run under withCatalogStockWrite, before any product or related entity write. */
export async function assertCatalogArticleAvailable(client: PoolClient, article: string, exceptId?: number) {
  const key = catalogArticleKey(article);
  if (!key) throw new Error('Артикул товара обязателен');
  // Read only identities, without wholesale joins or product payloads. Normalize
  // in JS just like Excel: SQL lower/whitespace rules vary with DB collation and
  // can disagree for Unicode or legacy unnormalized articles. The shared writer
  // lock covers this check and the write, including concurrent Excel imports.
  const existing = await client.query<{ id: string; article: string | null }>(
    `select id::text, article from catalog_products
     where ($1::bigint is null or id <> $1)`,
    [exceptId ?? null],
  );
  if (existing.rows.some(row => catalogArticleKey(row.article) === key)) {
    throw new CatalogArticleConflictError(article);
  }
}
