import type { AdminSession } from './adminAuth';

export type CurrencyDevicePrefs = Partial<Record<'sound' | 'voice' | 'notif' | 'alertMini' | 'auto', boolean>>;
export type CurrencyDeviceSeen = {
  cbrDate?: string;
  moex?: Partial<Record<'CNYRUB_TOM' | 'KZTRUB_TOM', number>>;
  fut?: Partial<Record<'COPPER' | 'BR', number>>;
  futContracts?: Partial<Record<'COPPER' | 'BR', string>>;
  copper?: { date: string; cash: number };
};
export type CurrencyDeviceLogEntry = { t: string; msg: string; risk: boolean };
export type CurrencyDeviceValues = { kts_seen?: CurrencyDeviceSeen; kts_prefs?: CurrencyDevicePrefs; kts_log?: CurrencyDeviceLogEntry[] };
export type CurrencyNotificationPermission = NotificationPermission | 'unsupported';
type DeviceKey = keyof CurrencyDeviceValues;
type BrowserStorage = Pick<Storage, 'getItem' | 'setItem'>;
type Notifications = {
  permission: () => NotificationPermission;
  requestPermission: () => Promise<NotificationPermission>;
  show: (body: string) => void;
};
const KEYS: DeviceKey[] = ['kts_seen', 'kts_prefs', 'kts_log'];
const MAX_BYTES = 1024 * 1024;

/** Derived only from the authenticated server session; never from iframe input. */
export function currencyDashboardDeviceScope(session: AdminSession | null | undefined): string | null {
  if (!session) return null;
  if (session.role === 'manager' || session.role === 'support_manager') {
    return Number.isSafeInteger(session.managerId) && Number(session.managerId) > 0 ? `manager:${session.managerId}` : null;
  }
  if (Number.isSafeInteger(session.adminUserId) && Number(session.adminUserId) > 0) return `user:${session.adminUserId}`;
  return session.role === 'admin' ? 'admin:primary' : null;
}

function invalid(): never { throw new Error('Некорректные локальные настройки отчёта.'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 35
    || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value)
    || !Number.isFinite(Date.parse(value)) || !Number.isFinite(Date.parse(value.slice(0, 10) + 'T00:00:00Z'))
    || new Date(value.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) !== value.slice(0, 10)) invalid();
  return value;
}
function copperQuote(value: unknown): { date: string; cash: number } {
  const input = record(value, ['date', 'cash']);
  if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) invalid();
  timestamp(input.date + 'T00:00:00Z');
  const cash = quotes({ cash: input.cash }, ['cash']).cash;
  return { date: input.date, cash };
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || /[<>\u0000-\u001f\u007f]/u.test(value)) invalid();
  return value;
}
function quotes(value: unknown, keys: readonly string[]) {
  const input = record(value, keys);
  return Object.fromEntries(Object.entries(input).map(([key, price]) => {
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || price > 1e9) invalid();
    return [key, price];
  }));
}
function futureContracts(value: unknown, prices: CurrencyDeviceSeen['fut']) {
  return Object.fromEntries(Object.entries(record(value, ['COPPER', 'BR'])).map(([asset, secid]) => {
    if (typeof secid !== 'string' || !/^[A-Z0-9]{1,32}$/.test(secid) || prices?.[asset as 'COPPER' | 'BR'] === undefined) invalid();
    return [asset, secid];
  }));
}
function validateValue(key: DeviceKey, value: unknown): CurrencyDeviceValues[DeviceKey] {
  if (key === 'kts_prefs') {
    const input = record(value, ['sound', 'voice', 'notif', 'alertMini', 'auto']);
    if (Object.values(input).some((item) => typeof item !== 'boolean')) invalid();
    return { ...input } as CurrencyDevicePrefs;
  }
  if (key === 'kts_seen') {
    const input = record(value, ['cbrDate', 'moex', 'fut', 'futContracts', 'copper']);
    const fut = 'fut' in input ? quotes(input.fut, ['COPPER', 'BR']) : undefined;
    return {
      ...('cbrDate' in input ? { cbrDate: timestamp(input.cbrDate) } : {}),
      ...('moex' in input ? { moex: quotes(input.moex, ['CNYRUB_TOM', 'KZTRUB_TOM']) } : {}),
      ...(fut ? { fut } : {}),
      ...('futContracts' in input ? { futContracts: futureContracts(input.futContracts, fut) } : {}),
      ...('copper' in input ? { copper: copperQuote(input.copper) } : {}),
    };
  }
  if (!Array.isArray(value) || value.length > 200) invalid();
  return Array.from(value, (item) => {
    const input = record(item, ['t', 'msg', 'risk']);
    if (typeof input.risk !== 'boolean') invalid();
    return { t: timestamp(input.t), msg: text(input.msg), risk: input.risk };
  });
}
export function validateCurrencyDeviceValues(value: unknown): CurrencyDeviceValues {
  const input = record(value, KEYS);
  const result = Object.fromEntries(Object.entries(input).map(([key, item]) => [key, validateValue(key as DeviceKey, item)]));
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_BYTES) invalid();
  return result;
}
function mergeLogs(current: CurrencyDeviceLogEntry[] = [], incoming: CurrencyDeviceLogEntry[] = []) {
  const unique = new Map([...current, ...incoming].map((entry) => [JSON.stringify(entry), entry]));
  return [...unique.values()].sort((a, b) => Date.parse(b.t) - Date.parse(a.t)).slice(0, 200);
}
function mergeValue(values: CurrencyDeviceValues, key: DeviceKey, incoming: CurrencyDeviceValues[DeviceKey]): CurrencyDeviceValues {
  const next = { ...values, [key]: incoming };
  if (key === 'kts_log') next.kts_log = mergeLogs(values.kts_log, incoming as CurrencyDeviceLogEntry[]);
  if (key === 'kts_seen') {
    const seen = incoming as CurrencyDeviceSeen, previous = values.kts_seen;
    next.kts_seen = { ...previous, ...seen,
      ...(previous?.moex || seen.moex ? { moex: { ...previous?.moex, ...seen.moex } } : {}),
      ...(previous?.fut || seen.fut ? { fut: { ...previous?.fut, ...seen.fut } } : {}),
    };
    if (previous?.futContracts || seen.futContracts) {
      const contracts = { ...previous?.futContracts, ...seen.futContracts };
      // Legacy tabs may still write an unlabelled quote. Never retain another
      // contract's identity on that price; the iframe will establish a new base.
      for (const asset of ['COPPER', 'BR'] as const) {
        if (seen.fut?.[asset] !== undefined && !seen.futContracts?.[asset]) delete contracts[asset];
      }
      next.kts_seen.futContracts = contracts;
    }
    if (previous?.cbrDate && seen.cbrDate && Date.parse(previous.cbrDate) > Date.parse(seen.cbrDate)) next.kts_seen.cbrDate = previous.cbrDate;
    if (previous?.copper && seen.copper && previous.copper.date > seen.copper.date) next.kts_seen.copper = previous.copper;
  }
  return validateCurrencyDeviceValues(next);
}

