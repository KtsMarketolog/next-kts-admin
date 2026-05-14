const ACCESS_USER_PASSWORDS_STORAGE_KEY = 'kts-admin-users-passwords-v1';
const WHOLESALE_MANAGER_PASSWORDS_STORAGE_KEY = 'kts-admin-wholesale-manager-passwords-v1';

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
