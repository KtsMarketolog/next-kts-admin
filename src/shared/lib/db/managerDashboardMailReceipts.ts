import { resolvePersonalDashboardManager, type PersonalDashboardManagerBinding } from './managerDashboardRepo';
import { query } from './client';
import { ensureSiteSchema } from './schema';

function transportKey(key: string) {
  if (!/^imap-part:v1:[a-f0-9]{64}$/.test(key)) throw new Error('Invalid mail checkpoint key');
  return key;
}

export async function getPersonalDashboardMailReceipt(key: string): Promise<{ managerId: number } | null> {
  transportKey(key);
  await ensureSiteSchema();
  const receipt = await query<{ manager_id: string; email_hash: string }>(
    `select manager_id::text,email_hash from personal_dashboard_mail_receipts
     where transport_key=$1 and completed_at > now()-interval '30 days'`, [key]);
  const row = receipt.rows[0];
  if (!row) return null;
  const managers = await query<{ id: string; email: string; role: string; is_active: boolean }>(
    `select id::text,email,role,is_active from wholesale_managers
     where is_active=true and coalesce(nullif(role,''),'manager')='manager'`);
  const bindings: PersonalDashboardManagerBinding[] = managers.rows.map((manager) => ({
    id: Number(manager.id), email: manager.email, role: manager.role, isActive: manager.is_active,
  }));
  // Do not hide an import from retry after recipient bindings become ambiguous/change.
  const resolved = resolvePersonalDashboardManager(bindings, row.email_hash);
  return resolved.status === 'matched' && resolved.managerId === Number(row.manager_id)
    ? { managerId: resolved.managerId } : null;
}

export async function recordPersonalDashboardMailReceipt(key: string, sourceKey: string) {
  transportKey(key);
  await ensureSiteSchema();
  // Only committed successful imports qualify. No mailbox credentials, payload or
  // filename is stored, and failures/unknown recipients cannot become checkpoints.
  await query(`insert into personal_dashboard_mail_receipts (transport_key,source_key,manager_id,email_hash)
    select $1,source_key,manager_id,email_hash from personal_dashboard_imports
    where source_key=$2 and status in ('imported','duplicate') and manager_id is not null and email_hash is not null
    on conflict (transport_key) do update set source_key=excluded.source_key,
      manager_id=excluded.manager_id,email_hash=excluded.email_hash,completed_at=now()`, [key, sourceKey]);
}

export async function prunePersonalDashboardMailReceipts() {
  await ensureSiteSchema();
  // Metadata only. Snapshot files, import diagnostics and price lists are untouched.
  await query(`delete from personal_dashboard_mail_receipts where completed_at < now()-interval '30 days'`);
}