export function createCurrencyDeviceState(scope: string | null, storage: () => BrowserStorage | null) {
  if (scope !== null && !/^(?:user:[1-9]\d{0,15}|manager:[1-9]\d{0,15}|admin:primary)$/.test(scope)) invalid();
  const storageKey = scope ? `kts:currency-device:v1:${scope}` : null;
  let memory: CurrencyDeviceValues = {};
  const unsaved = new Set<DeviceKey>();
  const read = () => {
    try {
      const target = storageKey ? storage() : null;
      if (!target) return { values: memory, persistent: false, target: null };
      const raw = target.getItem(storageKey!);
      if (raw !== null && (raw.length > MAX_BYTES || new TextEncoder().encode(raw).byteLength > MAX_BYTES)) invalid();
      const saved = raw === null ? {} : validateCurrencyDeviceValues(JSON.parse(raw));
      const local = memory;
      memory = saved;
      for (const key of unsaved) memory = mergeValue(memory, key, local[key]);
      return { values: memory, persistent: unsaved.size === 0, target };
    } catch { return { values: memory, persistent: false, target: null }; }
  };
  return {
    get() {
      const { values, persistent } = read();
      return { values: structuredClone(values), persistent };
    },
    set(keyInput: unknown, value: unknown) {
      if (typeof keyInput !== 'string' || !KEYS.includes(keyInput as DeviceKey)) invalid();
      const key = keyInput as DeviceKey;
      const incoming = validateValue(key, value);
      // Read on every write: another open report may have changed a different key.
      const { values, target } = read();
      memory = mergeValue(values, key, incoming);
      unsaved.add(key);
      try {
        if (!target || !storageKey) return { persistent: false };
        target.setItem(storageKey, JSON.stringify(memory));
        unsaved.clear();
        return { persistent: true };
      } catch { return { persistent: false }; }
    },
  };
}

export function isCurrencyDeviceMethod(method: unknown): method is 'device:get' | 'device:set' | 'notification:permission' | 'notification:show' {
  return typeof method === 'string' && ['device:get', 'device:set', 'notification:permission', 'notification:show'].includes(method);
}

/** Browser-only commands never enter the server RPC or choose a storage namespace. */
export function createCurrencyDeviceBridge(scope: string | null, storage: () => BrowserStorage | null, notifications: () => Notifications | null) {
  const device = createCurrencyDeviceState(scope, storage);
  return async (method: unknown, params: unknown = {}) => {
    if (method === 'device:get') { record(params, []); return device.get(); }
    if (method === 'device:set') { const input = record(params, ['key', 'value']); return device.set(input.key, input.value); }
    if (method === 'notification:permission') {
      record(params, []);
      try {
        const api = notifications();
        return { permission: api ? await api.requestPermission() : 'unsupported' };
      } catch { return { permission: 'unsupported' }; }
    }
    if (method === 'notification:show') {
      const input = record(params, ['body']);
      const body = text(input.body);
      try {
        const api = notifications();
        const permission: CurrencyNotificationPermission = api?.permission() ?? 'unsupported';
        if (!api || permission !== 'granted' || device.get().values.kts_prefs?.notif !== true) return { shown: false, permission };
        api.show(body);
        return { shown: true, permission };
      } catch { return { shown: false, permission: 'unsupported' }; }
    }
    return invalid();
  };
}
