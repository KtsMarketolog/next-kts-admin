import type { PoolClient } from 'pg';

/** Additive only: keep all passwords, grants, price positions and settings intact. */
export async function applyRecordVersionMigration(client: PoolClient) {
  for (const table of ['admin_users', 'wholesale_managers', 'wholesale_price_lists']) {
    await client.query(`alter table ${table} add column revision bigint not null default 1 check (revision > 0)`);
  }

  await client.query(`
    create function kts_advance_record_revision() returns trigger language plpgsql as $$
    begin
      new.revision := old.revision + 1;
      return new;
    end;
    $$;

    create function kts_advance_employee_revision() returns trigger language plpgsql as $$
    begin
      -- Repairing the encrypted display copy does not change the password or
      -- editable profile. Showing a password must not invalidate that same form.
      -- updated_at is deliberately kept in this comparison: delegated grants
      -- use a principal touch to invalidate the previous editor revision.
      if (to_jsonb(new) - 'revision' - 'password_ciphertext' - 'display_password')
          is distinct from
         (to_jsonb(old) - 'revision' - 'password_ciphertext' - 'display_password') then
        new.revision := old.revision + 1;
      else
        new.revision := old.revision;
      end if;
      return new;
    end;
    $$;

    create trigger admin_users_record_revision before update on admin_users
      for each row execute function kts_advance_employee_revision();
    create trigger wholesale_managers_record_revision before update on wholesale_managers
      for each row execute function kts_advance_employee_revision();
    create trigger wholesale_price_lists_record_revision before update on wholesale_price_lists
      for each row execute function kts_advance_record_revision();

    create function kts_advance_price_child_revision() returns trigger language plpgsql as $$
    declare affected_id bigint;
    begin
      -- Once per affected price list per statement, not once per product. Bulk
      -- catalog imports can change thousands of rows in a single statement.
      if tg_op = 'INSERT' then
        for affected_id in select distinct price_list_id from kts_new_rows order by price_list_id loop
          update wholesale_price_lists set revision = revision + 1 where id = affected_id;
        end loop;
      elsif tg_op = 'DELETE' then
        for affected_id in select distinct price_list_id from kts_old_rows order by price_list_id loop
          update wholesale_price_lists set revision = revision + 1 where id = affected_id;
        end loop;
      else
        for affected_id in
          select price_list_id from kts_old_rows union select price_list_id from kts_new_rows order by price_list_id
        loop
          update wholesale_price_lists set revision = revision + 1 where id = affected_id;
        end loop;
      end if;
      return null;
    end;
    $$;
  `);

  for (const table of ['wholesale_price_list_items', 'wholesale_price_list_group_stock_settings']) {
    await client.query(`
      create trigger ${table}_revision_insert after insert on ${table}
        referencing new table as kts_new_rows for each statement execute function kts_advance_price_child_revision();
      create trigger ${table}_revision_update after update on ${table}
        referencing old table as kts_old_rows new table as kts_new_rows
        for each statement execute function kts_advance_price_child_revision();
      create trigger ${table}_revision_delete after delete on ${table}
        referencing old table as kts_old_rows for each statement execute function kts_advance_price_child_revision();
    `);
  }
}
