import type { PoolClient } from 'pg';

import {
  TOP_DASHBOARD_DATA_MAX_BYTES,
  TOP_DASHBOARD_DATA_MAX_UNCOMPRESSED_BYTES,
} from '../topDashboardLimits';
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
  {
    id: '202608200001_top_dashboard_versions',
    description: 'Store private versioned TOP dashboard HTML and active publication state',
    apply: async (client) => {
      await client.query(`
        create table if not exists top_dashboard_versions (
          id bigserial primary key,
          original_name text not null,
          html_content text not null,
          file_size bigint not null check (file_size between 1 and 5242880),
          sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
          uploaded_by_admin_user_id bigint references admin_users(id) on delete set null,
          first_published_at timestamptz,
          first_published_by_admin_user_id bigint references admin_users(id) on delete set null,
          created_at timestamptz not null default now()
        );

        create table if not exists top_dashboard_state (
          id smallint primary key check (id = 1),
          active_version_id bigint references top_dashboard_versions(id) on delete restrict,
          previous_version_id bigint references top_dashboard_versions(id) on delete restrict,
          updated_by_admin_user_id bigint references admin_users(id) on delete set null,
          updated_at timestamptz not null default now(),
          check (
            active_version_id is null
            or previous_version_id is null
            or active_version_id <> previous_version_id
          )
        );

        insert into top_dashboard_state (id)
        values (1)
        on conflict (id) do nothing;

        create index if not exists top_dashboard_versions_created_idx
          on top_dashboard_versions(created_at desc, id desc);
      `);
    },
  },
  {
    id: '202608230001_top_dashboard_blocks',
    description: 'Add unlimited independently versioned TOP dashboard blocks while preserving the legacy dashboard',
    apply: async (client) => {
      await client.query(`
        create table top_dashboard_blocks (
          id bigserial primary key,
          title text not null check (
            char_length(title) between 1 and 120
            and title = btrim(title)
          ),
          storage_kind text not null check (storage_kind in ('legacy', 'native')),
          created_by_admin_user_id bigint references admin_users(id) on delete set null,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          check (storage_kind <> 'legacy' or id = 1)
        );

        create unique index top_dashboard_blocks_single_legacy_idx
          on top_dashboard_blocks (storage_kind)
          where storage_kind = 'legacy';

        insert into top_dashboard_blocks (id, title, storage_kind)
        values (1, 'Стратегический обзор', 'legacy');

        select setval(
          pg_get_serial_sequence('top_dashboard_blocks', 'id'),
          (select max(id) from top_dashboard_blocks),
          true
        );

        create table top_dashboard_block_versions (
          block_id bigint not null references top_dashboard_blocks(id) on delete cascade,
          id bigserial not null,
          original_name text not null,
          html_content text not null,
          file_size bigint not null check (file_size between 1 and 5242880),
          sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
          uploaded_by_admin_user_id bigint references admin_users(id) on delete set null,
          first_published_at timestamptz,
          first_published_by_admin_user_id bigint references admin_users(id) on delete set null,
          created_at timestamptz not null default now(),
          primary key (block_id, id)
        );

        create table top_dashboard_block_state (
          block_id bigint primary key references top_dashboard_blocks(id) on delete cascade,
          active_version_id bigint,
          previous_version_id bigint,
          updated_by_admin_user_id bigint references admin_users(id) on delete set null,
          updated_at timestamptz not null default now(),
          check (
            active_version_id is null
            or previous_version_id is null
            or active_version_id <> previous_version_id
          ),
          foreign key (block_id, active_version_id)
            references top_dashboard_block_versions(block_id, id) on delete restrict,
          foreign key (block_id, previous_version_id)
            references top_dashboard_block_versions(block_id, id) on delete restrict
        );

        create index top_dashboard_block_versions_created_idx
          on top_dashboard_block_versions(block_id, created_at desc, id desc);
      `);
    },
  },
  {
    id: '202608230002_remove_legacy_top_dashboard',
    description: 'Remove the superseded single TOP dashboard storage and keep native blocks only',
    apply: async (client) => {
      await client.query(`
        delete from top_dashboard_block_state
        where block_id in (
          select id from top_dashboard_blocks where storage_kind = 'legacy'
        );

        delete from top_dashboard_block_versions
        where block_id in (
          select id from top_dashboard_blocks where storage_kind = 'legacy'
        );

        delete from top_dashboard_blocks
        where storage_kind = 'legacy';

        drop table if exists top_dashboard_state;
        drop table if exists top_dashboard_versions;

        alter table top_dashboard_blocks
          drop column storage_kind;
      `);
    },
  },
  {
    id: '202608240001_manager_top_dashboard_access',
    description: 'Grant optional TOP dashboard access to wholesale managers and attribute their TOP changes',
    apply: async (client) => {
      await client.query(`
        alter table wholesale_managers
          add column if not exists can_access_top_dashboard boolean not null default false;

        alter table top_dashboard_blocks
          add column if not exists created_by_manager_id bigint
            references wholesale_managers(id) on delete set null;

        alter table top_dashboard_block_versions
          add column if not exists uploaded_by_manager_id bigint
            references wholesale_managers(id) on delete set null,
          add column if not exists first_published_by_manager_id bigint
            references wholesale_managers(id) on delete set null;

        alter table top_dashboard_block_state
          add column if not exists updated_by_manager_id bigint
            references wholesale_managers(id) on delete set null;
      `);
    },
  },
  {
    id: '202608240002_top_dashboard_block_data_versions',
    description: 'Store versioned compressed data snapshots independently for every TOP dashboard block',
    apply: async (client) => {
      await client.query(`
        create table top_dashboard_block_data_versions (
          block_id bigint not null references top_dashboard_blocks(id) on delete cascade,
          id bigserial not null,
          original_name text not null,
          compressed_payload bytea not null,
          file_size bigint not null check (
            file_size between 1 and 16777216
            and file_size = octet_length(compressed_payload)
          ),
          uncompressed_size bigint not null check (
            uncompressed_size between 1 and 134217728
          ),
          sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
          snapshot_format text not null check (
            snapshot_format in ('kts-bundle-v1', 'purchases-v1')
          ),
          dashboard_profile text not null check (
            dashboard_profile in ('sales-analytics', 'assortment-optimization', 'purchases')
          ),
          check (
            (snapshot_format = 'purchases-v1' and dashboard_profile = 'purchases')
            or (
              snapshot_format = 'kts-bundle-v1'
              and dashboard_profile is distinct from 'purchases'
            )
          ),
          uploaded_by_admin_user_id bigint references admin_users(id) on delete set null,
          uploaded_by_manager_id bigint references wholesale_managers(id) on delete set null,
          created_at timestamptz not null default now(),
          primary key (block_id, id),
          check (
            uploaded_by_admin_user_id is null
            or uploaded_by_manager_id is null
          )
        );

        create table top_dashboard_block_data_state (
          block_id bigint primary key references top_dashboard_blocks(id) on delete cascade,
          active_version_id bigint,
          previous_version_id bigint,
          updated_by_admin_user_id bigint references admin_users(id) on delete set null,
          updated_by_manager_id bigint references wholesale_managers(id) on delete set null,
          updated_at timestamptz not null default now(),
          check (
            active_version_id is null
            or previous_version_id is null
            or active_version_id <> previous_version_id
          ),
          check (
            updated_by_admin_user_id is null
            or updated_by_manager_id is null
          ),
          foreign key (block_id, active_version_id)
            references top_dashboard_block_data_versions(block_id, id) on delete restrict,
          foreign key (block_id, previous_version_id)
            references top_dashboard_block_data_versions(block_id, id) on delete restrict
        );

        insert into top_dashboard_block_data_state (block_id)
        select id from top_dashboard_blocks
        on conflict (block_id) do nothing;

        create index top_dashboard_block_data_versions_created_idx
          on top_dashboard_block_data_versions(block_id, created_at desc, id desc);
      `);
    },
  },
  {
    id: '202608250001_admin_user_top_management_access',
    description: 'Grant optional TOP dashboard management while preserving the TOP primary role',
    apply: async (client) => {
      await client.query(`
        alter table admin_users
          add column if not exists can_manage_top_dashboard boolean not null default false;

        do $$
        begin
          if not exists (
            select 1
            from pg_constraint
            where conrelid = 'admin_users'::regclass
              and conname = 'admin_users_top_management_role_check'
          ) then
            alter table admin_users
              add constraint admin_users_top_management_role_check check (
                can_manage_top_dashboard = false or role = 'top'
              );
          end if;
        end $$;
      `);
    },
  },
  {
    id: '202608250002_manager_top_dashboard_management_access',
    description: 'Grant optional TOP dashboard management to wholesale managers without changing their primary role',
    apply: async (client) => {
      await client.query(`
        alter table wholesale_managers
          add column if not exists can_manage_top_dashboard boolean not null default false;

        update wholesale_managers
        set can_access_top_dashboard = true
        where can_manage_top_dashboard = true
          and can_access_top_dashboard = false;

        do $$
        begin
          if not exists (
            select 1
            from pg_constraint
            where conrelid = 'wholesale_managers'::regclass
              and conname = 'wholesale_managers_top_management_access_check'
          ) then
            alter table wholesale_managers
              add constraint wholesale_managers_top_management_access_check check (
                can_manage_top_dashboard = false or can_access_top_dashboard = true
              );
          end if;
        end $$;
      `);
    },
  },
  {
    id: '202608310001_top_dashboard_data_upload_limits',
    description: 'Increase TOP dashboard data uploads to 100 MiB with a bounded unpacked size',
    apply: async (client) => {
      await client.query(`
        alter table top_dashboard_block_data_versions
          drop constraint if exists top_dashboard_block_data_versions_file_size_check,
          drop constraint if exists top_dashboard_block_data_versions_uncompressed_size_check;

        alter table top_dashboard_block_data_versions
          add constraint top_dashboard_block_data_versions_file_size_check check (
            file_size between 1 and ${TOP_DASHBOARD_DATA_MAX_BYTES}
            and file_size = octet_length(compressed_payload)
          ),
          add constraint top_dashboard_block_data_versions_uncompressed_size_check check (
            uncompressed_size between 1 and ${TOP_DASHBOARD_DATA_MAX_UNCOMPRESSED_BYTES}
          );
      `);
    },
  },
  {
    id: '202609020001_top_dashboard_multi_file_snapshots',
    description: 'Bind universal multi-file TOP snapshots to their exact HTML version',
    apply: async (client) => {
      await client.query(`
        alter table top_dashboard_block_data_versions
          add column bound_html_version_id bigint;

        do $$
        declare
          contract_constraint_name text;
        begin
          for contract_constraint_name in
            select constraint_name.conname
            from pg_constraint constraint_name
            where constraint_name.conrelid = 'top_dashboard_block_data_versions'::regclass
              and constraint_name.contype = 'c'
              and position(
                'snapshot_format' in pg_get_constraintdef(constraint_name.oid)
              ) > 0
              and position(
                'dashboard_profile' in pg_get_constraintdef(constraint_name.oid)
              ) > 0
          loop
            execute format(
              'alter table top_dashboard_block_data_versions drop constraint %I',
              contract_constraint_name
            );
          end loop;
        end $$;

        alter table top_dashboard_block_data_versions
          drop constraint if exists top_dashboard_block_data_versions_snapshot_format_check,
          drop constraint if exists top_dashboard_block_data_versions_dashboard_profile_check,
          drop constraint if exists top_dashboard_block_data_versions_check;

        alter table top_dashboard_block_data_versions
          add constraint top_dashboard_block_data_versions_snapshot_format_check check (
            snapshot_format in ('kts-bundle-v1', 'purchases-v1', 'multi-file-v1')
          ),
          add constraint top_dashboard_block_data_versions_dashboard_profile_check check (
            dashboard_profile in (
              'sales-analytics',
              'assortment-optimization',
              'purchases',
              'generic'
            )
          ),
          add constraint top_dashboard_block_data_versions_contract_check check (
            (
              snapshot_format = 'purchases-v1'
              and dashboard_profile = 'purchases'
              and bound_html_version_id is null
            )
            or (
              snapshot_format = 'kts-bundle-v1'
              and dashboard_profile in ('sales-analytics', 'assortment-optimization')
              and bound_html_version_id is null
            )
            or (
              snapshot_format = 'multi-file-v1'
              and dashboard_profile = 'generic'
              and bound_html_version_id is not null
              and uncompressed_size = file_size
            )
          ),
          add constraint top_dashboard_block_data_versions_bound_html_fk
            foreign key (block_id, bound_html_version_id)
            references top_dashboard_block_versions(block_id, id)
            on delete cascade;

        create index top_dashboard_block_data_versions_bound_html_idx
          on top_dashboard_block_data_versions(block_id, bound_html_version_id)
          where bound_html_version_id is not null;
      `);
    },
  },
  {
    id: '202609030001_top_dashboard_file_storage',
    description: 'Allow large TOP snapshots to live in protected shared file storage',
    apply: async (client) => {
      await client.query(`
        alter table top_dashboard_block_data_versions
          add column if not exists storage_path text;

        alter table top_dashboard_block_data_versions
          alter column compressed_payload drop not null,
          drop constraint if exists top_dashboard_block_data_versions_file_size_check;

        alter table top_dashboard_block_data_versions
          add constraint top_dashboard_block_data_versions_file_size_check check (
            file_size between 1 and ${TOP_DASHBOARD_DATA_MAX_BYTES}
            and (
              compressed_payload is null
              or file_size = octet_length(compressed_payload)
            )
          ),
          add constraint top_dashboard_block_data_versions_storage_check check (
            (
              compressed_payload is not null
              and storage_path is null
            )
            or (
              compressed_payload is null
              and storage_path ~ '^[0-9a-f]{2}/[0-9a-f]{64}-[0-9a-f-]{36}\\.bin$'
            )
          );

        create unique index if not exists top_dashboard_block_data_versions_storage_path_idx
          on top_dashboard_block_data_versions(storage_path)
          where storage_path is not null;
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
