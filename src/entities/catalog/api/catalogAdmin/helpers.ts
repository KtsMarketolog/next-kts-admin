import type { PoolClient } from 'pg';

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

export function normalizeText(value: unknown, maxLength = 240) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maxLength) : '';
}

export function normalizeCatalogPrice(value: unknown) {
  if (value === null || value === undefined) return null;
  const text = String(value)
    .trim()
    .replace(/\s+/g, '')
    .replace(',', '.')
    .replace(/[^\d.]/g, '');
  if (!text) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < 0 || amount > 999999999) return null;
  return text;
}

export function normalizeStockValue(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim().replace(/\s+/g, '');
  if (!/^\d+$/.test(text)) return null;
  const amount = Number(text);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 999999999) return null;
  return amount;
}

export function slugify(value: string, fallback: string) {
  const transliterated = value
    .toLowerCase()
    .split('')
    .map((char) => CYRILLIC_TO_LATIN[char] ?? char)
    .join('');
  const slug = transliterated
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 76);
  return slug || fallback;
}

export async function uniqueSlug(client: PoolClient, table: 'catalog_categories' | 'catalog_subcategories' | 'catalog_brands' | 'catalog_products', base: string, exceptId?: number) {
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? '' : `-${index + 1}`;
    const candidate = `${base.slice(0, 76 - suffix.length)}${suffix}`;
    const existing = exceptId
      ? await client.query(`select id from ${table} where slug = $1 and id <> $2 limit 1`, [candidate, exceptId])
      : await client.query(`select id from ${table} where slug = $1 limit 1`, [candidate]);
    if (existing.rowCount === 0) return candidate;
  }
  return `${base.slice(0, 60)}-${Date.now().toString(36)}`;
}

export function cacheKey(value: string) {
  return value.trim().toLowerCase();
}
