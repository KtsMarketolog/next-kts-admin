import type { PoolClient } from 'pg';

const ALIASES = `
  select distinct 'admin'::text as source, au.id, kts_employee_identifier(value) as identifier
  from admin_users au cross join lateral (values (au.login), (au.email)) as aliases(value)
  where kts_employee_identifier(value) <> ''
  union all
  select distinct 'manager'::text as source, wm.id, kts_employee_identifier(value) as identifier
  from wholesale_managers wm cross join lateral (values (wm.login), (wm.email)) as aliases(value)
  where kts_employee_identifier(value) <> ''`;

/** Employee-only namespace. Client users, passwords, IDs and source fields stay untouched. */
export async function applyEmployeeIdentifierMigration(client: PoolClient) {
  // No write can race the validation/backfill/trigger handoff. Reads remain allowed.
  await client.query('lock table admin_users, wholesale_managers in share row exclusive mode');
  await client.query(`create or replace function kts_employee_identifier(value text) returns text
    language sql immutable strict parallel safe as $$
      select lower(btrim(value,
        chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||
        chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||
        chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279)))
    $$`);
  // Match String.trim() boundary whitespace, but use this same SQL normalization
  // for login lookup, so database collation/case handling cannot diverge.
  const conflicts = await client.query<{ conflict: boolean }>(`with aliases as (${ALIASES})
    select exists(select 1 from aliases group by identifier having count(*) > 1) as conflict`);
  if (conflicts.rows[0]?.conflict) {
    throw new Error('Обнаружены совпадающие логины или email у разных сотрудников. Миграция остановлена без изменения учётных записей; требуется ручная проверка пользователей.');
  }
  await client.query(`
    create table if not exists employee_login_identifiers (
      identifier text not null,
      admin_user_id bigint references admin_users(id) on delete cascade,
      manager_id bigint references wholesale_managers(id) on delete cascade,
      constraint employee_login_identifiers_owner_check check (
        (admin_user_id is not null)::int + (manager_id is not null)::int = 1
      ),
      constraint employee_login_identifiers_normalized_check check (
        identifier <> '' and identifier = kts_employee_identifier(identifier)
      ),
      constraint employee_login_identifiers_unique unique(identifier) deferrable initially deferred
    );
    create index if not exists employee_login_identifiers_admin_idx on employee_login_identifiers(admin_user_id);
    create index if not exists employee_login_identifiers_manager_idx on employee_login_identifiers(manager_id);
    create or replace function kts_sync_employee_identifiers() returns trigger language plpgsql as $$
    begin
      if tg_table_name = 'admin_users' then
        delete from employee_login_identifiers where admin_user_id = new.id;
        insert into employee_login_identifiers (identifier, admin_user_id)
          select distinct kts_employee_identifier(value), new.id from (values (new.login), (new.email)) as aliases(value)
          where kts_employee_identifier(value) <> '';
      elsif tg_table_name = 'wholesale_managers' then
        delete from employee_login_identifiers where manager_id = new.id;
        insert into employee_login_identifiers (identifier, manager_id)
          select distinct kts_employee_identifier(value), new.id from (values (new.login), (new.email)) as aliases(value)
          where kts_employee_identifier(value) <> '';
      else
        raise exception 'Unsupported employee identity source';
      end if;
      return new;
    end $$;
    drop trigger if exists employee_login_identifiers_sync on admin_users;
    create trigger employee_login_identifiers_sync after insert or update of login, email on admin_users
      for each row execute function kts_sync_employee_identifiers();
    drop trigger if exists employee_login_identifiers_sync on wholesale_managers;
    create trigger employee_login_identifiers_sync after insert or update of login, email on wholesale_managers
      for each row execute function kts_sync_employee_identifiers();
    delete from employee_login_identifiers;
    insert into employee_login_identifiers (identifier, admin_user_id, manager_id)
      select identifier, case when source = 'admin' then id end, case when source = 'manager' then id end
      from (${ALIASES}) as aliases;
    set constraints employee_login_identifiers_unique immediate;
  `);
  // Deferred uniqueness preserves the existing transactional source-transfer
  // flow (insert destination, revoke sessions, delete source), but a conflicting
  // account can never commit. Same-account login=email is deduplicated above.
}
