import type { PoolClient } from 'pg';

import { query, withTransaction } from './client';

type SchemaMigration = {
  id: string;
  description: string;
  apply: (client: PoolClient) => Promise<void>;
};

const SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    id: '202606010001_runtime_schema_baseline',
    description: 'Record the existing ensureSiteSchema runtime DDL as the migration baseline',
    apply: async () => {},
  },
  {
    id: '202606010002_price_item_manual_price_flag',
    description: 'Track manually edited wholesale price list item prices',
    apply: async (client) => {
      await client.query(`
        alter table wholesale_price_list_items
        add column if not exists price_manually_changed boolean not null default false
      `);
    },
  },
  {
    id: '202607060001_price_item_discount_percent',
    description: 'Store calculated wholesale price list discounts as percentages',
    apply: async (client) => {
      await client.query(`
        alter table wholesale_price_list_items
        add column if not exists discount_percent numeric(7, 2)
      `);
    },
  },
  {
    id: '202607060002_backfill_price_item_discount_percent',
    description: 'Backfill calculated wholesale price list discount percentages',
    apply: async (client) => {
      await client.query(`
        with item_bases as (
          select
            i.id,
            i.custom_wholesale_price,
            coalesce(
              p.price_rub,
              p.price_eur,
              p.price_cny,
              coalesce(v.retail_price, p.retail_price),
              coalesce(v.wholesale_price, p.wholesale_price)
            ) as base_price
          from wholesale_price_list_items i
          join wholesale_products p on p.id = i.wholesale_product_id
          left join wholesale_product_variants v on v.id = i.wholesale_variant_id and v.product_id = p.id
          where i.discount_percent is null
            and i.price_manually_changed = false
            and i.custom_wholesale_price is not null
        ),
        inferred_discounts as (
          select
            id,
            round((1 - custom_wholesale_price / base_price) * 100, 2) as discount_percent
          from item_bases
          where base_price is not null
            and base_price > 0
            and custom_wholesale_price >= base_price * 0.4
            and custom_wholesale_price <= base_price
        )
        update wholesale_price_list_items i
        set discount_percent = inferred_discounts.discount_percent,
            updated_at = now()
        from inferred_discounts
        where i.id = inferred_discounts.id
          and inferred_discounts.discount_percent between 0 and 60
      `);
    },
  },
];

async function ensureSchemaMigrationsTable() {
  await query(`
    create table if not exists schema_migrations (
      id text primary key,
      description text not null default '',
      applied_at timestamptz not null default now()
    )
  `);
}

export async function applySchemaMigrations() {
  await ensureSchemaMigrationsTable();

  for (const migration of SCHEMA_MIGRATIONS) {
    await withTransaction(async (client) => {
      await client.query(`select pg_advisory_xact_lock(hashtext($1::text))`, ['kts_schema_migrations']);

      const existing = await client.query<{ id: string }>(
        `select id from schema_migrations where id = $1`,
        [migration.id],
      );
      if (existing.rowCount) return;

      await migration.apply(client);
      await client.query(
        `insert into schema_migrations (id, description) values ($1, $2)`,
        [migration.id, migration.description],
      );
    });
  }
}
