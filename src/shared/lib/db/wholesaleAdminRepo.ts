import type { AdminSession } from '@/shared/lib/adminAuth';

import { query } from './client';
import { ensureSiteSchema } from './schema';

export type WholesaleManager = {
  id: number;
  name: string;
  login: string;
  email: string;
  isActive: boolean;
  priceListCount: number;
  lastChangedAt: string | null;
  lastChangedPriceTitle: string | null;
};

export type WholesaleManagerAuth = {
  id: number;
  login: string;
  passwordHash: string;
  isActive: boolean;
};

export type WholesaleManagerProfile = {
  id: number;
  name: string;
  login: string;
  email: string;
  isActive: boolean;
};

export type WholesalePriceListSummary = {
  id: number;
  title: string;
  clientName: string;
  token: string;
  validUntil: string | null;
  showRetailPrices: boolean;
  isActive: boolean;
  managerId: number | null;
  managerName: string | null;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  lastChangedAt: string | null;
  lastChangedTitle: string | null;
  lastChangedByName: string | null;
};

export type WholesaleCatalogVariant = {
  id: number | null;
  title: string;
  retailPrice: string | null;
  wholesalePrice: string | null;
};

export type WholesaleCatalogProduct = {
  id: number;
  title: string;
  sku: string;
  description: string;
  imageUrl: string | null;
  variants: WholesaleCatalogVariant[];
};

export type WholesaleCatalogCategory = {
  id: number;
  title: string;
  products: WholesaleCatalogProduct[];
};

export type WholesalePriceListItemInput = {
  productId: number;
  variantId: number | null;
  customWholesalePrice: string | null;
  visible: boolean;
  sortOrder: number;
};

export type WholesalePriceListEditor = {
  id: number;
  title: string;
  clientName: string;
  token: string;
  validUntil: string | null;
  comment: string;
  showRetailPrices: boolean;
  isActive: boolean;
  managerId: number | null;
  items: WholesalePriceListItemInput[];
};

export type WholesaleManagerAnalyticsPeriod = '7d' | '30d' | 'all';

export type WholesaleManagerAnalytics = {
  manager: {
    id: number;
    name: string;
    login: string;
    email: string;
    role: string;
    lastLoginAt: string | null;
  };
  summary: {
    totalPrices: number;
    activePrices: number;
    expiredPrices: number;
    pricesLast7Days: number;
    pricesLast30Days: number;
    periodPrices: number;
    averageItemsPerPrice: number;
    emptyPrices: number;
    pricesWithoutClient: number;
    pricesWithoutExpiration: number;
  };
  lastCreatedPrice: {
    id: number;
    title: string;
    createdAt: string;
  } | null;
  lastChange: WholesaleManagerAnalyticsChange | null;
  problemPrices: WholesaleManagerAnalyticsProblemPrice[];
  recentChanges: WholesaleManagerAnalyticsChange[];
  publicViews: {
    total: number;
    last7Days: number;
    last30Days: number;
    periodViews: number;
    lastViewAt: string | null;
    topPrices: Array<{
      priceId: number;
      title: string;
      views: number;
      lastViewAt: string | null;
    }>;
  };
};

export type WholesaleManagerAnalyticsProblem = 'EMPTY' | 'NO_CLIENT' | 'NO_EXPIRATION' | 'EXPIRED';

export type WholesaleManagerAnalyticsProblemPrice = {
  id: number;
  title: string;
  clientName: string;
  createdAt: string;
  validUntil: string | null;
  problems: WholesaleManagerAnalyticsProblem[];
};

export type WholesaleManagerAnalyticsChange = {
  id: number;
  priceId: number | null;
  priceTitle: string;
  action: string;
  changedBy: string;
  createdAt: string;
  details: string;
};

type ManagerRow = {
  id: string;
  name: string;
  login: string;
  email: string;
  is_active: boolean;
  price_list_count: string;
  last_changed_at: string | null;
  last_changed_price_title: string | null;
};

type PriceListRow = {
  id: string;
  title: string;
  client_name: string;
  token: string;
  valid_until: string | null;
  show_retail_prices: boolean;
  is_active: boolean;
  manager_id: string | null;
  manager_name: string | null;
  item_count: string;
  created_at: string;
  updated_at: string;
  last_changed_at: string | null;
  last_changed_title: string | null;
  last_changed_by_name: string | null;
};

