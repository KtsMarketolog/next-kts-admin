import type {
  PersonalDashboardManagerBinding,
  PersonalDashboardRecipientBinding,
  RecipientRow,
  PersonalDashboardReviewer,
  ManagerRow,
} from './types';
import { getPersonalDashboardAudience, type PersonalDashboardAudience } from '../../managerDashboardAudience';
import { getManagerEmailHash, PersonalDashboardError } from '../../managerDashboardDomain';
import { canReceiveLeaderPersonalSnapshot, type PersonalDashboardRecipient } from '../../managerDashboardRecipients';
import type { PoolClient } from 'pg';
import { positiveId } from './validation';
import { DASHBOARD_ACCESS_LOCK } from '../dashboardAccessRepo';

/** Hashes are only routing metadata. These checks do not authenticate an attachment or authorize a caller. */
export function resolvePersonalDashboardManager(managers: PersonalDashboardManagerBinding[], emailHash: string) {
  const matches = managers.filter((manager) => manager.isActive && getPersonalDashboardAudience(manager.role) !== null
    && manager.email.trim() !== '' && getManagerEmailHash(manager.email) === emailHash);
  return matches.length === 1 ? { status: 'matched' as const, managerId: matches[0].id }
    : { status: matches.length ? 'ambiguous' as const : 'unknown' as const, managerId: null };
}

/** Matches all eligible accounts, including hidden recipients, without conflating numeric ids. */
export function resolvePersonalDashboardRecipient(recipients: PersonalDashboardRecipientBinding[], emailHash: string) {
  const matches = recipients.filter((recipient) => recipient.isActive
    && (recipient.source === 'admin' ? canReceiveLeaderPersonalSnapshot(recipient.role) : getPersonalDashboardAudience(recipient.role) !== null)
    && recipient.email.trim() !== '' && getManagerEmailHash(recipient.email) === emailHash);
  return matches.length === 1
    ? { status: 'matched' as const, recipient: { source: matches[0].source, id: matches[0].id } }
    : { status: matches.length ? 'ambiguous' as const : 'unknown' as const, recipient: null };
}

export function bindings(rows: RecipientRow[]): PersonalDashboardRecipientBinding[] {
  return rows.map((row) => ({ source: row.source, id: Number(row.id), email: row.email, isActive: row.is_active, role: row.role }));
}

export async function currentRecipients(client: PoolClient): Promise<RecipientRow[]> {
  // Also prevent a new duplicate-email manager appearing between resolving the identity and reading
  // its bytes. This short table lock conflicts with writes, not with ordinary manager reads.
  await client.query(`lock table admin_users, wholesale_managers in share mode`);
  // SHARE freezes existing identity bindings while an import/read is in progress. Never use SQL btrim
  // for email normalization: the browser's ECMAScript trim includes Unicode whitespace.
  // Do not also take row locks: an account editor can already hold FOR UPDATE before requesting
  // its write table lock. Plain reads see committed rows while SHARE prevents writes until commit.
  const managers = await client.query<RecipientRow>(`select 'manager'::text as source,id::text,name,email,role,is_active
    from wholesale_managers order by id`);
  const admins = await client.query<RecipientRow>(`select 'admin'::text as source,id::text,name,email,role,is_active
    from admin_users order by id`);
  return [...managers.rows, ...admins.rows];
}

/** Caller holds DASHBOARD_ACCESS_LOCK before taking the account table locks. */
export async function currentRecipientViewContext(client: PoolClient) {
  const all = await currentRecipients(client);
  const grants = await client.query<{manager_id: string; key: string}>(`select manager_id::text,key
    from dashboard_effective_view_grants where manager_id is not null and key in ('manager:development','manager:support')`);
  return { all, managerGrants: new Set(grants.rows.map((row) => `${row.manager_id}:${row.key}`)) };
}

/** One visibility rule for management, TOP team review and catalog date aggregation. */
export function visiblePersonalRecipients(all: RecipientRow[], managerGrants: ReadonlySet<string>, audience: PersonalDashboardAudience, includeLeaders: boolean) {
  return all.filter((recipient) => recipient.is_active && (recipient.source === 'admin'
    ? includeLeaders && audience === 'development' && canReceiveLeaderPersonalSnapshot(recipient.role)
    : getPersonalDashboardAudience(recipient.role) === audience && managerGrants.has(`${recipient.id}:manager:${audience}`)));
}

