import {
  MAX_ADMIN_CONTENT_ORDER_ITEMS,
  parseAdminContentOrder,
  type AdminContentOrderItem,
  type AdminContentOrderKind,
} from '../adminContentOrder';
import { withTransaction } from './client';
import { ensureSiteSchema } from './schema';

const orderTables: Record<AdminContentOrderKind, string> = {
  slides: 'hero_slides',
  news: 'news_items',
  'group-companies': 'group_companies',
  'brand-categories': 'brand_categories',
};

export class AdminContentOrderConflictError extends Error {
  readonly code = 'CONTENT_ORDER_CONFLICT';

  constructor() {
    super('Список элементов уже изменён другим пользователем. Обновите список перед перестановкой. Порядок не сохранён.');
    this.name = 'AdminContentOrderConflictError';
  }
}

export async function reorderAdminContent(
  kind: AdminContentOrderKind,
  input: AdminContentOrderItem[],
): Promise<AdminContentOrderItem[]> {
  if (!Object.hasOwn(orderTables, kind)) throw new Error('Unsupported content order kind');
  const table = orderTables[kind];
  const items = parseAdminContentOrder({ items: input });
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    await client.query("set local lock_timeout = '5s'");
    await client.query("set local statement_timeout = '10s'");
    // A row/advisory lock alone cannot serialize inserts/deletes from ordinary CRUD.
    // This short lock still allows public reads and protects the entire membership check.
    await client.query(`lock table ${table} in share row exclusive mode`);
    const existing = await client.query<{ id: string }>(
      `select id from ${table} order by id limit ${MAX_ADMIN_CONTENT_ORDER_ITEMS + 1}`,
    );
    const expectedIds = new Set(items.map((item) => String(item.id)));
    if (existing.rows.length !== items.length || existing.rows.some((row) => !expectedIds.has(String(row.id)))) {
      throw new AdminContentOrderConflictError();
    }
    if (items.length > 0) {
      await client.query(
        `update ${table} as target
         set sort_order = desired.sort_order, updated_at = now()
         from unnest($1::bigint[], $2::integer[]) as desired(id, sort_order)
         where target.id = desired.id and target.sort_order is distinct from desired.sort_order`,
        [items.map((item) => item.id), items.map((item) => item.sortOrder)],
      );
    }
    return items;
  }, { trackCommitOutcome: true });
}