type PriceListEventInput = {
  priceListId: number;
  ownerManagerId: number | null;
  actorManagerId: number | null;
  actorRole: AdminSession['role'] | 'admin';
  title: string;
  action: string;
  details?: string;
};

type AnalyticsChangeRow = {
  id: string;
  price_id: string | null;
  price_title: string;
  action: string;
  changed_by: string | null;
  created_at: string;
  details: string | null;
};

type AnalyticsProblemRow = {
  id: string;
  title: string;
  client_name: string;
  valid_until: string | null;
  created_at: string;
  item_count: string;
};

type AnalyticsSummaryRow = {
  total_prices: string;
  active_prices: string;
  expired_prices: string;
  prices_last_7_days: string;
  prices_last_30_days: string;
  period_prices: string;
  average_items_per_price: string | null;
  empty_prices: string;
  prices_without_client: string;
  prices_without_expiration: string;
};

function normalizeLogin(login: string) {
  return login.trim().toLowerCase();
}

function sessionManagerId(session?: AdminSession | null) {
  return session?.role === 'manager' ? session.managerId ?? -1 : null;
}

function periodSqlInterval(period: WholesaleManagerAnalyticsPeriod) {
  if (period === '7d') return '7 days';
  if (period === '30d') return '30 days';
  return null;
}

function actorMeta(session?: AdminSession | null) {
  const actorManagerId = session?.role === 'manager' ? session.managerId ?? null : null;
  const actorRole: AdminSession['role'] =
    session?.role === 'manager' ? 'manager' : session?.role === 'wholesale_admin' ? 'wholesale_admin' : 'admin';
  const actorFallback =
    actorRole === 'admin' ? 'Администратор' : actorRole === 'wholesale_admin' ? 'Администратор прайсов' : 'Менеджер';

  return { actorManagerId, actorRole, actorFallback };
}

function priceListAction(previous: { is_active: boolean } | null, next: { isActive: boolean }) {
  if (!previous) return 'create';
  if (previous.is_active !== next.isActive) return next.isActive ? 'enable' : 'disable';
  return 'edit';
}

function priceListDetails(
  previous: { client_name: string; valid_until: string | null; is_active: boolean } | null,
  next: Pick<WholesalePriceListEditor, 'clientName' | 'validUntil' | 'isActive'>,
) {
  if (!previous) return 'Прайс создан';

  const details: string[] = [];
  if ((previous.client_name || '') !== next.clientName) details.push('изменён клиент');
  if ((previous.valid_until || '') !== (next.validUntil || '')) details.push('изменён срок действия');
  if (previous.is_active !== next.isActive) details.push(next.isActive ? 'прайс включён' : 'прайс отключён');
  return details.length ? details.join(', ') : 'Прайс обновлён';
}

function mapAnalyticsChange(row: AnalyticsChangeRow): WholesaleManagerAnalyticsChange {
  return {
    id: Number(row.id),
    priceId: row.price_id ? Number(row.price_id) : null,
    priceTitle: row.price_title || 'Без названия',
    action: row.action,
    changedBy: row.changed_by || 'Не указано',
    createdAt: row.created_at,
    details: row.details || '',
  };
}

function mapProblemPrice(row: AnalyticsProblemRow): WholesaleManagerAnalyticsProblemPrice {
  const problems: WholesaleManagerAnalyticsProblem[] = [];
  const itemCount = Number(row.item_count);
  const validUntil = row.valid_until ? new Date(row.valid_until) : null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (itemCount === 0) problems.push('EMPTY');
  if (!row.client_name.trim()) problems.push('NO_CLIENT');
  if (!row.valid_until) problems.push('NO_EXPIRATION');
  if (validUntil && validUntil < today) problems.push('EXPIRED');

  return {
    id: Number(row.id),
    title: row.title || 'Без названия',
    clientName: row.client_name,
    createdAt: row.created_at,
    validUntil: row.valid_until,
    problems,
  };
}

