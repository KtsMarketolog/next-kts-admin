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
