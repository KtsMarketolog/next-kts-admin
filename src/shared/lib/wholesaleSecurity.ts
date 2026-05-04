export const PUBLIC_PRICE_TOKEN_PATTERN = /^[a-zA-Z0-9_-]{24,128}$/;

export function normalizeTextField(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export function normalizeOptionalDate(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const date = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return normalized;
}

export function normalizePublicPriceToken(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 128) : '';
}

export function isValidNewPublicPriceToken(token: string) {
  return PUBLIC_PRICE_TOKEN_PATTERN.test(token);
}

export function isTokenUnchanged(existingToken: string, nextToken: string) {
  return existingToken === nextToken;
}

export function shortToken(token: string) {
  if (token.length <= 14) return token;
  return `${token.slice(0, 6)}...${token.slice(-6)}`;
}

export function normalizeWholesalePrice(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim().replace(',', '.');
  if (!normalized) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount < 0 || amount > 999999999) return null;
  return normalized;
}
