import { ADMIN_REQUEST_TIMEOUT_MS, runWithRequestTimeout } from './adminRequest';

export const EMPLOYEE_REQUEST_TIMEOUT_MS = ADMIN_REQUEST_TIMEOUT_MS;
export const EMPLOYEE_UNKNOWN_OUTCOME = 'Ответ сервера не получен. Изменение могло сохраниться. Обновите список и проверьте результат перед повторной попыткой.';

export class EmployeeRequestError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
    this.name = 'EmployeeRequestError';
  }
}

/** Includes response-body reading in the deadline; never retries a mutation automatically. */
export async function employeeRequest<T>(url: string, init: RequestInit = {}, options: { mutation?: boolean; timeoutMs?: number } = {}): Promise<T> {
  try {
    return await runWithRequestTimeout(async (signal) => {
      const response = await fetch(url, { ...init, cache: 'no-store', signal });
      const data = await response.json();
      if (!response.ok) {
        if (options.mutation && response.status >= 500) throw new EmployeeRequestError(EMPLOYEE_UNKNOWN_OUTCOME, response.status);
        throw new EmployeeRequestError(typeof data?.error === 'string' ? data.error : 'Не удалось выполнить запрос', response.status);
      }
      return data as T;
    }, { ...options, signal: init.signal });
  } catch (error) {
    if (error instanceof EmployeeRequestError) throw error;
    throw new EmployeeRequestError(options.mutation ? EMPLOYEE_UNKNOWN_OUTCOME : 'Не удалось получить ответ сервера. Повторите запрос.');
  }
}

/** Synchronous guard also blocks two clicks before React commits its pending state. */
export function createEmployeeActionLock() {
  let busy = false;
  return {
    acquire() { if (busy) return false; busy = true; return true; },
    release() { busy = false; },
    isBusy() { return busy; },
  };
}

export function withoutEmployeePassword<T extends object>(value: T): Omit<T, 'password' | 'displayPassword'> {
  const safe = { ...value } as T & { password?: unknown; displayPassword?: unknown };
  delete safe.password;
  delete safe.displayPassword;
  return safe;
}

type LegacyEmployeePasswordEntry = { storageKey: string; id: string; password: string };
const ACCESS_PASSWORDS = 'kts-admin-users-passwords-v1';
const MANAGER_PASSWORDS = 'kts-admin-wholesale-manager-passwords-v1';

/** Called only by an explicit show/copy action. A candidate is never trusted for display. */
export function readLegacyEmployeePasswordCandidates(endpoint: string): LegacyEmployeePasswordEntry[] {
  if (typeof window === 'undefined') return [];
  let decoded: string;
  try { decoded = decodeURIComponent(endpoint); } catch { return []; }
  const access = /^\/api\/admin\/users\/(admin|manager):([1-9]\d*)\/password$/.exec(decoded);
  const wholesale = /^\/api\/admin\/wholesale\/managers\/([1-9]\d*)\/password$/.exec(decoded);
  const targets: Array<[string, string]> = [];
  if (access) {
    targets.push([ACCESS_PASSWORDS, `${access[1]}:${access[2]}`]);
    if (access[1] === 'manager') targets.push([MANAGER_PASSWORDS, access[2]]);
  } else if (wholesale) {
    targets.push([MANAGER_PASSWORDS, wholesale[1]], [ACCESS_PASSWORDS, `manager:${wholesale[1]}`]);
  }
  return targets.flatMap(([storageKey, id]) => {
    try {
      const entries = JSON.parse(window.localStorage.getItem(storageKey) || '{}');
      const password = entries && !Array.isArray(entries) && typeof entries === 'object' ? entries[id] : undefined;
      return typeof password === 'string' && password.length > 0 && password.length <= 200 ? [{ storageKey, id, password }] : [];
    } catch { return []; }
  });
}

/** Only retire verified/obsolete exact-account copies; preserve concurrent changes and other accounts. */
export function removeLegacyEmployeePasswordCandidates(entries: LegacyEmployeePasswordEntry[]) {
  if (typeof window === 'undefined') return;
  for (const entry of entries) {
    try {
      const current = JSON.parse(window.localStorage.getItem(entry.storageKey) || '{}');
      if (!current || Array.isArray(current) || typeof current !== 'object' || current[entry.id] !== entry.password) continue;
      delete current[entry.id];
      if (Object.keys(current).length) window.localStorage.setItem(entry.storageKey, JSON.stringify(current));
      else window.localStorage.removeItem(entry.storageKey);
    } catch { /* Storage must never affect server operations. */ }
  }
}
