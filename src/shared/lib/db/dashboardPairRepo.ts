import { parseDashboardPairConfig, type DashboardPairConfig } from '../dashboardPair';
import { query, withTransaction } from './client';
import { ensureSiteSchema } from './schema';

const SETTING_KEY = 'dashboard_pair';

function decode(value: string | undefined) {
  if (!value) return null;
  try { return parseDashboardPairConfig(JSON.parse(value)); } catch { return null; }
}

export async function getDashboardPairConfig() {
  await ensureSiteSchema();
  const result = await query<{value: string}>('select value from site_settings where key=$1', [SETTING_KEY]);
  return decode(result.rows[0]?.value);
}

/** Revision protects two administrators from silently overwriting one another. */
export async function saveDashboardPairConfig(input: DashboardPairConfig) {
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', ['kts-dashboard-pair']);
    const result = await client.query<{value: string}>('select value from site_settings where key=$1 for update', [SETTING_KEY]);
    const current = decode(result.rows[0]?.value);
    if ((current?.revision ?? 0) !== input.revision) return null;
    const next = { ...input, revision: input.revision + 1 };
    await client.query(`insert into site_settings(key,value,updated_at) values($1,$2,now())
      on conflict(key) do update set value=excluded.value,updated_at=now()`, [SETTING_KEY, JSON.stringify(next)]);
    return next;
  });
}
