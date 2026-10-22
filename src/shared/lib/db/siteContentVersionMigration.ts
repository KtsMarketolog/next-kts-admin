import type { PoolClient } from 'pg';

/** Add metadata only: existing content, activation flags and ordering are preserved. */
export async function applySiteContentVersionMigration(client: PoolClient) {
  const tables = ['hero_slides', 'news_items', 'brand_categories', 'brand_items', 'group_companies'];
  for (const table of tables) {
    await client.query(`alter table ${table} add column revision bigint not null default 1 check (revision > 0)`);
  }

  await client.query(`
    create function kts_advance_site_content_revision() returns trigger language plpgsql as $$
    declare ignored_columns text[] := array['revision', 'updated_at'];
    begin
      -- Sorting has a separate atomic endpoint and must not stale a content form.
      -- Brand items are the exception: their sort order is edited in that form.
      if tg_argv[0] = 'ignore-order' then
        ignored_columns := array_append(ignored_columns, 'sort_order');
      end if;
      if (to_jsonb(new) - ignored_columns) is distinct from (to_jsonb(old) - ignored_columns) then
        new.revision := old.revision + 1;
      else
        new.revision := old.revision;
      end if;
      return new;
    end;
    $$;
  `);

  for (const table of tables) {
    const comparison = table === 'brand_items' ? 'include-order' : 'ignore-order';
    await client.query(`
      create trigger ${table}_record_revision before update on ${table}
        for each row execute function kts_advance_site_content_revision('${comparison}');
    `);
  }
}
