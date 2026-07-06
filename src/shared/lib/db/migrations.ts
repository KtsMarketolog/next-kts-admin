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
