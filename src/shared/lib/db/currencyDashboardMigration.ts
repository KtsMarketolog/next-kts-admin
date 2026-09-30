import type { PoolClient } from 'pg';

/** Additive only: never modifies TOP reports, manager snapshots, or price lists. */
export async function applyCurrencyDashboardMigration(client: PoolClient) {
  await client.query(`
    create table currency_dashboard_state (
      id smallint primary key check (id = 1),
      revision bigint not null default 0 check (revision between 0 and 9007199254740991),
      current_snapshot jsonb,
      previous_snapshot jsonb,
      updated_at timestamptz not null default now(),
      check (current_snapshot is null or jsonb_typeof(current_snapshot) = 'object'),
      check (previous_snapshot is null or jsonb_typeof(previous_snapshot) = 'object'),
      check (previous_snapshot is null or current_snapshot is not null)
    );
    insert into currency_dashboard_state(id) values (1);
    create table currency_dashboard_cache (
      key text primary key check (key ~ '^[a-z0-9][a-z0-9:._-]{0,199}$'),
      value jsonb not null,
      fetched_at timestamptz not null,
      updated_at timestamptz not null default now()
    );
    create table currency_dashboard_baselines (
      date date not null check (date between date '2026-01-01' and date '2100-12-31'),
      asset text not null check (asset in ('COPPER', 'BR')),
      value jsonb not null check (jsonb_typeof(value) = 'object'),
      created_at timestamptz not null default now(),
      primary key (date, asset)
    );
  `);
}
