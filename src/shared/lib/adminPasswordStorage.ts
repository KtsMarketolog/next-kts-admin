const ACCESS_USER_PASSWORDS_STORAGE_KEY = 'kts-admin-users-passwords-v1';
const WHOLESALE_MANAGER_PASSWORDS_STORAGE_KEY = 'kts-admin-wholesale-manager-passwords-v1';
const CLIENT_COMPANY_PASSWORDS_STORAGE_KEY = 'kts-admin-client-company-passwords-v1';

function readPasswordMap(storageKey: string) {
  if (typeof window === 'undefined') return {} as Record<string, string>;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) || '{}');
    if (!parsed || typeof parsed !== 'object') return {} as Record<string, string>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string'),
    );
  } catch {
    return {} as Record<string, string>;
  }
}

function writePasswordMap(storageKey: string, passwords: Record<string, string>) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(storageKey, JSON.stringify(passwords));
}

type ClientCompanyPasswordEntry = {
  password: string;
  passwordChangedAt: string;
};

function readClientCompanyPasswordEntries() {
  if (typeof window === 'undefined') return {} as Record<string, ClientCompanyPasswordEntry>;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CLIENT_COMPANY_PASSWORDS_STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object') return {} as Record<string, ClientCompanyPasswordEntry>;
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([key, value]) => {
          if (typeof key !== 'string') return null;
          if (typeof value === 'string') {
            return [key, { password: value, passwordChangedAt: '' }] as const;
          }
          if (!value || typeof value !== 'object') return null;
          const entry = value as Record<string, unknown>;
          if (typeof entry.password !== 'string') return null;
          return [
            key,
            {
              password: entry.password,
              passwordChangedAt: typeof entry.passwordChangedAt === 'string' ? entry.passwordChangedAt : '',
            },
          ] as const;
        })
        .filter((entry): entry is readonly [string, ClientCompanyPasswordEntry] => Boolean(entry)),
    );
  } catch {
    return {} as Record<string, ClientCompanyPasswordEntry>;
  }
}

function writeClientCompanyPasswordEntries(passwords: Record<string, ClientCompanyPasswordEntry>) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(CLIENT_COMPANY_PASSWORDS_STORAGE_KEY, JSON.stringify(passwords));
}

function managerAccessUserId(managerId: number | string) {
  return `manager:${managerId}`;
}

function managerIdFromAccessUserId(userId: string) {
  const match = /^manager:(\d+)$/.exec(userId);
  return match ? match[1] : null;
}

function saveAccessUserPasswordOnly(userId: string, password: string) {
  const passwords = readAccessUserPasswords();
  passwords[userId] = password;
  writePasswordMap(ACCESS_USER_PASSWORDS_STORAGE_KEY, passwords);
}

function removeAccessUserPasswordOnly(userId: string) {
  const passwords = readAccessUserPasswords();
  delete passwords[userId];
  writePasswordMap(ACCESS_USER_PASSWORDS_STORAGE_KEY, passwords);
}

function saveWholesaleManagerPasswordOnly(managerId: number | string, password: string) {
  const passwords = readWholesaleManagerPasswords();
  passwords[String(managerId)] = password;
  writePasswordMap(WHOLESALE_MANAGER_PASSWORDS_STORAGE_KEY, passwords);
}

function removeWholesaleManagerPasswordOnly(managerId: number | string) {
  const passwords = readWholesaleManagerPasswords();
  delete passwords[String(managerId)];
  writePasswordMap(WHOLESALE_MANAGER_PASSWORDS_STORAGE_KEY, passwords);
}

export function readAccessUserPasswords() {
  return readPasswordMap(ACCESS_USER_PASSWORDS_STORAGE_KEY);
}

export function readWholesaleManagerPasswords() {
  return readPasswordMap(WHOLESALE_MANAGER_PASSWORDS_STORAGE_KEY);
}

export function readClientCompanyPasswords(passwordChangedAtByCompanyId: Record<string, string> = {}) {
  const passwords = readClientCompanyPasswordEntries();
  return Object.fromEntries(
    Object.entries(passwords)
      .filter(([companyId, entry]) => {
        const expectedPasswordChangedAt = passwordChangedAtByCompanyId[companyId] || '';
        return Boolean(entry.password && entry.passwordChangedAt && entry.passwordChangedAt === expectedPasswordChangedAt);
      })
      .map(([companyId, entry]) => [companyId, entry.password]),
  );
}

export function saveAccessUserPassword(userId: string, password: string) {
  saveAccessUserPasswordOnly(userId, password);
  const managerId = managerIdFromAccessUserId(userId);
  if (managerId) saveWholesaleManagerPasswordOnly(managerId, password);
}

export function moveAccessUserPassword(previousId: string, nextId: string, password: string) {
  removeAccessUserPasswordOnly(previousId);
  const previousManagerId = managerIdFromAccessUserId(previousId);
  if (previousManagerId) removeWholesaleManagerPasswordOnly(previousManagerId);

  if (!password) return;

  saveAccessUserPasswordOnly(nextId, password);
  const nextManagerId = managerIdFromAccessUserId(nextId);
  if (nextManagerId) saveWholesaleManagerPasswordOnly(nextManagerId, password);
}

export function removeAccessUserPassword(userId: string) {
  removeAccessUserPasswordOnly(userId);
  const managerId = managerIdFromAccessUserId(userId);
  if (managerId) removeWholesaleManagerPasswordOnly(managerId);
}

export function saveWholesaleManagerPassword(managerId: number | string, password: string) {
  saveWholesaleManagerPasswordOnly(managerId, password);
  saveAccessUserPasswordOnly(managerAccessUserId(managerId), password);
}

export function removeWholesaleManagerPassword(managerId: number | string) {
  removeWholesaleManagerPasswordOnly(managerId);
  removeAccessUserPasswordOnly(managerAccessUserId(managerId));
}

export function saveClientCompanyPassword(companyId: number | string, password: string, passwordChangedAt: string) {
  const passwords = readClientCompanyPasswordEntries();
  passwords[String(companyId)] = { password, passwordChangedAt };
  writeClientCompanyPasswordEntries(passwords);
}

export function removeClientCompanyPassword(companyId: number | string) {
  const passwords = readClientCompanyPasswordEntries();
  delete passwords[String(companyId)];
  writeClientCompanyPasswordEntries(passwords);
}