async function authorizeRecipientAccount(client: PoolClient, recipient: PersonalDashboardRecipient) {
  const recipients = await currentRecipients(client);
  const account = recipients.find((row) => row.source === recipient.source && Number(row.id) === recipient.id);
  const audience = recipient.source === 'admin'
    ? (canReceiveLeaderPersonalSnapshot(account?.role) ? 'development' as const : null)
    : getPersonalDashboardAudience(account?.role);
  if (!account?.is_active || !audience) {
    throw new PersonalDashboardError('NOT_FOUND', 'Личный дашборд недоступен');
  }
  return { account, recipients, audience };
}

export async function accountSnapshotBinding(client: PoolClient, recipient: PersonalDashboardRecipient) {
  const { account, recipients, audience } = await authorizeRecipientAccount(client, recipient);
  // Access to the group's shared published HTML requires a valid manager account,
  // not a working snapshot email. Snapshot identity is a separate, stricter condition.
  const email = account.email.trim().toLowerCase();
  if (!email) return { audience, email, status: 'missing_email' as const, emailHash: null };
  const emailHash = getManagerEmailHash(email);
  const binding = resolvePersonalDashboardRecipient(bindings(recipients), emailHash);
  if (binding.recipient?.source !== recipient.source || binding.recipient?.id !== recipient.id) {
    return { audience, email, status: 'ambiguous_email' as const, emailHash: null };
  }
  return { audience, email, status: 'matched' as const, emailHash };
}

export async function authorizeBinding(client: PoolClient, recipient: PersonalDashboardRecipient) {
  const binding = await accountSnapshotBinding(client, recipient);
  if (binding.status === 'missing_email') throw new PersonalDashboardError('NOT_FOUND', 'Личный снимок недоступен без email сотрудника');
  if (binding.status === 'ambiguous_email') throw new PersonalDashboardError('AMBIGUOUS_EMAIL', 'Email сотрудника не уникален; обратитесь к администратору');
  return binding;
}

/** TOP's read authority is rechecked with the selected recipient in the same transaction. */
export async function personalReviewContext(client: PoolClient, viewer: PersonalDashboardReviewer, managerId?: number) {
  positiveId(viewer.adminUserId);
  if (managerId !== undefined) positiveId(managerId);
  await client.query('select pg_advisory_xact_lock_shared(hashtext($1))', [DASHBOARD_ACCESS_LOCK]);
  const authority = await client.query(`select s.id from admin_sessions s join admin_users u on u.id=s.admin_user_id
    where s.id::text=$1 and u.id=$2 and s.role='top' and u.role='top' and u.is_active
      and s.revoked_at is null and s.expires_at>now()
      and (u.password_changed_at is null or s.created_at>=u.password_changed_at)
    for share of s,u`, [viewer.sessionId, viewer.adminUserId]);
  if (!authority.rowCount) throw new PersonalDashboardError('REVIEW_FORBIDDEN', 'Нет доступа к просмотру отчётов МР');
  // Access changes and recipient role/email changes cannot race the ensuing data read.
  const { all, managerGrants } = await currentRecipientViewContext(client);
  const recipients = visiblePersonalRecipients(all, managerGrants, 'development', false);
  const selected = managerId === undefined ? null : recipients.find((manager) => Number(manager.id) === managerId);
  if (managerId !== undefined && !selected) throw new PersonalDashboardError('REVIEW_NOT_FOUND', 'Отчёт МР недоступен');
  return { recipients, all, selected };
}

export function personalReviewBinding(manager: ManagerRow, all: RecipientRow[]) {
  const email = manager.email.trim().toLowerCase();
  const emailHash = email ? getManagerEmailHash(email) : null;
  const binding = emailHash ? resolvePersonalDashboardRecipient(bindings(all), emailHash) : null;
  const bindingStatus = !emailHash ? 'missing_email' as const
    : binding?.recipient?.source === 'manager' && binding.recipient.id === Number(manager.id) ? 'matched' as const : 'ambiguous_email' as const;
  return { email, emailHash, bindingStatus };
}
