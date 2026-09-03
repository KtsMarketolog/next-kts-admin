import { ensureCatalogSchema, markCatalogSchemaReady } from '@/entities/catalog/api/catalogDb';

import { withSessionAdvisoryLock } from './db/client';
import { ensureSiteSchema, markSiteSchemaReady } from './db/schema';
import { cleanupStaleTopDashboardIncomingFiles } from './topDashboardDataStorage';

const RUNTIME_SCHEMA_LOCK = 'kts_runtime_schema_prepare';

function releaseId() {
  const value = process.env.APP_RELEASE_ID?.trim();
  return value && /^[A-Za-z0-9._-]{1,100}$/.test(value) ? value : null;
}

export async function prepareRuntimeForRelease() {
  const currentReleaseId = releaseId();
  if (!currentReleaseId) return;

  await cleanupStaleTopDashboardIncomingFiles();
  await withSessionAdvisoryLock(RUNTIME_SCHEMA_LOCK, async (client) => {
    await client.query(`
      create table if not exists runtime_schema_state (
        id smallint primary key check (id = 1),
        release_id text not null,
        prepared_at timestamptz not null default now()
      )
    `);
    const existing = await client.query<{ release_id: string }>(
      `select release_id from runtime_schema_state where id = 1`,
    );

    if (existing.rows[0]?.release_id === currentReleaseId) {
      markSiteSchemaReady();
      markCatalogSchemaReady();
      return;
    }

    await ensureSiteSchema();
    await ensureCatalogSchema();
    await client.query(
      `insert into runtime_schema_state (id, release_id, prepared_at)
       values (1, $1, now())
       on conflict (id) do update
       set release_id = excluded.release_id,
           prepared_at = excluded.prepared_at`,
      [currentReleaseId],
    );
  });
}
