import { createHash } from 'crypto';

import { getAdminSessionSecret } from './authSecret';

export function hashSensitiveValue(value: string) {
  const normalized = value.trim();
  if (!normalized) return '';
  return createHash('sha256').update(`${getAdminSessionSecret()}:${normalized}`).digest('hex');
}

export function safeHeaderValue(value: string | null | undefined, maxLength = 500) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}
