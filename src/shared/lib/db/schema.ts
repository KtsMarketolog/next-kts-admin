import { DEFAULT_BRAND_CATEGORIES, DEFAULT_BRAND_ITEMS } from '@/entities/site/model/defaultBrands';
import { DEFAULT_GROUP_COMPANIES } from '@/entities/site/model/defaultGroupCompanies';
import { DEFAULT_HERO_SLIDES } from '@/entities/site/model/defaultSlides';
import { DEFAULT_NEWS } from '@/entities/site/model/defaultNews';

import { DEFAULT_ADDRESS, DEFAULT_EMAIL, DEFAULT_PHONE } from '../phone';
import { query } from './client';

export async function ensureSiteSchema() {
  await query(`
    create table if not exists site_settings (
      key text primary key,
      value text not null,
      updated_at timestamptz not null default now()
    );

    create table if not exists admin_users (
      id bigserial primary key,
      login text not null unique,
      email text not null default '',
      password_hash text not null default '',
      role text not null default 'admin',
      is_active boolean not null default true,
      password_changed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists hero_slides (
      id bigserial primary key,
      title text not null default '',
      image_url text not null,
      tablet_image_url text,
      mobile_image_url text,
      popup_image_url text,
      popup_tablet_image_url text,
      popup_mobile_image_url text,
      popup_title text,
      popup_text text,
      link_url text,
      sort_order integer not null default 0,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists news_items (
      id bigserial primary key,
      date_label text not null default '',
      title text not null default '',
      image_url text not null,
      link_url text not null default '',
      sort_order integer not null default 0,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists brand_categories (
      id bigserial primary key,
      key text not null unique,
      title text not null default '',
      sort_order integer not null default 0,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists brand_items (
      id bigserial primary key,
      category_id bigint not null references brand_categories(id) on delete cascade,
      name text not null default '',
      image_url text not null default '',
      icon_key text not null default '',
      sort_order integer not null default 0,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists group_companies (
      id bigserial primary key,
      image_url text not null default '',
      sort_order integer not null default 0,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists wholesale_categories (
      id bigserial primary key,
      title text not null default '',
      slug text not null unique,
      sort_order integer not null default 0,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists wholesale_products (
      id bigserial primary key,
      category_id bigint references wholesale_categories(id) on delete set null,
      title text not null default '',
      sku text not null default '',
      series_description text not null default '',
      retail_price numeric(12, 2),
      wholesale_price numeric(12, 2),
      sort_order integer not null default 0,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists wholesale_product_images (
      id bigserial primary key,
      product_id bigint not null references wholesale_products(id) on delete cascade,
      image_url text not null default '',
      sort_order integer not null default 0,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists wholesale_product_variants (
      id bigserial primary key,
      product_id bigint not null references wholesale_products(id) on delete cascade,
      size_key text not null default '',
      title text not null default '',
      retail_price numeric(12, 2),
      wholesale_price numeric(12, 2),
      sort_order integer not null default 0,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists wholesale_managers (
      id bigserial primary key,
      name text not null default '',
      login text not null unique,
      email text not null default '',
      phone text not null default '',
      password_hash text not null default '',
      is_active boolean not null default true,
      password_changed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists wholesale_price_lists (
      id bigserial primary key,
      title text not null default '',
      client_name text not null default '',
      manager_id bigint references wholesale_managers(id) on delete set null,
      valid_until date,
      token text not null unique,
      comment text not null default '',
      show_retail_prices boolean not null default false,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists wholesale_price_list_items (
      id bigserial primary key,
      price_list_id bigint not null references wholesale_price_lists(id) on delete cascade,
      wholesale_product_id bigint not null references wholesale_products(id) on delete cascade,
      wholesale_variant_id bigint references wholesale_product_variants(id) on delete cascade,
      custom_wholesale_price numeric(12, 2),
      visible boolean not null default true,
      sort_order integer not null default 0,
      snapshot_category_title text,
      snapshot_product_title text,
      snapshot_product_sku text,
      snapshot_product_description text,
      snapshot_variant_title text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists wholesale_price_list_events (
      id bigserial primary key,
      price_list_id bigint not null references wholesale_price_lists(id) on delete cascade,
      manager_id bigint references wholesale_managers(id) on delete set null,
      owner_manager_id bigint references wholesale_managers(id) on delete set null,
      action text not null default 'edit',
      actor_role text not null default '',
      actor_label text not null default '',
      title_snapshot text not null default '',
      details text not null default '',
      created_at timestamptz not null default now()
    );

    create table if not exists wholesale_manager_login_logs (
      id bigserial primary key,
      manager_id bigint not null references wholesale_managers(id) on delete cascade,
      ip text not null default '',
      user_agent text not null default '',
      created_at timestamptz not null default now()
    );

    create table if not exists wholesale_price_view_logs (
      id bigserial primary key,
      price_list_id bigint not null references wholesale_price_lists(id) on delete cascade,
      token text not null default '',
      ip text not null default '',
      user_agent text not null default '',
      referer text not null default '',
      created_at timestamptz not null default now()
    );

    create table if not exists wholesale_analytics_events (
      id bigserial primary key,
      event_type text not null,
      actor_type text not null default 'system',
      actor_user_id bigint,
      manager_id bigint references wholesale_managers(id) on delete set null,
      client_id text,
      price_list_id bigint references wholesale_price_lists(id) on delete set null,
      share_link_id bigint,
      token text not null default '',
      session_id text not null default '',
      ip_hash text not null default '',
      user_agent text not null default '',
      referer text not null default '',
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );

    create table if not exists admin_sessions (
      id uuid primary key,
      session_hash text not null unique,
      role text not null,
      admin_user_id bigint references admin_users(id) on delete cascade,
      manager_id bigint references wholesale_managers(id) on delete cascade,
      ip_hash text not null default '',
      user_agent text not null default '',
      created_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      expires_at timestamptz not null,
      revoked_at timestamptz
    );

    create table if not exists admin_2fa_challenges (
      id uuid primary key,
      login text not null default '',
      actor_type text not null default 'admin',
      role text not null default 'admin',
      admin_user_id bigint references admin_users(id) on delete cascade,
      manager_id bigint references wholesale_managers(id) on delete cascade,
      code_hash text not null,
      login_session_id text not null default '',
      attempts integer not null default 0,
      expires_at timestamptz not null,
      consumed_at timestamptz,
      created_at timestamptz not null default now()
    );

    create table if not exists security_audit_events (
      id bigserial primary key,
      event_type text not null,
      actor_type text not null default 'system',
      admin_user_id bigint references admin_users(id) on delete set null,
      manager_id bigint references wholesale_managers(id) on delete set null,
      session_id text not null default '',
      login text not null default '',
      entity_type text not null default '',
      entity_id text not null default '',
      ip_hash text not null default '',
      user_agent text not null default '',
      referer text not null default '',
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );

    create table if not exists rate_limit_buckets (
      key text primary key,
      count integer not null default 0,
      reset_at timestamptz not null,
      updated_at timestamptz not null default now()
    );

    alter table wholesale_price_lists add column if not exists manager_id bigint references wholesale_managers(id) on delete set null;
    alter table wholesale_price_lists add column if not exists comment text not null default '';
    alter table admin_users add column if not exists email text not null default '';
    alter table admin_users add column if not exists role text not null default 'admin';
    alter table admin_users add column if not exists password_changed_at timestamptz;
    alter table wholesale_managers add column if not exists phone text not null default '';
    alter table wholesale_managers add column if not exists password_hash text not null default '';
    alter table wholesale_managers add column if not exists password_changed_at timestamptz;
    alter table wholesale_price_list_events add column if not exists actor_role text not null default '';
    alter table wholesale_price_list_events add column if not exists actor_label text not null default '';
    alter table wholesale_price_list_events add column if not exists owner_manager_id bigint references wholesale_managers(id) on delete set null;
    alter table wholesale_price_list_events add column if not exists details text not null default '';
    alter table wholesale_price_list_events alter column price_list_id drop not null;

    do $$
    begin
      if exists (
        select 1
        from pg_constraint
        where conrelid = 'wholesale_price_list_events'::regclass
          and conname = 'wholesale_price_list_events_price_list_id_fkey'
      ) then
        alter table wholesale_price_list_events drop constraint wholesale_price_list_events_price_list_id_fkey;
      end if;

      if not exists (
        select 1
        from pg_constraint
        where conrelid = 'wholesale_price_list_events'::regclass
          and conname = 'wholesale_price_list_events_price_list_id_fkey'
      ) then
        alter table wholesale_price_list_events
          add constraint wholesale_price_list_events_price_list_id_fkey
          foreign key (price_list_id) references wholesale_price_lists(id) on delete set null;
      end if;
    end $$;

    update wholesale_price_list_events e
    set owner_manager_id = pl.manager_id
    from wholesale_price_lists pl
    where e.price_list_id = pl.id
      and e.owner_manager_id is null;

    create index if not exists admin_users_login_idx on admin_users(login);
    create index if not exists wholesale_products_category_idx on wholesale_products(category_id);
    create index if not exists wholesale_product_images_product_idx on wholesale_product_images(product_id);
    create index if not exists wholesale_product_variants_product_idx on wholesale_product_variants(product_id);
    create index if not exists wholesale_managers_login_idx on wholesale_managers(login);
    create index if not exists wholesale_price_list_items_price_list_idx on wholesale_price_list_items(price_list_id);
    create index if not exists wholesale_price_list_items_product_idx on wholesale_price_list_items(wholesale_product_id);
    create index if not exists wholesale_price_lists_manager_idx on wholesale_price_lists(manager_id);
    create index if not exists wholesale_price_list_events_manager_idx on wholesale_price_list_events(manager_id, created_at desc);
    create index if not exists wholesale_price_list_events_owner_manager_idx on wholesale_price_list_events(owner_manager_id, created_at desc);
    create index if not exists wholesale_manager_login_logs_manager_idx on wholesale_manager_login_logs(manager_id, created_at desc);
    create index if not exists wholesale_price_view_logs_price_idx on wholesale_price_view_logs(price_list_id, created_at desc);
    create index if not exists wholesale_analytics_events_manager_idx on wholesale_analytics_events(manager_id, created_at desc);
    create index if not exists wholesale_analytics_events_price_idx on wholesale_analytics_events(price_list_id, created_at desc);
    create index if not exists wholesale_analytics_events_client_idx on wholesale_analytics_events(client_id, created_at desc);
    create index if not exists wholesale_analytics_events_type_idx on wholesale_analytics_events(event_type, created_at desc);
    create index if not exists wholesale_analytics_events_actor_idx on wholesale_analytics_events(actor_type, created_at desc);
    create index if not exists wholesale_analytics_events_session_idx on wholesale_analytics_events(session_id, created_at desc);
    create index if not exists wholesale_analytics_events_token_idx on wholesale_analytics_events(token, created_at desc);
    create index if not exists admin_sessions_admin_user_idx on admin_sessions(admin_user_id, created_at desc);
    create index if not exists admin_sessions_manager_idx on admin_sessions(manager_id, created_at desc);
    create index if not exists admin_sessions_expires_idx on admin_sessions(expires_at);
    create index if not exists admin_sessions_revoked_idx on admin_sessions(revoked_at);
    create index if not exists admin_2fa_challenges_login_idx on admin_2fa_challenges(login, created_at desc);
    create index if not exists admin_2fa_challenges_session_idx on admin_2fa_challenges(login_session_id, created_at desc);
    create index if not exists admin_2fa_challenges_expires_idx on admin_2fa_challenges(expires_at);
    create index if not exists security_audit_events_type_idx on security_audit_events(event_type, created_at desc);
    create index if not exists security_audit_events_actor_idx on security_audit_events(actor_type, created_at desc);
    create index if not exists security_audit_events_admin_user_idx on security_audit_events(admin_user_id, created_at desc);
    create index if not exists security_audit_events_manager_idx on security_audit_events(manager_id, created_at desc);
    create index if not exists security_audit_events_session_idx on security_audit_events(session_id, created_at desc);
    create index if not exists security_audit_events_entity_idx on security_audit_events(entity_type, entity_id, created_at desc);
    create index if not exists rate_limit_buckets_reset_idx on rate_limit_buckets(reset_at);
  `);

  await query(`alter table hero_slides add column if not exists tablet_image_url text`);
  await query(`alter table hero_slides add column if not exists mobile_image_url text`);
  await query(`alter table hero_slides add column if not exists popup_image_url text`);
  await query(`alter table hero_slides add column if not exists popup_tablet_image_url text`);
  await query(`alter table hero_slides add column if not exists popup_mobile_image_url text`);
  await query(`alter table hero_slides add column if not exists popup_title text`);
  await query(`alter table hero_slides add column if not exists popup_text text`);
  await query(`alter table wholesale_price_lists add column if not exists manager_id bigint references wholesale_managers(id) on delete set null`);
  await query(`alter table wholesale_price_lists add column if not exists comment text not null default ''`);
  await query(`alter table admin_users add column if not exists email text not null default ''`);
  await query(`alter table admin_users add column if not exists role text not null default 'admin'`);
  await query(`alter table admin_users add column if not exists password_changed_at timestamptz`);
  await query(`alter table wholesale_managers add column if not exists phone text not null default ''`);
  await query(`alter table wholesale_managers add column if not exists password_hash text not null default ''`);
  await query(`alter table wholesale_managers add column if not exists password_changed_at timestamptz`);
  await query(`alter table wholesale_price_list_events add column if not exists actor_role text not null default ''`);
  await query(`alter table wholesale_price_list_events add column if not exists actor_label text not null default ''`);
  await query(`alter table wholesale_price_list_events add column if not exists owner_manager_id bigint references wholesale_managers(id) on delete set null`);
  await query(`alter table wholesale_price_list_events add column if not exists details text not null default ''`);
  await query(`create index if not exists admin_users_login_idx on admin_users(login)`);
  await query(`create index if not exists wholesale_analytics_events_manager_idx on wholesale_analytics_events(manager_id, created_at desc)`);
  await query(`create index if not exists wholesale_analytics_events_price_idx on wholesale_analytics_events(price_list_id, created_at desc)`);
  await query(`create index if not exists wholesale_analytics_events_client_idx on wholesale_analytics_events(client_id, created_at desc)`);
  await query(`create index if not exists wholesale_analytics_events_type_idx on wholesale_analytics_events(event_type, created_at desc)`);
  await query(`create index if not exists wholesale_analytics_events_actor_idx on wholesale_analytics_events(actor_type, created_at desc)`);
  await query(`create index if not exists wholesale_analytics_events_session_idx on wholesale_analytics_events(session_id, created_at desc)`);
  await query(`create index if not exists wholesale_analytics_events_token_idx on wholesale_analytics_events(token, created_at desc)`);
  await query(`create table if not exists admin_sessions (
    id uuid primary key,
    session_hash text not null unique,
    role text not null,
    admin_user_id bigint references admin_users(id) on delete cascade,
    manager_id bigint references wholesale_managers(id) on delete cascade,
    ip_hash text not null default '',
    user_agent text not null default '',
    created_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    expires_at timestamptz not null,
    revoked_at timestamptz
  )`);
  await query(`create index if not exists admin_sessions_admin_user_idx on admin_sessions(admin_user_id, created_at desc)`);
  await query(`create index if not exists admin_sessions_manager_idx on admin_sessions(manager_id, created_at desc)`);
  await query(`create index if not exists admin_sessions_expires_idx on admin_sessions(expires_at)`);
  await query(`create index if not exists admin_sessions_revoked_idx on admin_sessions(revoked_at)`);
  await query(`create table if not exists admin_2fa_challenges (
    id uuid primary key,
    login text not null default '',
    actor_type text not null default 'admin',
    role text not null default 'admin',
    admin_user_id bigint references admin_users(id) on delete cascade,
    manager_id bigint references wholesale_managers(id) on delete cascade,
    code_hash text not null,
    login_session_id text not null default '',
    attempts integer not null default 0,
    expires_at timestamptz not null,
    consumed_at timestamptz,
    created_at timestamptz not null default now()
  )`);
  await query(`create index if not exists admin_2fa_challenges_login_idx on admin_2fa_challenges(login, created_at desc)`);
  await query(`create index if not exists admin_2fa_challenges_session_idx on admin_2fa_challenges(login_session_id, created_at desc)`);
  await query(`create index if not exists admin_2fa_challenges_expires_idx on admin_2fa_challenges(expires_at)`);
  await query(`create table if not exists security_audit_events (
    id bigserial primary key,
    event_type text not null,
    actor_type text not null default 'system',
    admin_user_id bigint references admin_users(id) on delete set null,
    manager_id bigint references wholesale_managers(id) on delete set null,
    session_id text not null default '',
    login text not null default '',
    entity_type text not null default '',
    entity_id text not null default '',
    ip_hash text not null default '',
    user_agent text not null default '',
    referer text not null default '',
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  )`);
  await query(`create index if not exists security_audit_events_type_idx on security_audit_events(event_type, created_at desc)`);
  await query(`create index if not exists security_audit_events_actor_idx on security_audit_events(actor_type, created_at desc)`);
  await query(`create index if not exists security_audit_events_admin_user_idx on security_audit_events(admin_user_id, created_at desc)`);
  await query(`create index if not exists security_audit_events_manager_idx on security_audit_events(manager_id, created_at desc)`);
  await query(`create index if not exists security_audit_events_session_idx on security_audit_events(session_id, created_at desc)`);
  await query(`create index if not exists security_audit_events_entity_idx on security_audit_events(entity_type, entity_id, created_at desc)`);
  await query(`create table if not exists rate_limit_buckets (
    key text primary key,
    count integer not null default 0,
    reset_at timestamptz not null,
    updated_at timestamptz not null default now()
  )`);
  await query(`create index if not exists rate_limit_buckets_reset_idx on rate_limit_buckets(reset_at)`);

  await seedSiteSettings();
  await seedHeroSlides();
  await seedNewsItems();
  await seedBrandPortfolio();
  await seedGroupCompanies();
}

