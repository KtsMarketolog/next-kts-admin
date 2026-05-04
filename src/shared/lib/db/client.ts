import { Pool, type QueryResultRow } from 'pg';

declare global {
  var __ktsPgPool: Pool | undefined;
}

function getPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  globalThis.__ktsPgPool ??= new Pool({ connectionString });
  return globalThis.__ktsPgPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) {
  return getPool().query<T>(text, params);
}
