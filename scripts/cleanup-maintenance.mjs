import { rm, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';

const root = resolve(process.cwd());
const pdfCacheDir = resolve(root, '.cache', 'price-pdf');
const maxPdfCacheAgeMs = Number(process.env.PDF_CACHE_MAX_AGE_DAYS || 30) * 24 * 60 * 60 * 1000;

async function cleanupDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.log('DATABASE_URL is not set, skipping DB cleanup');
    return;
  }

  const pool = new Pool({ connectionString });
  try {
    await pool.query(`delete from rate_limit_buckets where reset_at < now() - interval '1 day'`);
    await pool.query(`delete from admin_2fa_challenges where expires_at < now() - interval '1 day'`);
    await pool.query(`delete from admin_sessions where expires_at < now() - interval '30 days' or revoked_at < now() - interval '30 days'`);
    await pool.query(`delete from security_audit_events where created_at < now() - interval '180 days'`);
    await pool.query(`delete from wholesale_manager_login_logs where created_at < now() - interval '180 days'`);
    await pool.query(`delete from wholesale_price_view_logs where created_at < now() - interval '180 days'`);
    await pool.query(`delete from wholesale_analytics_events where created_at < now() - interval '365 days'`);
  } finally {
    await pool.end();
  }
}

async function cleanupPdfCache() {
  let entries = [];
  try {
    entries = await readdir(pdfCacheDir);
  } catch {
    return;
  }

  const now = Date.now();
  for (const entry of entries) {
    const filePath = join(pdfCacheDir, entry);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) continue;
    if (now - info.mtimeMs > maxPdfCacheAgeMs) {
      await rm(filePath, { force: true });
    }
  }
}

await cleanupDatabase();
await cleanupPdfCache();
console.log('Maintenance cleanup completed');
