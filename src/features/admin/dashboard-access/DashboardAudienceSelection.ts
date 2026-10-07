export type DashboardAudienceEmployee = {
  id: string;
  name: string;
  login: string;
  role: string;
  isActive: boolean;
  checked: boolean;
  locked: boolean;
  eligible: boolean;
};

export const DASHBOARD_AUDIENCE_ROLES = [
  { value: 'manager', label: 'МР — менеджеры по развитию' },
  { value: 'support_manager', label: 'МС — менеджеры по сопровождению' },
  { value: 'top', label: 'TOP' },
  { value: 'admintop', label: 'Админ TOP' },
  { value: 'purchaser', label: 'Закупщик' },
  { value: 'wholesale_admin', label: 'Админ прайсов' },
  { value: 'admin', label: 'Администратор' },
] as const;

export function dashboardAudienceRoleLabel(role: string) {
  return DASHBOARD_AUDIENCE_ROLES.find((option) => option.value === role)?.label ?? 'Другой профиль';
}

export function filterDashboardAudience(users: DashboardAudienceEmployee[], role: string, search: string) {
  const searchText = search.trim().toLocaleLowerCase('ru');
  return users.filter((user) => (!role || user.role === role)
    && `${user.name} ${user.login}`.toLocaleLowerCase('ru').includes(searchText));
}

/** A role is a selection aid, not a persistent permission rule. Only return known current identities. */
export function dashboardAudienceRoleEmployeeIds(users: DashboardAudienceEmployee[], role: string) {
  if (!DASHBOARD_AUDIENCE_ROLES.some((option) => option.value === role)) return [];
  return users.filter((user) => user.role === role && user.isActive && user.eligible && !user.locked).map((user) => user.id);
}

export function selectDashboardAudienceEmployees(users: DashboardAudienceEmployee[], ids: string[], checked: boolean) {
  const selected = new Set(ids);
  return users.map((user) => selected.has(user.id) && user.eligible && !user.locked ? { ...user, checked } : user);
}
