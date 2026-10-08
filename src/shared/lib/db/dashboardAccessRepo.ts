import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AdminSessionRole } from '../adminAuth';
import { DASHBOARD_REPORT_OPTIONS, parseDashboardAccess } from '../dashboardAccess';
import { hasDashboardManagementRight } from '../dashboardPermissions';
import { query, withTransaction } from './client';
import { ensureSiteSchema } from './schema';

type Db = Pick<PoolClient, 'query'>;
export type DashboardPrincipal = {
  source: 'admin' | 'manager';
  numericId: number;
  role: AdminSessionRole;
  canManageTopDashboard?: boolean;
};
export const DASHBOARD_ACCESS_LOCK = 'kts:dashboard-view-grants';
export type DashboardAudienceMode = 'individual' | 'all';
type AudienceActor = 'admin' | 'admintop';
export class DashboardAudienceForbiddenError extends Error {}

export function dashboardAccessVersion(keys: string[]) {
  return createHash('sha256').update(JSON.stringify([...keys].sort())).digest('hex');
}

export function dashboardGrantLocked(principal: DashboardPrincipal, key: string): boolean {
  return hasDashboardManagementRight({
    role: principal.role,
    sessionId: 'persisted',
    ...(principal.source === 'admin' ? { adminUserId: principal.numericId } : { managerId: principal.numericId }),
    canManageTopDashboard: principal.canManageTopDashboard,
  }, key);
}

export function dashboardGrantEligible(principal: DashboardPrincipal, key: string) {
  if (dashboardGrantLocked(principal, key)) return true;
  return key === 'manager:development' ? principal.source === 'manager' && principal.role === 'manager'
    : key === 'manager:support' ? principal.source === 'manager' && principal.role === 'support_manager' : true;
}

export async function getDashboardGrants(db: Db, source: 'admin' | 'manager', id: number) {
  const result = await db.query<{ key: string }>(`select key from dashboard_effective_view_grants where ${source === 'admin' ? 'admin_user_id' : 'manager_id'}=$1 order by key`, [id]);
  return result.rows.map((row) => row.key);
}

export async function saveDashboardGrants(db: Db, principal: DashboardPrincipal, value: string[] | undefined, expected?: string) {
  await db.query('select pg_advisory_xact_lock(hashtext($1))', [DASHBOARD_ACCESS_LOCK]);
  const current = await getDashboardGrants(db, principal.source, principal.numericId);
  if (value === undefined) return current;
  if (expected !== undefined && expected !== dashboardAccessVersion(current)) {
    throw new Error('Доступы уже изменены в другом окне. Обновите список сотрудников и повторите сохранение.');
  }
  const parsed = parseDashboardAccess(value);
  if (!parsed) throw new Error('Некорректный список доступных дашбордов');
  const next = parsed.filter((key) => dashboardGrantEligible(principal, key));
  const topIds = next.filter((key) => key.startsWith('top:')).map((key) => Number(key.slice(4)));
  if (topIds.length) {
    const blocks = await db.query('select id from top_dashboard_blocks where id=any($1::bigint[]) for key share', [topIds]);
    if (blocks.rows.length !== topIds.length) throw new Error('Один из выбранных дашбордов не существует');
  }
  const column = principal.source === 'admin' ? 'admin_user_id' : 'manager_id';
  await db.query(`delete from dashboard_view_grants where ${column}=$1`, [principal.numericId]);
  if (next.length) await db.query(`insert into dashboard_view_grants(${column},key) select $1,unnest($2::text[])`, [principal.numericId, next]);
  // Both editors write one effective audience: an unchecked inherited report is
  // an explicit exception, not a policy reset for everyone else.
  const policies = await db.query<{key: string}>("select key from dashboard_audience_policies where mode='all'");
  const excluded = policies.rows.filter(({key}) => dashboardGrantEligible(principal, key) && !dashboardGrantLocked(principal, key) && !next.includes(key)).map(({key}) => key);
  await db.query(`delete from dashboard_audience_exclusions where ${column}=$1`, [principal.numericId]);
  if (excluded.length) await db.query(`insert into dashboard_audience_exclusions(${column},key) select $1,unnest($2::text[])`, [principal.numericId, excluded]);
  return getDashboardGrants(db, principal.source, principal.numericId);
}

export function dashboardGrantOptionsVersion(options: Array<{key: string; defaultGranted?: boolean}>) {
  return createHash('sha256').update(JSON.stringify(options.map(({key, defaultGranted}) => [key, defaultGranted === true]).sort(([a], [b]) => String(a).localeCompare(String(b))))).digest('hex');
}

export async function getDashboardGrantOptions(db?: Db) {
  if (!db) await ensureSiteSchema();
  const execute = db ? db.query.bind(db) : query;
  const blocks = await execute<{ id: string; title: string }>('select id::text,title from top_dashboard_blocks order by id');
  const policies = await execute<{key: string}>("select key from dashboard_audience_policies where mode='all'");
  const inherited = new Set(policies.rows.map(({key}) => key));
  return [...DASHBOARD_REPORT_OPTIONS, ...blocks.rows.map((block) => ({ key: `top:${block.id}`, title: block.title, href: `/admin/top/${block.id}` }))]
    .map((option) => ({...option, defaultGranted: inherited.has(option.key)}));
}

