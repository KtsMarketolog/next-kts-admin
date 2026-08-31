import { query } from '@/shared/lib/db';

declare global {
  var __ktsCatalogSchemaReady: Promise<void> | undefined;
}

export function ensureCatalogSchema() {
  // Route bundles share one process-wide migration promise so concurrent first
  // requests cannot run DDL against the same catalog tables in different orders.
  globalThis.__ktsCatalogSchemaReady ??= query(`
    create table if not exists catalog_categories (
      id bigserial primary key,
      strapi_id integer unique,
      document_id text,
      slug text not null unique,
      title text not null,
      subtitle text,
      sort_order integer not null default 0,
      icon_url text,
      image_url text,
      is_active boolean not null default true,
      show_on_site boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists catalog_subcategories (
      id bigserial primary key,
      strapi_id integer unique,
      document_id text,
      slug text not null unique,
      title text not null,
      sort_order integer not null default 0,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists catalog_category_subcategories (
      category_id bigint not null references catalog_categories(id) on delete cascade,
      subcategory_id bigint not null references catalog_subcategories(id) on delete cascade,
      sort_order integer not null default 0,
      primary key (category_id, subcategory_id)
    );

    create table if not exists catalog_brands (
      id bigserial primary key,
      strapi_id integer unique,
      document_id text,
      slug text not null unique,
      title text not null,
      popular boolean not null default false,
      logo_url text,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists catalog_brand_categories (
      brand_id bigint not null references catalog_brands(id) on delete cascade,
      category_id bigint not null references catalog_categories(id) on delete cascade,
      sort_order integer not null default 0,
      primary key (brand_id, category_id)
    );

    create table if not exists catalog_brand_subcategories (
      brand_id bigint not null references catalog_brands(id) on delete cascade,
      subcategory_id bigint not null references catalog_subcategories(id) on delete cascade,
      sort_order integer not null default 0,
      primary key (brand_id, subcategory_id)
    );

    create table if not exists catalog_products (
      id bigserial primary key,
      strapi_id integer unique,
      document_id text,
      slug text not null unique,
      title text not null,
      article text,
      model text not null default '',
      price_group text not null default '',
      unit text,
      price_eur numeric(14, 2),
      price_rub numeric(14, 2),
      price_cny numeric(14, 2),
      price_usd numeric(14, 2),
      general_discount numeric(7, 2),
      manual_discount numeric(7, 2),
      manual_discount_rop numeric(7, 2),
      stock integer not null default 0,
      stock_volzhsk integer not null default 0,
      stock_moscow integer not null default 0,
      is_expected boolean not null default false,
      stock_updated_at timestamptz,
      promo boolean not null default false,
      brand_id bigint references catalog_brands(id) on delete set null,
      category_id bigint references catalog_categories(id) on delete set null,
      subcategory_id bigint references catalog_subcategories(id) on delete set null,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    alter table catalog_products add column if not exists model text not null default '';
    alter table catalog_products add column if not exists price_group text not null default '';
    alter table catalog_products add column if not exists unit text;
    alter table catalog_products add column if not exists price_eur numeric(14, 2);
    alter table catalog_products add column if not exists price_rub numeric(14, 2);
    alter table catalog_products add column if not exists price_cny numeric(14, 2);
    alter table catalog_products add column if not exists price_usd numeric(14, 2);
    alter table catalog_products add column if not exists general_discount numeric(7, 2);
    alter table catalog_products add column if not exists manual_discount numeric(7, 2);
    alter table catalog_products add column if not exists manual_discount_rop numeric(7, 2);
    alter table catalog_products add column if not exists stock integer not null default 0;
    alter table catalog_products add column if not exists stock_volzhsk integer not null default 0;
    alter table catalog_products add column if not exists stock_moscow integer not null default 0;
    alter table catalog_products add column if not exists is_expected boolean not null default false;
    alter table catalog_products add column if not exists stock_updated_at timestamptz;
    alter table catalog_categories add column if not exists show_on_site boolean not null default true;

    create index if not exists catalog_categories_order_idx
      on catalog_categories (is_active, sort_order, id);
    create index if not exists catalog_categories_site_order_idx
      on catalog_categories (is_active, show_on_site, sort_order, id);
    create index if not exists catalog_subcategories_order_idx
      on catalog_subcategories (is_active, sort_order, id);
    create index if not exists catalog_brands_title_idx
      on catalog_brands (is_active, title);
    create index if not exists catalog_products_subcategory_idx
      on catalog_products (subcategory_id, is_active, title);
    create index if not exists catalog_products_brand_idx
      on catalog_products (brand_id, is_active, title);
    create index if not exists catalog_products_category_idx
      on catalog_products (category_id, is_active, title);
    create index if not exists catalog_products_promo_idx
      on catalog_products (promo, is_active, title);
    create index if not exists catalog_products_search_idx
      on catalog_products using gin (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(article, '') || ' ' || coalesce(model, '')));
    create index if not exists catalog_products_stock_title_norm_idx
      on catalog_products (lower(trim(regexp_replace(replace(title, chr(160), ' '), $$\s+$$, ' ', 'g'))));
  `)
    .then(() => undefined)
    .catch((error) => {
      globalThis.__ktsCatalogSchemaReady = undefined;
      throw error;
    });

  return globalThis.__ktsCatalogSchemaReady;
}
