import type { AdminSession } from '@/shared/lib/adminAuth';

import { isManagerRole } from './adminPanelConfig';

export type AdminSessionResponse = {
  authenticated?: boolean;
  role?: AdminSession['role'] | null;
  canAccessTopDashboard?: boolean;
};

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function fetchAdminSessionSnapshot(): Promise<AdminSessionResponse> {
  const response = await fetch('/api/admin/session', { cache: 'no-store', credentials: 'same-origin' });

  if (!response.ok) {
    throw new Error(`Admin session check failed: ${response.status}`);
  }

  return response.json();
}

export async function fetchAdminSessionWithRetry(attempts = 4) {
  let lastError: unknown = null;

  for (let index = 0; index < attempts; index += 1) {
    try {
      const data = await fetchAdminSessionSnapshot();
      if (data.authenticated || index === attempts - 1) return data;
    } catch (error) {
      lastError = error;
      if (index === attempts - 1) throw error;
    }

    await wait([250, 500, 900][index] ?? 1200);
  }

  if (lastError) throw lastError;
  return { authenticated: false, role: null };
}

export function normalizeSessionRole(role: AdminSessionResponse['role']) {
  if (isManagerRole(role)) return role as AdminSession['role'];
  if (role === 'admin' || role === 'wholesale_admin' || role === 'top') return role;
  return null;
}