async function seedSiteSettings() {
  await query(
    `insert into site_settings (key, value)
     values ('phone', $1)
     on conflict (key) do nothing`,
    [DEFAULT_PHONE],
  );
  await query(
    `insert into site_settings (key, value)
     values ('email', $1), ('address', $2)
     on conflict (key) do nothing`,
    [DEFAULT_EMAIL, DEFAULT_ADDRESS],
  );
}

async function seedHeroSlides() {
  const count = await query<{ count: string }>('select count(*)::text as count from hero_slides');
  if (Number(count.rows[0]?.count ?? 0) !== 0) return;

  for (const slide of DEFAULT_HERO_SLIDES) {
    await query(
      `insert into hero_slides (
         title, image_url, tablet_image_url, mobile_image_url,
         popup_image_url, popup_tablet_image_url, popup_mobile_image_url, popup_title, popup_text,
         link_url, sort_order, is_active
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        slide.title,
        slide.imageUrl,
        slide.tabletImageUrl,
        slide.mobileImageUrl,
        slide.popupImageUrl,
        slide.popupTabletImageUrl,
        slide.popupMobileImageUrl,
        slide.popupTitle,
        slide.popupText,
        slide.linkUrl,
        slide.sortOrder,
        slide.isActive,
      ],
    );
  }
}

async function seedNewsItems() {
  const newsCount = await query<{ count: string }>('select count(*)::text as count from news_items');
  if (Number(newsCount.rows[0]?.count ?? 0) !== 0) return;

  for (const item of DEFAULT_NEWS) {
    await query(
      `insert into news_items (date_label, title, image_url, link_url, sort_order, is_active)
       values ($1, $2, $3, $4, $5, $6)`,
      [item.date, item.title, item.imageUrl, item.linkUrl, item.sortOrder, item.isActive],
    );
  }
}

async function seedBrandPortfolio() {
  const brandCategoryCount = await query<{ count: string }>('select count(*)::text as count from brand_categories');
  if (Number(brandCategoryCount.rows[0]?.count ?? 0) === 0) {
    for (const category of DEFAULT_BRAND_CATEGORIES) {
      await query(
        `insert into brand_categories (key, title, sort_order, is_active)
         values ($1, $2, $3, $4)`,
        [category.key, category.title, category.sortOrder, category.isActive],
      );
    }
  }

  const brandItemCount = await query<{ count: string }>('select count(*)::text as count from brand_items');
  if (Number(brandItemCount.rows[0]?.count ?? 0) !== 0) return;

  const categories = await query<{ id: string; key: string }>('select id, key from brand_categories');
  const categoryIdByKey = new Map(categories.rows.map((row) => [row.key, Number(row.id)]));
  for (const item of DEFAULT_BRAND_ITEMS) {
    const categoryId = categoryIdByKey.get(item.categoryKey);
    if (!categoryId) continue;
    await query(
      `insert into brand_items (category_id, name, image_url, icon_key, sort_order, is_active)
       values ($1, $2, $3, $4, $5, $6)`,
      [categoryId, item.name, item.imageUrl, item.iconKey, item.sortOrder, item.isActive],
    );
  }
}

async function seedGroupCompanies() {
  const groupCompanyCount = await query<{ count: string }>('select count(*)::text as count from group_companies');
  if (Number(groupCompanyCount.rows[0]?.count ?? 0) !== 0) return;

  for (const company of DEFAULT_GROUP_COMPANIES) {
    await query(
      `insert into group_companies (image_url, sort_order, is_active)
       values ($1, $2, $3)`,
      [company.imageUrl, company.sortOrder, company.isActive],
    );
  }
}
