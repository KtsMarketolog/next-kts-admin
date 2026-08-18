import type { AdminSessionRole } from './adminAuth';
import { normalizePositiveIntegerId } from './wholesaleSecurity';

export type WholesalePriceListManagerRole = 'manager' | 'support_manager';

type ManagerSession = {
  role?: AdminSessionRole | null;
  managerId?: number | null;
};

export type WholesalePriceListAccessScope = {
  managerId: number | null;
  role: WholesalePriceListManagerRole | null;
};

export function getWholesalePriceListAccessScope(
  session?: ManagerSession | null,
): WholesalePriceListAccessScope {
  const role =
    session?.role === 'manager' || session?.role === 'support_manager' ? session.role : null;

  return {
    managerId: role ? normalizePositiveIntegerId(session?.managerId) ?? -1 : null,
    role,
  };
}

export function resolveWholesalePriceListManagerAssignment(
  input: {
    managerId?: number | null;
    supportManagerId?: number | null;
  },
  session?: ManagerSession | null,
) {
  const managerId = normalizePositiveIntegerId(input.managerId);
  const supportManagerId = normalizePositiveIntegerId(input.supportManagerId);
  const sessionManagerId = normalizePositiveIntegerId(session?.managerId);

  if (session?.role === 'manager') {
    return {
      managerId: sessionManagerId,
      supportManagerId,
    };
  }

  if (session?.role === 'support_manager') {
    return {
      managerId,
      supportManagerId: sessionManagerId,
    };
  }

  return {
    managerId,
    supportManagerId,
  };
}