type AudienceRow = {
  source: 'admin' | 'manager';
  id: string;
  name: string;
  login: string;
  role: AdminSessionRole;
  is_active: boolean;
  can_manage_top_dashboard: boolean;
  granted: boolean;
};

async function readAudience(db: Db, key: string, actor: AudienceActor = 'admin') {
  const rows = await db.query<AudienceRow>(`select 'admin'::text source,u.id::text,u.name,u.login,u.role,u.is_active,u.can_manage_top_dashboard,
      exists(select 1 from dashboard_effective_view_grants g where g.admin_user_id=u.id and g.key=$1) granted from admin_users u
    union all select 'manager'::text,m.id::text,m.name,m.login,coalesce(nullif(m.role,''),'manager'),m.is_active,m.can_manage_top_dashboard,
      exists(select 1 from dashboard_effective_view_grants g where g.manager_id=m.id and g.key=$1) from wholesale_managers m order by name,login`, [key]);
  return rows.rows.filter((row) => actor !== 'admintop' || row.role !== 'admin').map((row) => {
    const principal = { source: row.source, numericId: Number(row.id), role: row.role, canManageTopDashboard: row.can_manage_top_dashboard };
    const locked = dashboardGrantLocked(principal, key);
    return {
      id: `${row.source}:${row.id}`,
      name: row.name,
      login: row.login,
      role: row.role,
      isActive: row.is_active,
      checked: (row.granted && dashboardGrantEligible(principal, key)) || locked,
      locked,
      eligible: dashboardGrantEligible(principal, key),
    };
  });
}

async function readPolicy(db: Db, key: string) {
  const policy = await db.query<{mode: DashboardAudienceMode; revision: string}>('select mode,revision::text from dashboard_audience_policies where key=$1', [key]);
  return policy.rows[0] ?? {mode: 'individual' as const, revision: '0'};
}

async function readAudienceState(db: Db, key: string, actor: AudienceActor) {
  const policy = await readPolicy(db, key);
  const users = await readAudience(db, key, actor);
  const version = createHash('sha256').update(JSON.stringify({users, ...policy})).digest('hex');
  return {users, mode: policy.mode, version};
}

async function assertDashboard(db: Db, key: string) {
  if (!parseDashboardAccess([key])) throw new Error('Неизвестный дашборд');
  if (key.startsWith('top:')) {
    const block = await db.query('select id from top_dashboard_blocks where id=$1 for key share', [Number(key.slice(4))]);
    if (!block.rowCount) throw new Error('Дашборд не найден');
  }
}

export async function getDashboardAudience(key: string, actor: AudienceActor = 'admin') {
  await ensureSiteSchema();
  return withTransaction(async (db) => {
    await db.query('select pg_advisory_xact_lock_shared(hashtext($1))', [DASHBOARD_ACCESS_LOCK]);
    await assertDashboard(db, key);
    return readAudienceState(db, key, actor);
  });
}

export async function setDashboardAudience(key: string, ids: string[], expected: string, mode: DashboardAudienceMode = 'individual', actor: AudienceActor = 'admin') {
  await ensureSiteSchema();
  return withTransaction(async (db) => {
    await db.query('select pg_advisory_xact_lock(hashtext($1))', [DASHBOARD_ACCESS_LOCK]);
    await assertDashboard(db, key);
    if (!['all', 'individual'].includes(mode)) throw new Error('Некорректный режим доступа');
    const state = await readAudienceState(db, key, actor);
    const users = state.users;
    if (expected !== state.version) {
      throw new Error('Сотрудники или доступы уже изменены. Обновите список и повторите выбор.');
    }
    const wanted = new Set(ids);
    if (actor === 'admintop') {
      const requestedAdmins = ids.filter((id) => /^admin:[1-9]\d{0,15}$/.test(id)).map((id) => Number(id.slice(6)));
      if (requestedAdmins.length) {
        const protectedUsers = await db.query("select id from admin_users where role='admin' and id=any($1::bigint[])", [requestedAdmins]);
        if (protectedUsers.rows.length) throw new DashboardAudienceForbiddenError('Назначать доступы администраторам может только администратор сайта');
      }
    }
    if (ids.some((id) => !users.some((user) => user.id === id && user.eligible))) throw new Error('Некорректный список сотрудников');
    await db.query(`insert into dashboard_audience_policies(key,mode) values($1,$2)
      on conflict(key) do update set mode=excluded.mode,revision=dashboard_audience_policies.revision+1,updated_at=now()`, [key, mode]);
    await db.query('delete from dashboard_audience_exclusions where key=$1', [key]);
    // Individual mode freezes the current selection. All mode additionally
    // covers future identities, with missing current selections as exceptions.
    for (const user of users) {
      if (user.locked || !user.eligible) continue;
      const [source, id] = user.id.split(':');
      const column = source === 'admin' ? 'admin_user_id' : 'manager_id';
      if (mode === 'individual' && wanted.has(user.id)) {
        await db.query(`insert into dashboard_view_grants(${column},key) values ($1,$2) on conflict do nothing`, [Number(id), key]);
      } else {
        await db.query(`delete from dashboard_view_grants where ${column}=$1 and key=$2`, [Number(id), key]);
      }
      if (mode === 'all' && !wanted.has(user.id)) {
        await db.query(`insert into dashboard_audience_exclusions(${column},key) values ($1,$2)`, [Number(id), key]);
      }
    }
    return readAudienceState(db, key, actor);
  });
}
