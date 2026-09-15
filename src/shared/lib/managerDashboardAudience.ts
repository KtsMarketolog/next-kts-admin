export type PersonalDashboardAudience = 'development' | 'support';

export const PERSONAL_DASHBOARD_AUDIENCE_LABELS: Record<PersonalDashboardAudience, string> = {
  development: 'Менеджеры по развитию',
  support: 'Менеджеры по сопровождению',
};

export function parsePersonalDashboardAudience(value: unknown): PersonalDashboardAudience | null {
  return value === 'development' || value === 'support' ? value : null;
}

/** Account roles select HTML; attachment names and encrypted payload role labels do not. */
export function getPersonalDashboardAudience(role: string | null | undefined): PersonalDashboardAudience | null {
  if (role === 'manager' || role === '' || role === null || role === undefined) return 'development';
  return role === 'support_manager' ? 'support' : null;
}
