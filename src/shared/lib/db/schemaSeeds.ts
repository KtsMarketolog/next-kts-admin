import { DEFAULT_BRAND_CATEGORIES, DEFAULT_BRAND_ITEMS } from '@/entities/site/model/defaultBrands';
import { DEFAULT_GROUP_COMPANIES } from '@/entities/site/model/defaultGroupCompanies';
import { DEFAULT_HERO_SLIDES } from '@/entities/site/model/defaultSlides';
import { DEFAULT_NEWS } from '@/entities/site/model/defaultNews';
import type { PoolClient } from 'pg';

import { DEFAULT_ADDRESS, DEFAULT_EMAIL, DEFAULT_PHONE } from '../phone';
import { query, withTransaction } from './client';

export async function seedSiteSettings() {
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

async function seedHeroSlides(client: PoolClient) {
  for (const slide of DEFAULT_HERO_SLIDES) {
    await client.query(
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

async function seedNewsItems(client: PoolClient) {
  for (const item of DEFAULT_NEWS) {
    await client.query(
      `insert into news_items (date_label, title, image_url, link_url, sort_order, is_active)
       values ($1, $2, $3, $4, $5, $6)`,
      [item.date, item.title, item.imageUrl, item.linkUrl, item.sortOrder, item.isActive],
    );
  }
}

async function seedBrandPortfolio(client: PoolClient) {
  for (const category of DEFAULT_BRAND_CATEGORIES) {
    await client.query(
      `insert into brand_categories (key, title, sort_order, is_active)
       values ($1, $2, $3, $4)`,
      [category.key, category.title, category.sortOrder, category.isActive],
    );
  }
  const categories = await client.query<{ id: string; key: string }>('select id, key from brand_categories');
  const categoryIdByKey = new Map(categories.rows.map((row) => [row.key, Number(row.id)]));
  for (const item of DEFAULT_BRAND_ITEMS) {
    const categoryId = categoryIdByKey.get(item.categoryKey);
    if (!categoryId) throw new Error('Не найдена категория стартового бренда. Первоначальное заполнение отменено.');
    await client.query(
      `insert into brand_items (category_id, name, image_url, icon_key, sort_order, is_active)
       values ($1, $2, $3, $4, $5, $6)`,
      [categoryId, item.name, item.imageUrl, item.iconKey, item.sortOrder, item.isActive],
    );
  }
}

async function seedGroupCompanies(client: PoolClient) {
  for (const company of DEFAULT_GROUP_COMPANIES) {
    await client.query(
      `insert into group_companies (image_url, link_url, sort_order, is_active)
       values ($1, $2, $3, $4)`,
      [company.imageUrl, company.linkUrl, company.sortOrder, company.isActive],
    );
  }
}

const BOOTSTRAP_TABLE = 'site_content_bootstrap';
const CONTENT_TABLES = ['hero_slides', 'news_items', 'brand_categories', 'brand_items', 'group_companies'];

function quotedIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function lockBootstrap(client: PoolClient) {
  const result = await client.query<{ schema: string | null }>('select current_schema() as schema');
  const schema = result.rows[0]?.schema;
  if (!schema) throw new Error('Не найдена рабочая схема БД. Первоначальное заполнение отменено.');
  await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [`kts_initial_site_content:${schema}`]);
  return { schema, marker: `${quotedIdentifier(schema)}.${quotedIdentifier(BOOTSTRAP_TABLE)}` };
}

/** CLI only, before ensureSiteSchema(): empty content tables alone are never proof of a new installation. */
export async function reserveInitialSiteContentBootstrap(): Promise<'pending' | 'complete'> {
  return withTransaction(async (client) => {
    const { schema, marker } = await lockBootstrap(client);
    const relations = await client.query<{ relname: string }>(
      `select relname from pg_class where relnamespace = (select oid from pg_namespace where nspname = $1)`,
      [schema],
    );
    if (relations.rows.some((row) => row.relname === BOOTSTRAP_TABLE)) {
      const existing = await client.query<{ state: string }>(`select state from ${marker} where id = 1 for update`);
      const state = existing.rows[0]?.state;
      if (state === 'pending' || state === 'complete') return state;
      throw new Error('Не найдена сохранённая заявка первоначального заполнения. Изменения не внесены.');
    }
    if (relations.rows.length > 0) {
      throw new Error('База уже инициализирована. Первоначальный контент можно добавить только в новую пустую схему до первого запуска сайта.');
    }
    await client.query(`
      create table ${marker} (
        id smallint primary key check (id = 1),
        state text not null check (state in ('pending', 'complete')),
        created_at timestamptz not null default now(),
        completed_at timestamptz,
        check ((state = 'complete') = (completed_at is not null))
      );
      insert into ${marker} (id, state) values (1, 'pending');
    `);
    return 'pending';
  }, { profile: 'schema', trackCommitOutcome: true, retryOnConflict: true });
}

/** All content and the permanent completion marker commit together. Never called by normal startup. */
export async function completeInitialSiteContentBootstrap(): Promise<'seeded' | 'already-complete'> {
  return withTransaction(async (client) => {
    const { schema, marker } = await lockBootstrap(client);
    const existing = await client.query<{ state: string }>(`select state from ${marker} where id = 1 for update`);
    const state = existing.rows[0]?.state;
    if (state === 'complete') return 'already-complete';
    if (state !== 'pending') throw new Error('Первоначальное заполнение не было явно разрешено. Изменения не внесены.');

    const contentTables = CONTENT_TABLES.map((name) => `${quotedIdentifier(schema)}.${quotedIdentifier(name)}`);
    await client.query(`lock table ${contentTables.join(', ')} in share row exclusive mode`);
    const content = await client.query<{ has_content: boolean }>(
      `select ${contentTables.map((table) => `exists (select 1 from ${table})`).join(' or ')} as has_content`,
    );
    if (content.rows[0]?.has_content !== false) {
      throw new Error('В разделах уже есть контент. Первоначальное заполнение отменено; существующие записи сохранены.');
    }
    await seedHeroSlides(client);
    await seedNewsItems(client);
    await seedBrandPortfolio(client);
    await seedGroupCompanies(client);
    await client.query(`update ${marker} set state = 'complete', completed_at = now() where id = 1`);
    return 'seeded';
  }, { profile: 'schema', trackCommitOutcome: true, retryOnConflict: true });
}
