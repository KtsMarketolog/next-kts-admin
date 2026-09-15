import type { AdminSession } from './adminAuth';
import type { PersonalDashboardEmptyState } from './managerDashboardHtml';
import { getPersonalDashboardAudience, parsePersonalDashboardAudience } from './managerDashboardAudience';

export function personalDashboardMode(session: AdminSession | null): 'manage' | 'view' | null {
  // Do not accept the legacy signed-cookie fallback: persisted sessions recheck
  // activity, current roles and revocation on every request.
  if (!session?.sessionId) return null;
  if (session.role === 'admin') return 'manage';
  if (session.role === 'admintop' && Number.isSafeInteger(session.adminUserId) && Number(session.adminUserId) > 0) return 'manage';
  if ((session.role === 'manager' || session.role === 'support_manager') && Number.isSafeInteger(session.managerId) && Number(session.managerId) > 0) return 'view';
  return null;
}

/** A viewer can never select another group's HTML through query parameters. */
export function personalDashboardAudienceSelection(mode: 'manage' | 'view', managerRole: string | null | undefined, requested: string | null) {
  const accountAudience = mode === 'view' ? getPersonalDashboardAudience(managerRole) : null;
  const audience = requested === null ? mode === 'manage' ? 'development' : accountAudience : parsePersonalDashboardAudience(requested);
  if (!audience || (mode === 'view' && (!managerRole || audience !== accountAudience))) return null;
  return audience;
}

export function personalDashboardFreshness(snapshot: { issued: string; expires: string } | null, now = new Date()) {
  const todayMoscow = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  return {
    todayMoscow,
    expectedBy: '10:00 МСК',
    snapshotStatus: !snapshot ? 'missing' : snapshot.expires < todayMoscow ? 'expired' : snapshot.issued < todayMoscow ? 'stale' : 'current',
  } as const;
}

// Shared HTML does not depend on an email binding. Only a currently authorized,
// unexpired personal snapshot may trigger the separate protected data request.
export function personalDashboardFrameSelection(status: {
  bindingStatus: 'matched' | 'missing_email' | 'ambiguous_email';
  snapshot: { id: number; issued: string; expires: string } | null;
  history: Array<{ id: number; issued: string; expires: string }>;
}, requestedId?: number, now = new Date()): { snapshotId?: number; emptyState?: PersonalDashboardEmptyState; denied?: true } {
  if (status.bindingStatus !== 'matched') return { emptyState: status.bindingStatus };
  const selected = requestedId === undefined ? status.snapshot : status.history.find((snapshot) => snapshot.id === requestedId);
  if (requestedId !== undefined && !selected) return { denied: true };
  if (!selected) return { emptyState: 'no_snapshot' };
  if (personalDashboardFreshness(selected, now).snapshotStatus === 'expired') return { emptyState: 'expired' };
  return { snapshotId: selected.id };
}

export function parsePersonalDashboardId(value: string | null) {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

export const PERSONAL_PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'same-origin',
} as const;

export async function readPersonalRequestBytes(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new Error('REQUEST_TOO_LARGE');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('REQUEST_TOO_LARGE');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
