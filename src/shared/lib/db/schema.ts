import { query } from './client';
import { applySchemaMigrations } from './migrations';
import { seedBrandPortfolio, seedGroupCompanies, seedHeroSlides, seedNewsItems, seedSiteSettings } from './schemaSeeds';

export async function ensureSiteSchema() {
  siteSchemaReady ??= ensureSiteSchemaInternal().catch((error) => {
    siteSchemaReady = null;
    throw error;
  });
  return siteSchemaReady;
}

let siteSchemaReady: Promise<void> | null = null;

async function ensureSiteSchemaInternal() {
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
      name text not null default '',
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
      link_url text not null default '',
      sort_order integer not null default 0,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists price_group_images (
      price_group text primary key,
      image_url text not null default '',
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
      catalog_product_id bigint,
      category_id bigint references wholesale_categories(id) on delete set null,
      title text not null default '',
      sku text not null default '',
      model text not null default '',
      series_description text not null default '',
      brand_title text not null default '',
      subcategory_title text not null default '',
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
      role text not null default 'manager',
      support_manager_id bigint references wholesale_managers(id) on delete set null,
      password_hash text not null default '',
      display_password text not null default '',
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
      support_manager_id bigint references wholesale_managers(id) on delete set null,
      valid_until date,
      token text not null unique,
      comment text not null default '',
      workflow_status text not null default 'not_sent',
      show_retail_prices boolean not null default false,
      show_stock boolean not null default true,
      show_stock_text boolean not null default false,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists wholesale_price_list_group_stock_settings (
      id bigserial primary key,
      price_list_id bigint not null references wholesale_price_lists(id) on delete cascade,
      price_group text not null default '',
      show_stock_numbers boolean not null default false,
      show_stock_text boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique(price_list_id, price_group)
    );

    create table if not exists wholesale_price_list_items (
      id bigserial primary key,
      price_list_id bigint not null references wholesale_price_lists(id) on delete cascade,
      wholesale_product_id bigint not null references wholesale_products(id) on delete cascade,
      wholesale_variant_id bigint references wholesale_product_variants(id) on delete cascade,
      custom_wholesale_price numeric(12, 2),
      discount_percent numeric(7, 2),
      price_manually_changed boolean not null default false,
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

    create table if not exists client_companies (
      id bigserial primary key,
      title text not null default '',
      inn text not null default '',
      kpp text not null default '',
      contact_name text not null default '',
      email text not null default '',
      phone text not null default '',
      address text not null default '',
      note text not null default '',
      manager_id bigint references wholesale_managers(id) on delete set null,
      support_manager_id bigint references wholesale_managers(id) on delete set null,
      require_2fa boolean not null default false,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists client_users (
      id bigserial primary key,
      company_id bigint not null references client_companies(id) on delete cascade,
      name text not null default '',
      email text not null default '',
      phone text not null default '',
      login text not null default '',
      password_hash text not null default '',
      display_password text not null default '',
      is_active boolean not null default true,
      password_changed_at timestamptz,
      last_login_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists client_sessions (
      id uuid primary key,
      session_hash text not null unique,
      client_user_id bigint not null references client_users(id) on delete cascade,
      ip_hash text not null default '',
      user_agent text not null default '',
      created_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      expires_at timestamptz not null,
      revoked_at timestamptz
    );

    create table if not exists client_chat_messages (
      id bigserial primary key,
      company_id bigint not null references client_companies(id) on delete cascade,
      client_user_id bigint references client_users(id) on delete set null,
      admin_user_id bigint references admin_users(id) on delete set null,
      manager_id bigint references wholesale_managers(id) on delete set null,
      author_type text not null default 'client',
      author_name text not null default '',
      body text not null default '',
      created_at timestamptz not null default now()
    );

    create table if not exists client_chat_read_state (
      company_id bigint primary key references client_companies(id) on delete cascade,
      client_read_at timestamptz not null default 'epoch'::timestamptz,
      employee_read_at timestamptz not null default 'epoch'::timestamptz,
      updated_at timestamptz not null default now()
    );

    create table if not exists client_documents (
      id bigserial primary key,
      company_id bigint not null references client_companies(id) on delete cascade,
      title text not null default '',
      original_name text not null default '',
      mime_type text not null default '',
      file_path text not null default '',
      file_size bigint not null default 0,
      is_visible boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table if not exists client_price_requests (
      id bigserial primary key,
      company_id bigint not null references client_companies(id) on delete cascade,
      price_list_id bigint references wholesale_price_lists(id) on delete set null,
      token text not null default '',
      price_title text not null default '',
      client_name text not null default '',
      manager_id bigint references wholesale_managers(id) on delete set null,
      support_manager_id bigint references wholesale_managers(id) on delete set null,
      comment text not null default '',
      total_quantity integer not null default 0,
      total_price_label text not null default '',
      total_converted_rub numeric(14, 2),
      rub_conversion_info text not null default '',
      converted_breakdown_label text not null default '',
      items_json jsonb not null default '[]'::jsonb,
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
      client_user_id bigint references client_users(id) on delete cascade,
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

    create table if not exists stock_import_logs (
      id bigserial primary key,
      created_at timestamptz not null default now(),
      file_name text not null default '',
      email_from text not null default '',
      email_subject text not null default '',
      status text not null default 'failed',
      total_rows integer not null default 0,
      updated_rows integer not null default 0,
      not_found_rows integer not null default 0,
      failed_rows integer not null default 0,
      errors_json jsonb not null default '[]'::jsonb
    );

    create table if not exists stock_import_locks (
      key text primary key,
      locked_at timestamptz not null default now()
    );

    alter table wholesale_price_lists add column if not exists manager_id bigint references wholesale_managers(id) on delete set null;
    alter table wholesale_price_lists add column if not exists support_manager_id bigint references wholesale_managers(id) on delete set null;
    alter table wholesale_price_lists add column if not exists comment text not null default '';
    alter table wholesale_price_lists add column if not exists workflow_status text not null default 'not_sent';
    alter table wholesale_price_lists add column if not exists show_stock boolean not null default true;
    alter table wholesale_products add column if not exists catalog_product_id bigint;
    alter table wholesale_products add column if not exists brand_title text not null default '';
    alter table wholesale_products add column if not exists model text not null default '';
    alter table wholesale_products add column if not exists subcategory_title text not null default '';
    alter table wholesale_products add column if not exists price_group text not null default '';
    alter table wholesale_products add column if not exists unit text;
    alter table wholesale_products add column if not exists price_eur numeric(14, 2);
    alter table wholesale_products add column if not exists price_rub numeric(14, 2);
    alter table wholesale_products add column if not exists price_cny numeric(14, 2);
    alter table wholesale_products add column if not exists price_usd numeric(14, 2);
    alter table wholesale_products add column if not exists general_discount numeric(7, 2);
    alter table wholesale_products add column if not exists manual_discount numeric(7, 2);
    alter table wholesale_products add column if not exists manual_discount_rop numeric(7, 2);
    alter table wholesale_products add column if not exists stock integer not null default 0;
    alter table wholesale_products add column if not exists stock_volzhsk integer not null default 0;
    alter table wholesale_products add column if not exists stock_moscow integer not null default 0;
    alter table wholesale_products add column if not exists is_expected boolean not null default false;
    alter table wholesale_products add column if not exists stock_updated_at timestamptz;
    alter table admin_users add column if not exists email text not null default '';
    alter table admin_users add column if not exists name text not null default '';
    alter table admin_users add column if not exists role text not null default 'admin';
    alter table admin_users add column if not exists password_changed_at timestamptz;
    alter table wholesale_managers add column if not exists phone text not null default '';
    alter table wholesale_managers add column if not exists role text not null default 'manager';
    alter table wholesale_managers add column if not exists support_manager_id bigint references wholesale_managers(id) on delete set null;
    alter table wholesale_managers add column if not exists password_hash text not null default '';
    alter table wholesale_managers add column if not exists display_password text not null default '';
    alter table wholesale_managers add column if not exists password_changed_at timestamptz;
    alter table wholesale_price_list_events add column if not exists actor_role text not null default '';
    alter table wholesale_price_list_events add column if not exists actor_label text not null default '';
    alter table wholesale_price_list_events add column if not exists owner_manager_id bigint references wholesale_managers(id) on delete set null;
    alter table wholesale_price_list_events add column if not exists details text not null default '';
    alter table wholesale_price_list_events alter column price_list_id drop not null;
    alter table client_users add column if not exists password_changed_at timestamptz;
    alter table client_users add column if not exists display_password text not null default '';
    alter table client_companies add column if not exists require_2fa boolean not null default false;
    alter table wholesale_price_lists add column if not exists client_company_id bigint references client_companies(id) on delete set null;
    alter table admin_2fa_challenges add column if not exists client_user_id bigint references client_users(id) on delete cascade;

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
    create index if not exists wholesale_products_catalog_product_idx on wholesale_products(catalog_product_id);
    create index if not exists wholesale_product_images_product_idx on wholesale_product_images(product_id);
    create index if not exists wholesale_product_variants_product_idx on wholesale_product_variants(product_id);
    create index if not exists wholesale_managers_login_idx on wholesale_managers(login);
    create index if not exists wholesale_managers_role_idx on wholesale_managers(role);
    create index if not exists wholesale_managers_support_idx on wholesale_managers(support_manager_id);
    create index if not exists wholesale_price_list_items_price_list_idx on wholesale_price_list_items(price_list_id);
    create index if not exists wholesale_price_list_items_product_idx on wholesale_price_list_items(wholesale_product_id);
    create index if not exists wholesale_price_group_stock_settings_price_list_idx on wholesale_price_list_group_stock_settings(price_list_id);
    create index if not exists wholesale_price_lists_manager_idx on wholesale_price_lists(manager_id);
    create index if not exists wholesale_price_lists_client_company_idx on wholesale_price_lists(client_company_id);
    create index if not exists wholesale_price_lists_workflow_status_idx on wholesale_price_lists(workflow_status);
    create index if not exists wholesale_price_list_events_manager_idx on wholesale_price_list_events(manager_id, created_at desc);
    create index if not exists wholesale_price_list_events_owner_manager_idx on wholesale_price_list_events(owner_manager_id, created_at desc);
    create index if not exists wholesale_manager_login_logs_manager_idx on wholesale_manager_login_logs(manager_id, created_at desc);
    create index if not exists wholesale_price_view_logs_price_idx on wholesale_price_view_logs(price_list_id, created_at desc);
    create index if not exists client_companies_manager_idx on client_companies(manager_id, created_at desc);
    create index if not exists client_companies_support_manager_idx on client_companies(support_manager_id, created_at desc);
    create index if not exists client_companies_active_idx on client_companies(is_active, title);
    create index if not exists client_users_company_idx on client_users(company_id, created_at desc);
    create unique index if not exists client_users_email_unique_idx on client_users(lower(email)) where email <> '';
    create unique index if not exists client_users_login_unique_idx on client_users(lower(login)) where login <> '';
    create index if not exists client_sessions_user_idx on client_sessions(client_user_id, created_at desc);
    create index if not exists client_sessions_expires_idx on client_sessions(expires_at);
    create index if not exists client_sessions_revoked_idx on client_sessions(revoked_at);
    create index if not exists client_chat_messages_company_idx on client_chat_messages(company_id, created_at desc, id desc);
    create index if not exists client_chat_read_state_updated_idx on client_chat_read_state(updated_at desc);
    create index if not exists client_documents_company_idx on client_documents(company_id, created_at desc);
    create index if not exists client_documents_visible_idx on client_documents(company_id, is_visible, created_at desc);
    create index if not exists client_price_requests_company_idx on client_price_requests(company_id, created_at desc);
    create index if not exists client_price_requests_price_idx on client_price_requests(price_list_id, created_at desc);
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
    create index if not exists stock_import_logs_created_idx on stock_import_logs(created_at desc);
  `);

  await query(`alter table hero_slides add column if not exists tablet_image_url text`);
  await query(`alter table hero_slides add column if not exists mobile_image_url text`);
  await query(`alter table hero_slides add column if not exists popup_image_url text`);
  await query(`alter table hero_slides add column if not exists popup_tablet_image_url text`);
  await query(`alter table hero_slides add column if not exists popup_mobile_image_url text`);
  await query(`alter table hero_slides add column if not exists popup_title text`);
  await query(`alter table hero_slides add column if not exists popup_text text`);
  await query(`alter table group_companies add column if not exists link_url text not null default ''`);
  await query(`alter table wholesale_price_lists add column if not exists manager_id bigint references wholesale_managers(id) on delete set null`);
  await query(`alter table wholesale_price_lists add column if not exists support_manager_id bigint references wholesale_managers(id) on delete set null`);
  await query(`alter table wholesale_price_lists add column if not exists comment text not null default ''`);
  await query(`alter table wholesale_price_lists add column if not exists workflow_status text not null default 'not_sent'`);
  await query(`alter table wholesale_price_lists add column if not exists show_stock boolean not null default true`);
  await query(`alter table wholesale_price_lists add column if not exists show_stock_text boolean not null default false`);
  await query(`alter table wholesale_price_lists add column if not exists client_company_id bigint references client_companies(id) on delete set null`);
  await query(`alter table wholesale_price_list_items add column if not exists price_manually_changed boolean not null default false`);
  await query(`alter table wholesale_price_list_items add column if not exists discount_percent numeric(7, 2)`);
  await query(`
    create table if not exists wholesale_price_list_group_stock_settings (
      id bigserial primary key,
      price_list_id bigint not null references wholesale_price_lists(id) on delete cascade,
      price_group text not null default '',
      show_stock_numbers boolean not null default false,
      show_stock_text boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique(price_list_id, price_group)
    )
  `);
  await query(`alter table wholesale_products add column if not exists catalog_product_id bigint`);
  await query(`alter table wholesale_products add column if not exists brand_title text not null default ''`);
  await query(`alter table wholesale_products add column if not exists model text not null default ''`);
  await query(`alter table wholesale_products add column if not exists subcategory_title text not null default ''`);
  await query(`alter table wholesale_products add column if not exists price_group text not null default ''`);
  await query(`alter table wholesale_products add column if not exists unit text`);
  await query(`alter table wholesale_products add column if not exists price_eur numeric(14, 2)`);
  await query(`alter table wholesale_products add column if not exists price_rub numeric(14, 2)`);
  await query(`alter table wholesale_products add column if not exists price_cny numeric(14, 2)`);
  await query(`alter table wholesale_products add column if not exists price_usd numeric(14, 2)`);
  await query(`alter table wholesale_products add column if not exists general_discount numeric(7, 2)`);
  await query(`alter table wholesale_products add column if not exists manual_discount numeric(7, 2)`);
  await query(`alter table wholesale_products add column if not exists manual_discount_rop numeric(7, 2)`);
  await query(`alter table wholesale_products add column if not exists stock integer not null default 0`);
  await query(`alter table wholesale_products add column if not exists stock_volzhsk integer not null default 0`);
  await query(`alter table wholesale_products add column if not exists stock_moscow integer not null default 0`);
  await query(`alter table wholesale_products add column if not exists is_expected boolean not null default false`);
  await query(`alter table wholesale_products add column if not exists stock_updated_at timestamptz`);
  await query(`alter table admin_users add column if not exists email text not null default ''`);
  await query(`alter table admin_users add column if not exists name text not null default ''`);
  await query(`alter table admin_users add column if not exists role text not null default 'admin'`);
  await query(`alter table admin_users add column if not exists password_changed_at timestamptz`);
  await query(`alter table wholesale_managers add column if not exists phone text not null default ''`);
  await query(`alter table wholesale_managers add column if not exists role text not null default 'manager'`);
  await query(`alter table wholesale_managers add column if not exists support_manager_id bigint references wholesale_managers(id) on delete set null`);
  await query(`alter table wholesale_managers add column if not exists password_hash text not null default ''`);
  await query(`alter table wholesale_managers add column if not exists display_password text not null default ''`);
  await query(`alter table wholesale_managers add column if not exists password_changed_at timestamptz`);
  await query(`alter table client_companies add column if not exists require_2fa boolean not null default false`);
  await query(`alter table client_users add column if not exists display_password text not null default ''`);
  await query(`
    update wholesale_price_lists pl
    set support_manager_id = m.support_manager_id
    from wholesale_managers m
    where pl.manager_id = m.id
      and pl.support_manager_id is null
      and m.support_manager_id is not null
  `);
  await query(`alter table wholesale_price_list_events add column if not exists actor_role text not null default ''`);
  await query(`alter table wholesale_price_list_events add column if not exists actor_label text not null default ''`);
  await query(`alter table wholesale_price_list_events add column if not exists owner_manager_id bigint references wholesale_managers(id) on delete set null`);
  await query(`alter table wholesale_price_list_events add column if not exists details text not null default ''`);
  await query(`create index if not exists admin_users_login_idx on admin_users(login)`);
  await query(`create index if not exists wholesale_managers_role_idx on wholesale_managers(role)`);
  await query(`create index if not exists wholesale_managers_support_idx on wholesale_managers(support_manager_id)`);
  await query(`create index if not exists wholesale_price_lists_support_manager_idx on wholesale_price_lists(support_manager_id)`);
  await query(`create index if not exists wholesale_price_lists_client_company_idx on wholesale_price_lists(client_company_id)`);
  await query(`create index if not exists wholesale_products_catalog_product_idx on wholesale_products(catalog_product_id)`);
  await query(`create index if not exists wholesale_price_group_stock_settings_price_list_idx on wholesale_price_list_group_stock_settings(price_list_id)`);
  await query(`create index if not exists wholesale_analytics_events_manager_idx on wholesale_analytics_events(manager_id, created_at desc)`);
  await query(`create index if not exists wholesale_price_lists_workflow_status_idx on wholesale_price_lists(workflow_status)`);
  await query(`create index if not exists wholesale_analytics_events_price_idx on wholesale_analytics_events(price_list_id, created_at desc)`);
  await query(`create index if not exists wholesale_analytics_events_client_idx on wholesale_analytics_events(client_id, created_at desc)`);
  await query(`create index if not exists wholesale_analytics_events_type_idx on wholesale_analytics_events(event_type, created_at desc)`);
  await query(`create index if not exists wholesale_analytics_events_actor_idx on wholesale_analytics_events(actor_type, created_at desc)`);
  await query(`create index if not exists wholesale_analytics_events_session_idx on wholesale_analytics_events(session_id, created_at desc)`);
  await query(`create index if not exists wholesale_analytics_events_token_idx on wholesale_analytics_events(token, created_at desc)`);
  await query(`create table if not exists client_documents (
    id bigserial primary key,
    company_id bigint not null references client_companies(id) on delete cascade,
    title text not null default '',
    original_name text not null default '',
    mime_type text not null default '',
    file_path text not null default '',
    file_size bigint not null default 0,
    is_visible boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`);
  await query(`create index if not exists client_documents_company_idx on client_documents(company_id, created_at desc)`);
  await query(`create index if not exists client_documents_visible_idx on client_documents(company_id, is_visible, created_at desc)`);
  await query(`create table if not exists client_price_requests (
    id bigserial primary key,
    company_id bigint not null references client_companies(id) on delete cascade,
    price_list_id bigint references wholesale_price_lists(id) on delete set null,
    token text not null default '',
    price_title text not null default '',
    client_name text not null default '',
    manager_id bigint references wholesale_managers(id) on delete set null,
    support_manager_id bigint references wholesale_managers(id) on delete set null,
    comment text not null default '',
    total_quantity integer not null default 0,
    total_price_label text not null default '',
    total_converted_rub numeric(14, 2),
    rub_conversion_info text not null default '',
    converted_breakdown_label text not null default '',
    items_json jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now()
  )`);
  await query(`create index if not exists client_price_requests_company_idx on client_price_requests(company_id, created_at desc)`);
  await query(`create index if not exists client_price_requests_price_idx on client_price_requests(price_list_id, created_at desc)`);
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
    client_user_id bigint references client_users(id) on delete cascade,
    code_hash text not null,
    login_session_id text not null default '',
    attempts integer not null default 0,
    expires_at timestamptz not null,
    consumed_at timestamptz,
    created_at timestamptz not null default now()
  )`);
  await query(`alter table admin_2fa_challenges add column if not exists client_user_id bigint references client_users(id) on delete cascade`);
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
  await applySchemaMigrations();
}
