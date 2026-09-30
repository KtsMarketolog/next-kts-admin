import type { AdminSession } from './adminAuth';

/** This report is not an ordinary TOP block and cannot be granted to purchasers. */
export function canAccessCurrencyDashboard(
  session: AdminSession | null | undefined,
): session is AdminSession & { role: 'admin' | 'admintop'; sessionId: string } {
  if (!session?.sessionId) return false;
  if (session.role === 'admin') return true;
  return session.role === 'admintop'
    && Number.isSafeInteger(session.adminUserId) && Number(session.adminUserId) > 0;
}

export const CURRENCY_PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
} as const;
