/** Account ownership is namespaced: admin and manager numeric ids can overlap. */
export type PersonalDashboardRecipient = { source: 'manager' | 'admin'; id: number };

export function canReceiveLeaderPersonalSnapshot(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'admintop' || role === 'top';
}
