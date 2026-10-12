import { query } from './client';
import { ensureSiteSchema } from './schema';

export type PublicWholesalePriceTelemetry = {
  id: number;
  token: string;
  clientName: string;
  managerId: number | null;
};

export function normalizePublicWholesalePriceToken(token: string) {
  const normalized = token.trim();
  return /^[a-zA-Z0-9_-]{1,160}$/.test(normalized) ? normalized : null;
}

/** Same eligibility as the public price page, without loading items or building analogs. */
export async function getPublicWholesalePriceTelemetry(token: string): Promise<PublicWholesalePriceTelemetry | null> {
  const normalizedToken = normalizePublicWholesalePriceToken(token);
  if (!normalizedToken) return null;
  await ensureSiteSchema();
  const result = await query<{
    id: string;
    token: string;
    client_name: string;
    manager_id: string | null;
  }>(
    `select id::text, token, client_name, manager_id::text
     from wholesale_price_lists
     where token = $1 and is_active = true
     limit 1`,
    [normalizedToken],
  );
  // valid_until is informational on the public page; do not introduce a new
  // expiry or product-membership gate solely for its analytics requests.
  const row = result.rows[0];
  return row ? {
    id: Number(row.id),
    token: row.token,
    clientName: row.client_name,
    managerId: row.manager_id ? Number(row.manager_id) : null,
  } : null;
}