async function insertPriceListEvent(input: PriceListEventInput) {
  await query(
    `insert into wholesale_price_list_events (
       price_list_id, manager_id, owner_manager_id, action, title_snapshot, actor_role, actor_label, details
     )
     values (
       $1,
       $2,
       $3,
       $4,
       $5,
       $6,
       case
         when $6 = 'manager' then coalesce((select name from wholesale_managers where id = $2), $7)
         else $7
       end,
       $8
     )`,
    [
      input.priceListId,
      input.actorManagerId,
      input.ownerManagerId,
      input.action,
      input.title,
      input.actorRole,
      actorMeta({ role: input.actorRole as AdminSession['role'] }).actorFallback,
      input.details ?? '',
    ],
  );
}

function mapManager(row: ManagerRow): WholesaleManager {
  return {
    id: Number(row.id),
    name: row.name,
    login: row.login,
    email: row.email,
    isActive: row.is_active,
    priceListCount: Number(row.price_list_count),
    lastChangedAt: row.last_changed_at,
    lastChangedPriceTitle: row.last_changed_price_title,
  };
}

function mapPriceList(row: PriceListRow): WholesalePriceListSummary {
  return {
    id: Number(row.id),
    title: row.title,
    clientName: row.client_name,
    token: row.token,
    validUntil: row.valid_until,
    showRetailPrices: row.show_retail_prices,
    isActive: row.is_active,
    managerId: row.manager_id ? Number(row.manager_id) : null,
    managerName: row.manager_name,
    itemCount: Number(row.item_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastChangedAt: row.last_changed_at,
    lastChangedTitle: row.last_changed_title,
    lastChangedByName: row.last_changed_by_name,
  };
}

export async function getWholesaleManagers() {
  await ensureSiteSchema();
  const result = await query<ManagerRow>(`
    select
      m.id::text,
      m.name,
      m.login,
      m.email,
      m.is_active,
      count(pl.id)::text as price_list_count,
      last_event.created_at::text as last_changed_at,
      last_event.title_snapshot as last_changed_price_title
    from wholesale_managers m
    left join wholesale_price_lists pl on pl.manager_id = m.id
    left join lateral (
      select e.created_at, e.title_snapshot
      from wholesale_price_list_events e
      left join wholesale_price_lists event_price on event_price.id = e.price_list_id
      where coalesce(e.owner_manager_id, event_price.manager_id, e.manager_id) = m.id
      order by e.created_at desc, e.id desc
      limit 1
    ) last_event on true
    group by m.id, last_event.created_at, last_event.title_snapshot
    order by m.is_active desc, m.name asc, m.id asc
  `);
  return result.rows.map(mapManager);
}

export async function getWholesaleManagerByLogin(login: string): Promise<WholesaleManagerAuth | null> {
  await ensureSiteSchema();
  const result = await query<{
    id: string;
    login: string;
    password_hash: string;
    is_active: boolean;
  }>(
    `select id::text, login, password_hash, is_active
     from wholesale_managers
     where login = $1 or lower(email) = $1
     limit 1`,
    [normalizeLogin(login)],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    login: row.login,
    passwordHash: row.password_hash,
    isActive: row.is_active,
  };
}

export async function getWholesaleManagerById(id: number): Promise<WholesaleManagerProfile | null> {
  await ensureSiteSchema();
  const result = await query<{
    id: string;
    name: string;
    login: string;
    email: string;
    is_active: boolean;
  }>(
    `select id::text, name, login, email, is_active
     from wholesale_managers
     where id = $1
     limit 1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    login: row.login,
    email: row.email,
    isActive: row.is_active,
  };
}

export async function createWholesaleManager(input: {
  name: string;
  login: string;
  email: string;
  passwordHash: string;
  isActive: boolean;
}) {
  await ensureSiteSchema();
  const result = await query<{ id: string }>(
    `insert into wholesale_managers (name, login, email, password_hash, is_active)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [input.name, normalizeLogin(input.login), input.email, input.passwordHash, input.isActive],
  );
  return Number(result.rows[0].id);
}

export async function updateWholesaleManager(
  id: number,
  input: { name: string; login: string; email: string; passwordHash?: string; isActive: boolean },
) {
  await ensureSiteSchema();
  await query(
    `update wholesale_managers
     set name = $2,
         login = $3,
         email = $4,
         password_hash = case when $5::text is null then password_hash else $5 end,
         is_active = $6,
         updated_at = now()
     where id = $1`,
    [id, input.name, normalizeLogin(input.login), input.email, input.passwordHash ?? null, input.isActive],
  );
}

export async function deleteWholesaleManager(id: number) {
  await ensureSiteSchema();
  await query(`delete from wholesale_managers where id = $1`, [id]);
}

export async function getWholesalePriceLists(session?: AdminSession | null) {
  await ensureSiteSchema();
  return getWholesalePriceListsByManagerId(sessionManagerId(session));
}

export async function getWholesalePriceListsForManager(managerId: number) {
  await ensureSiteSchema();
  return getWholesalePriceListsByManagerId(managerId);
}

async function getWholesalePriceListsByManagerId(managerId: number | null) {
  const result = await query<PriceListRow>(
    `select
       pl.id::text,
       pl.title,
       pl.client_name,
       pl.token,
       pl.valid_until::text,
       pl.show_retail_prices,
       pl.is_active,
       pl.manager_id::text,
       m.name as manager_name,
       count(i.id)::text as item_count,
       pl.created_at::text,
       pl.updated_at::text,
       last_event.created_at::text as last_changed_at,
       last_event.title_snapshot as last_changed_title,
       last_event.actor_name as last_changed_by_name
     from wholesale_price_lists pl
     left join wholesale_managers m on m.id = pl.manager_id
     left join wholesale_price_list_items i on i.price_list_id = pl.id
     left join lateral (
       select
         e.created_at,
         e.title_snapshot,
         coalesce(
           nullif(e.actor_label, ''),
           em.name,
           case
             when e.actor_role = 'admin' then 'Администратор'
             when e.actor_role = 'wholesale_admin' then 'Администратор прайсов'
             else null
           end
         ) as actor_name
       from wholesale_price_list_events e
       left join wholesale_managers em on em.id = e.manager_id
       where e.price_list_id = pl.id
       order by e.created_at desc, e.id desc
       limit 1
     ) last_event on true
     where ($1::bigint is null or pl.manager_id = $1)
     group by pl.id, m.name, last_event.created_at, last_event.title_snapshot, last_event.actor_name
     order by pl.updated_at desc, pl.id desc`,
    [managerId],
  );
  return result.rows.map(mapPriceList);
}

export async function getWholesaleCatalog() {
  await ensureSiteSchema();
  const result = await query<{
    category_id: string | null;
    category_title: string | null;
    product_id: string;
    product_title: string;
    sku: string;
    series_description: string;
    image_url: string | null;
    variant_id: string | null;
    variant_title: string | null;
    retail_price: string | null;
    wholesale_price: string | null;
  }>(`
    select
      c.id::text as category_id,
      coalesce(c.title, 'Без категории') as category_title,
      p.id::text as product_id,
      p.title as product_title,
      p.sku,
      p.series_description,
      img.image_url,
      v.id::text as variant_id,
      v.title as variant_title,
      coalesce(v.retail_price, p.retail_price)::text as retail_price,
      coalesce(v.wholesale_price, p.wholesale_price)::text as wholesale_price
    from wholesale_products p
    left join wholesale_categories c on c.id = p.category_id
    left join wholesale_product_variants v on v.product_id = p.id and v.is_active = true
    left join lateral (
      select image_url
      from wholesale_product_images
      where product_id = p.id and is_active = true
      order by sort_order asc, id asc
      limit 1
    ) img on true
    where p.is_active = true
    order by c.sort_order asc nulls last, c.id asc nulls last, p.sort_order asc, p.id asc, v.sort_order asc nulls last, v.id asc nulls last
  `);

  const categories = new Map<number, WholesaleCatalogCategory>();
  const products = new Map<string, WholesaleCatalogProduct>();

  for (const row of result.rows) {
    const categoryId = Number(row.category_id ?? 0);
    const normalizedCategoryId = Number.isFinite(categoryId) && categoryId > 0 ? categoryId : 0;
    let category = categories.get(normalizedCategoryId);
    if (!category) {
      category = { id: normalizedCategoryId, title: row.category_title || 'Без категории', products: [] };
      categories.set(normalizedCategoryId, category);
    }

    const productId = Number(row.product_id);
    const productKey = `${normalizedCategoryId}:${productId}`;
    let product = products.get(productKey);
    if (!product) {
      product = {
        id: productId,
        title: row.product_title,
        sku: row.sku,
        description: row.series_description,
        imageUrl: row.image_url,
        variants: [],
      };
      products.set(productKey, product);
      category.products.push(product);
    }

    product.variants.push({
      id: row.variant_id ? Number(row.variant_id) : null,
      title: row.variant_title || 'Цена',
      retailPrice: row.retail_price,
      wholesalePrice: row.wholesale_price,
    });
  }

  return Array.from(categories.values());
}

export async function getWholesalePriceListEditor(id: number, session?: AdminSession | null) {
  await ensureSiteSchema();
  const managerId = sessionManagerId(session);
  const priceList = await query<Omit<WholesalePriceListEditor, 'items'> & { id: string; manager_id: string | null }>(
    `select id::text, title, client_name as "clientName", token, valid_until::text as "validUntil",
            comment, show_retail_prices as "showRetailPrices", is_active as "isActive", manager_id::text
     from wholesale_price_lists
     where id = $1 and ($2::bigint is null or manager_id = $2)
     limit 1`,
    [id, managerId],
  );
  const row = priceList.rows[0];
  if (!row) return null;

  const items = await query<{
    product_id: string;
    variant_id: string | null;
    custom_wholesale_price: string | null;
    visible: boolean;
    sort_order: number;
  }>(
    `select wholesale_product_id::text as product_id,
            wholesale_variant_id::text as variant_id,
            custom_wholesale_price::text,
            visible,
            sort_order
     from wholesale_price_list_items
     where price_list_id = $1
     order by sort_order asc, id asc`,
    [id],
  );

  return {
    id: Number(row.id),
    title: row.title,
    clientName: row.clientName,
    token: row.token,
    validUntil: row.validUntil,
    comment: row.comment,
    showRetailPrices: row.showRetailPrices,
    isActive: row.isActive,
    managerId: row.manager_id ? Number(row.manager_id) : null,
    items: items.rows.map((item) => ({
      productId: Number(item.product_id),
      variantId: item.variant_id ? Number(item.variant_id) : null,
      customWholesalePrice: item.custom_wholesale_price,
      visible: item.visible,
      sortOrder: item.sort_order,
    })),
  };
}

export async function createWholesalePriceList(
  input: Omit<WholesalePriceListEditor, 'id'>,
  session?: AdminSession | null,
) {
  await ensureSiteSchema();
  const managerId = session?.role === 'manager' ? session.managerId ?? null : input.managerId;
  const result = await query<{ id: string }>(
    `insert into wholesale_price_lists (
       title, client_name, manager_id, valid_until, token, comment, show_retail_prices, is_active
     )
     values ($1, $2, $3, nullif($4, '')::date, $5, $6, $7, $8)
     returning id`,
    [
      input.title,
      input.clientName,
      managerId,
      input.validUntil ?? '',
      input.token,
      input.comment,
      input.showRetailPrices,
      input.isActive,
    ],
  );
  const id = Number(result.rows[0].id);
  await replaceWholesalePriceListItems(id, input.items);
  const actor = actorMeta(session);
  await insertPriceListEvent({
    priceListId: id,
    ownerManagerId: managerId,
    actorManagerId: actor.actorManagerId,
    actorRole: actor.actorRole,
    title: input.title,
    action: 'create',
    details: 'Прайс создан',
  });
  return id;
}

export async function updateWholesalePriceList(
  id: number,
  input: Omit<WholesalePriceListEditor, 'id'>,
  session?: AdminSession | null,
) {
  await ensureSiteSchema();
  const managerId = session?.role === 'manager' ? session.managerId ?? null : input.managerId;
  const previous = await query<{
    title: string;
    client_name: string;
    manager_id: string | null;
    valid_until: string | null;
    is_active: boolean;
  }>(
    `select title, client_name, manager_id::text, valid_until::text, is_active
     from wholesale_price_lists
     where id = $1 and ($2::bigint is null or manager_id = $2)
     limit 1`,
    [id, sessionManagerId(session)],
  );
  const previousRow = previous.rows[0];
  if (!previousRow) return;

  await query(
    `update wholesale_price_lists
     set title = $2,
         client_name = $3,
         manager_id = $4,
         valid_until = nullif($5, '')::date,
         token = $6,
         comment = $7,
         show_retail_prices = $8,
         is_active = $9,
         updated_at = now()
     where id = $1 and ($10::bigint is null or manager_id = $10)`,
    [
      id,
      input.title,
      input.clientName,
      managerId,
      input.validUntil ?? '',
      input.token,
      input.comment,
      input.showRetailPrices,
      input.isActive,
      sessionManagerId(session),
    ],
  );
  await replaceWholesalePriceListItems(id, input.items);
  const actor = actorMeta(session);
  await insertPriceListEvent({
    priceListId: id,
    ownerManagerId: managerId,
    actorManagerId: actor.actorManagerId,
    actorRole: actor.actorRole,
    title: input.title,
    action: priceListAction(previousRow, input),
    details: priceListDetails(previousRow, input),
  });
}

export async function deleteWholesalePriceList(id: number, session?: AdminSession | null) {
  await ensureSiteSchema();
  const previous = await query<{
    title: string;
    manager_id: string | null;
  }>(
    `select title, manager_id::text
     from wholesale_price_lists
     where id = $1 and ($2::bigint is null or manager_id = $2)
     limit 1`,
    [id, sessionManagerId(session)],
  );
  const previousRow = previous.rows[0];
  if (!previousRow) return;

  const actor = actorMeta(session);
  await insertPriceListEvent({
    priceListId: id,
    ownerManagerId: previousRow.manager_id ? Number(previousRow.manager_id) : null,
    actorManagerId: actor.actorManagerId,
    actorRole: actor.actorRole,
    title: previousRow.title,
    action: 'delete',
    details: 'Прайс удалён',
  });

  await query(`delete from wholesale_price_lists where id = $1 and ($2::bigint is null or manager_id = $2)`, [
    id,
    sessionManagerId(session),
  ]);
}

export async function recordWholesaleManagerLogin(
  managerId: number,
  input: { ip?: string | null; userAgent?: string | null },
) {
  await ensureSiteSchema();
  await query(
    `insert into wholesale_manager_login_logs (manager_id, ip, user_agent)
     values ($1, $2, $3)`,
    [managerId, input.ip ?? '', input.userAgent ?? ''],
  );
}

export async function recordWholesalePriceView(
  priceListId: number,
  token: string,
  input: { ip?: string | null; userAgent?: string | null; referer?: string | null },
) {
  await ensureSiteSchema();
  await query(
    `insert into wholesale_price_view_logs (price_list_id, token, ip, user_agent, referer)
     values ($1, $2, $3, $4, $5)`,
    [priceListId, token, input.ip ?? '', input.userAgent ?? '', input.referer ?? ''],
  );
}

export async function getWholesaleManagerAnalytics(
  managerId: number,
  period: WholesaleManagerAnalyticsPeriod = '30d',
): Promise<WholesaleManagerAnalytics | null> {
  await ensureSiteSchema();
  const interval = periodSqlInterval(period);

  const managerResult = await query<{
    id: string;
    name: string;
    login: string;
    email: string;
    last_login_at: string | null;
  }>(
    `select
       m.id::text,
       m.name,
       m.login,
       m.email,
       last_login.created_at::text as last_login_at
     from wholesale_managers m
     left join lateral (
       select created_at
       from wholesale_manager_login_logs
       where manager_id = m.id
       order by created_at desc, id desc
       limit 1
     ) last_login on true
     where m.id = $1
     limit 1`,
    [managerId],
  );
  const managerRow = managerResult.rows[0];
  if (!managerRow) return null;

  const summaryResult = await query<AnalyticsSummaryRow>(
    `with manager_prices as (
       select
         pl.id,
         pl.client_name,
         pl.valid_until,
         pl.is_active,
         pl.created_at,
         count(i.id)::integer as item_count
       from wholesale_price_lists pl
       left join wholesale_price_list_items i on i.price_list_id = pl.id
       where pl.manager_id = $1
       group by pl.id
     )
     select
       count(*)::text as total_prices,
       count(*) filter (where is_active)::text as active_prices,
       count(*) filter (where valid_until is not null and valid_until < current_date)::text as expired_prices,
       count(*) filter (where created_at >= now() - interval '7 days')::text as prices_last_7_days,
       count(*) filter (where created_at >= now() - interval '30 days')::text as prices_last_30_days,
       count(*) filter (where ($2::text is null or created_at >= now() - $2::interval))::text as period_prices,
       coalesce(round(avg(item_count)::numeric, 1), 0)::text as average_items_per_price,
       count(*) filter (where item_count = 0)::text as empty_prices,
       count(*) filter (where btrim(client_name) = '')::text as prices_without_client,
       count(*) filter (where valid_until is null)::text as prices_without_expiration
     from manager_prices`,
    [managerId, interval],
  );
  const summaryRow = summaryResult.rows[0];

  const lastCreatedResult = await query<{
    id: string;
    title: string;
    created_at: string;
  }>(
    `select id::text, title, created_at::text
     from wholesale_price_lists
     where manager_id = $1
     order by created_at desc, id desc
     limit 1`,
    [managerId],
  );

  const recentChangesResult = await query<AnalyticsChangeRow>(
    `select
       e.id::text,
       e.price_list_id::text as price_id,
       coalesce(nullif(e.title_snapshot, ''), pl.title, 'Без названия') as price_title,
       e.action,
       coalesce(
         nullif(e.actor_label, ''),
         actor.name,
         case
           when e.actor_role = 'admin' then 'Администратор'
           when e.actor_role = 'wholesale_admin' then 'Администратор прайсов'
           when e.actor_role = 'manager' then 'Менеджер'
           else 'Не указано'
         end
       ) as changed_by,
       e.created_at::text,
       e.details
     from wholesale_price_list_events e
     left join wholesale_price_lists pl on pl.id = e.price_list_id
     left join wholesale_managers actor on actor.id = e.manager_id
     where coalesce(e.owner_manager_id, pl.manager_id, e.manager_id) = $1
       and ($2::text is null or e.created_at >= now() - $2::interval)
     order by e.created_at desc, e.id desc
     limit 12`,
    [managerId, interval],
  );

  const lastChangeResult = await query<AnalyticsChangeRow>(
    `select
       e.id::text,
       e.price_list_id::text as price_id,
       coalesce(nullif(e.title_snapshot, ''), pl.title, 'Без названия') as price_title,
       e.action,
       coalesce(
         nullif(e.actor_label, ''),
         actor.name,
         case
           when e.actor_role = 'admin' then 'Администратор'
           when e.actor_role = 'wholesale_admin' then 'Администратор прайсов'
           when e.actor_role = 'manager' then 'Менеджер'
           else 'Не указано'
         end
       ) as changed_by,
       e.created_at::text,
       e.details
     from wholesale_price_list_events e
     left join wholesale_price_lists pl on pl.id = e.price_list_id
     left join wholesale_managers actor on actor.id = e.manager_id
     where coalesce(e.owner_manager_id, pl.manager_id, e.manager_id) = $1
     order by e.created_at desc, e.id desc
     limit 1`,
    [managerId],
  );

  const problemResult = await query<AnalyticsProblemRow>(
    `with manager_prices as (
       select
         pl.id,
         pl.title,
         pl.client_name,
         pl.valid_until::text as valid_until,
         pl.valid_until as valid_until_date,
         pl.created_at::text,
         count(i.id)::text as item_count
       from wholesale_price_lists pl
       left join wholesale_price_list_items i on i.price_list_id = pl.id
       where pl.manager_id = $1
       group by pl.id
     )
     select id::text, title, client_name, valid_until::text, created_at, item_count
     from manager_prices
     where item_count::integer = 0
        or btrim(client_name) = ''
        or valid_until_date is null
        or valid_until_date < current_date
     order by
       case when valid_until_date is not null and valid_until_date < current_date then 0 else 1 end,
       created_at desc,
       id desc
     limit 50`,
    [managerId],
  );

  const publicViewsResult = await query<{
    total: string;
    last_7_days: string;
    last_30_days: string;
    period_views: string;
    last_view_at: string | null;
  }>(
    `select
       count(v.id)::text as total,
       count(v.id) filter (where v.created_at >= now() - interval '7 days')::text as last_7_days,
       count(v.id) filter (where v.created_at >= now() - interval '30 days')::text as last_30_days,
       count(v.id) filter (where ($2::text is null or v.created_at >= now() - $2::interval))::text as period_views,
       max(v.created_at)::text as last_view_at
     from wholesale_price_lists pl
     left join wholesale_price_view_logs v on v.price_list_id = pl.id
     where pl.manager_id = $1`,
    [managerId, interval],
  );

  const topViewsResult = await query<{
    price_id: string;
    title: string;
    views: string;
    last_view_at: string | null;
  }>(
    `select
       pl.id::text as price_id,
       coalesce(nullif(pl.title, ''), 'Без названия') as title,
       count(v.id)::text as views,
       max(v.created_at)::text as last_view_at
     from wholesale_price_lists pl
     join wholesale_price_view_logs v on v.price_list_id = pl.id
     where pl.manager_id = $1
       and ($2::text is null or v.created_at >= now() - $2::interval)
     group by pl.id
     order by count(v.id) desc, max(v.created_at) desc
     limit 5`,
    [managerId, interval],
  );

  const lastCreatedRow = lastCreatedResult.rows[0];
  const publicViewsRow = publicViewsResult.rows[0];

  return {
    manager: {
      id: Number(managerRow.id),
      name: managerRow.name,
      login: managerRow.login,
      email: managerRow.email,
      role: 'Менеджер',
      lastLoginAt: managerRow.last_login_at,
    },
    summary: {
      totalPrices: Number(summaryRow?.total_prices ?? 0),
      activePrices: Number(summaryRow?.active_prices ?? 0),
      expiredPrices: Number(summaryRow?.expired_prices ?? 0),
      pricesLast7Days: Number(summaryRow?.prices_last_7_days ?? 0),
      pricesLast30Days: Number(summaryRow?.prices_last_30_days ?? 0),
      periodPrices: Number(summaryRow?.period_prices ?? 0),
      averageItemsPerPrice: Number(summaryRow?.average_items_per_price ?? 0),
      emptyPrices: Number(summaryRow?.empty_prices ?? 0),
      pricesWithoutClient: Number(summaryRow?.prices_without_client ?? 0),
      pricesWithoutExpiration: Number(summaryRow?.prices_without_expiration ?? 0),
    },
    lastCreatedPrice: lastCreatedRow
      ? {
          id: Number(lastCreatedRow.id),
          title: lastCreatedRow.title || 'Без названия',
          createdAt: lastCreatedRow.created_at,
        }
      : null,
    lastChange: lastChangeResult.rows[0] ? mapAnalyticsChange(lastChangeResult.rows[0]) : null,
    problemPrices: problemResult.rows.map(mapProblemPrice).filter((price) => price.problems.length > 0),
    recentChanges: recentChangesResult.rows.map(mapAnalyticsChange),
    publicViews: {
      total: Number(publicViewsRow?.total ?? 0),
      last7Days: Number(publicViewsRow?.last_7_days ?? 0),
      last30Days: Number(publicViewsRow?.last_30_days ?? 0),
      periodViews: Number(publicViewsRow?.period_views ?? 0),
      lastViewAt: publicViewsRow?.last_view_at ?? null,
      topPrices: topViewsResult.rows.map((row) => ({
        priceId: Number(row.price_id),
        title: row.title,
        views: Number(row.views),
        lastViewAt: row.last_view_at,
      })),
    },
  };
}

async function replaceWholesalePriceListItems(id: number, items: WholesalePriceListItemInput[]) {
  await query(`delete from wholesale_price_list_items where price_list_id = $1`, [id]);

  for (const item of items) {
    await query(
      `insert into wholesale_price_list_items (
         price_list_id, wholesale_product_id, wholesale_variant_id, custom_wholesale_price, visible, sort_order
       )
       values ($1, $2, $3, nullif($4, '')::numeric, $5, $6)`,
      [id, item.productId, item.variantId, item.customWholesalePrice ?? '', item.visible, item.sortOrder],
    );
  }
}
