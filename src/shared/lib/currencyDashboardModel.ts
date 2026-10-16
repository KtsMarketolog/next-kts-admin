/** Shared manual data only. Market history and device preferences never enter this contract. */
export const CURRENCY_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
export const CURRENCY_CACHE_MAX_BYTES = 16 * 1024 * 1024;

export type CurrencySnapshotData = {
  [key: string]: unknown;
  kts_cpsRates?: { eur: number; cny: number; usd: number | null; from: string; to: string };
  kts_an?: { upd: string; rows: string[] };
  kts_cu?: { prem: number; rows: { date: string; price: number }[]; lmci: number | null; lmciDate: string | null };
  kts_log?: { t: string; msg: string; risk: boolean }[];
  kts_weights?: Record<string, { USD: number; EUR: number; CNY: number; KZT: number; rev: number | null }>;
  kts_f27?: { upd: string; rows: string[] };
};
export type CurrencySnapshot = { at: string; version: `V${number}`; data: CurrencySnapshotData };
export type StoredCurrencySnapshot = CurrencySnapshot & { savedAt: string; actor: string };
export type CurrencySnapshotState = { revision: number; current: StoredCurrencySnapshot | null; previous: StoredCurrencySnapshot | null };
export type CurrencyBaseline = {
  price: number;
  time: string;
  src: string;
  secid: string;
  capturedAt: string;
  quoteAt: string | null;
  stale: boolean;
  premium?: number;
};
export type CurrencyBaselineDay = { COPPER?: CurrencyBaseline; BR?: CurrencyBaseline };
export type CurrencyBaselines = Record<string, CurrencyBaselineDay>;

export class CurrencyDashboardValidationError extends Error {
  readonly code = 'CURRENCY_VALIDATION';
  constructor(message: string) { super(message); this.name = 'CurrencyDashboardValidationError'; }
}

function invalid(path: string, message: string): never {
  throw new CurrencyDashboardValidationError(`${path}: ${message}`);
}

/** Reject objects JSON cannot faithfully represent, prototype keys, cycles, and resource abuse. */
export function validateCurrencyJson(value: unknown, maximumBytes = CURRENCY_CACHE_MAX_BYTES): void {
  const stack = new Set<object>();
  let nodes = 0;
  const walk = (item: unknown, depth: number): void => {
    if (++nodes > 500_000 || depth > 24) invalid('Данные', 'слишком сложная структура');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object') invalid('Данные', 'ожидаются корректные значения JSON');
    const object = item as object;
    if (stack.has(object)) invalid('Данные', 'циклическая структура недопустима');
    const proto = Object.getPrototypeOf(object);
    if (Array.isArray(object) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
      invalid('Данные', 'недопустимый тип объекта');
    }
    stack.add(object);
    for (const key of Reflect.ownKeys(object)) {
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) invalid('Данные', 'недопустимое имя поля');
      if (Array.isArray(object) && key === 'length') continue;
      if (Array.isArray(object) && !/^(0|[1-9]\d*)$/.test(key)) invalid('Данные', 'недопустимое поле массива');
      const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
      if (!('value' in descriptor)) invalid('Данные', 'вычисляемые поля недопустимы');
      walk(descriptor.value, depth + 1);
    }
    if (Array.isArray(object) && Object.keys(object).length !== object.length) invalid('Данные', 'разреженный массив недопустим');
    stack.delete(object);
  };
  walk(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximumBytes) invalid('Данные', 'превышен допустимый размер');
}

function record(value: unknown, keys: string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'ожидается объект');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) invalid(path, 'есть неизвестные поля');
  return result;
}

function text(value: unknown, path: string, maximum = 2000, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.trim()) || /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    invalid(path, 'ожидается текст допустимой длины без HTML и управляющих символов');
  }
  return value;
}

function amount(value: unknown, path: string, allowZero = false, max = 1_000_000_000): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value > max || (allowZero ? value < 0 : value <= 0)) {
    invalid(path, allowZero ? 'ожидается неотрицательное конечное число' : 'ожидается положительное конечное число');
  }
  return value;
}

export function validateCurrencyDate(value: unknown, path = 'Дата', minimumYear = 2000): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid(path, 'ожидается дата ГГГГ-ММ-ДД');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || Number(value.slice(0, 4)) < minimumYear || Number(value.slice(0, 4)) > 2100) {
    invalid(path, `дата должна быть действительной, от ${minimumYear} до 2100 года`);
  }
  return value;
}

export function validateCurrencyTimestamp(value: unknown, path = 'Время'): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) invalid(path, 'ожидается время ISO с часовым поясом');
  validateCurrencyDate(value.slice(0, 10), path);
  const match = value.match(/T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/)!;
  if (+match[1] > 23 || +match[2] > 59 || +match[3] > 59 || (match[4] !== 'Z' && (+match[5] > 14 || +match[6] > 59 || (+match[5] === 14 && +match[6] !== 0)))) invalid(path, 'некорректное время');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) invalid(path, 'некорректное время');
  return parsed.toISOString();
}

function russianDate(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^\d{2}\.\d{2}\.\d{4}$/.test(value)) invalid(path, 'ожидается дата ДД.ММ.ГГГГ');
  const [day, month, year] = value.split('.');
  validateCurrencyDate(`${year}-${month}-${day}`, path);
  return value;
}

function list(value: unknown, maximum: number, path: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid(path, `ожидается список не более ${maximum} записей`);
  return value;
}

/** Later author's versions can add manual sections without overwriting server or device state. */
export function isCurrencyManualSnapshotKey(key: string): boolean {
  return /^kts_[A-Za-z0-9_]{1,80}$/.test(key) &&
    !/^kts_(?:base(?:Hist)?|moexHist|cbrHist(?:_.*)?|prefs|seen|meta|gs|device.*|auth.*|session.*)$/i.test(key);
}

function validateAdditionalManualData(value: unknown, path: string): void {
  if (typeof value === 'string') { text(value, path, CURRENCY_SNAPSHOT_MAX_BYTES, true); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    text(key, path, 200, true);
    validateAdditionalManualData(child, `${path}.${key}`);
  }
}

export function validateCurrencySnapshot(value: unknown): CurrencySnapshot {
  validateCurrencyJson(value, CURRENCY_SNAPSHOT_MAX_BYTES);
  const root = record(value, ['at', 'version', 'data'], 'Снимок');
  const at = validateCurrencyTimestamp(root.at, 'Время снимка');
  // V25 itself still exports the historical V16 marker. Validate structure, not a single version label.
  if (typeof root.version !== 'string' || !/^V[1-9]\d{0,3}$/.test(root.version)) invalid('Версия снимка', 'ожидается номер версии V1–V9999');
  if (!root.data || typeof root.data !== 'object' || Array.isArray(root.data)) invalid('Данные снимка', 'ожидается объект');
  const source = root.data as Record<string, unknown>;
  const data: CurrencySnapshotData = {};
  for (const [key, field] of Object.entries(source)) {
    if (!isCurrencyManualSnapshotKey(key)) invalid('Данные снимка', 'поля серверных источников и настроек устройства нельзя сохранять как ручные данные');
    if (!['kts_cpsRates', 'kts_an', 'kts_cu', 'kts_log', 'kts_weights', 'kts_f27'].includes(key)) {
      validateAdditionalManualData(field, key);
      data[key] = structuredClone(field);
    }
  }
  if ('kts_cpsRates' in source) {
    const r = record(source.kts_cpsRates, ['eur', 'cny', 'usd', 'from', 'to'], 'Внутренние курсы');
    const from = validateCurrencyDate(r.from, 'Начало действия курса');
    const to = validateCurrencyDate(r.to, 'Конец действия курса');
    if (to < from) invalid('Период курса', 'окончание раньше начала');
    data.kts_cpsRates = { eur: amount(r.eur, 'EUR', false, 1_000_000), cny: amount(r.cny, 'CNY', false, 1_000_000), usd: r.usd == null ? null : amount(r.usd, 'USD', false, 1_000_000), from, to };
  }
  if ('kts_an' in source) {
    const r = record(source.kts_an, ['upd', 'rows'], 'Прогнозы');
    data.kts_an = { upd: russianDate(r.upd, 'Дата сводки прогнозов'), rows: list(r.rows, 100, 'Прогнозы').map((row, i) => {
      const line = text(row, `Прогноз ${i + 1}`, 2000);
      const parts = line.split('|').map((part) => part.trim());
      if (parts.length !== 5 || !parts[0]) invalid(`Прогноз ${i + 1}`, 'нужны источник, USD, CNY, горизонт и дата через |');
      if (parts[4] && parts[4] !== '—') russianDate(parts[4], `Дата прогноза ${i + 1}`);
      return parts.join(' | ');
    }) };
  }
  if ('kts_cu' in source) {
    const r = record(source.kts_cu, ['prem', 'rows', 'lmci', 'lmciDate'], 'Ручные данные меди');
    const dates = new Set<string>();
    const rows = list(r.rows, 10_000, 'Ручные цены меди').map((row, i) => {
      const entry = record(row, ['date', 'price'], `Цена меди ${i + 1}`);
      const date = validateCurrencyDate(entry.date, `Дата цены меди ${i + 1}`);
      if (dates.has(date)) invalid('Ручные цены меди', 'даты не должны повторяться');
      dates.add(date);
      return { date, price: amount(entry.price, `Цена меди ${i + 1}`) };
    }).sort((a, b) => a.date.localeCompare(b.date));
    const lmci = r.lmci == null ? null : amount(r.lmci, 'LMCI');
    const lmciDate = r.lmciDate == null ? null : validateCurrencyDate(r.lmciDate, 'Дата LMCI');
    if ((lmci === null) !== (lmciDate === null)) invalid('LMCI', 'цена и дата должны быть указаны вместе');
    data.kts_cu = { prem: amount(r.prem, 'Премия Jintian', true, 1_000_000), rows, lmci, lmciDate };
  }
  if ('kts_log' in source) {
    data.kts_log = list(source.kts_log, 200, 'Журнал').map((row, i) => {
      const entry = record(row, ['t', 'msg', 'risk'], `Запись журнала ${i + 1}`);
      if (entry.risk !== undefined && typeof entry.risk !== 'boolean') invalid('Журнал', 'risk должен быть логическим значением');
      return { t: validateCurrencyTimestamp(entry.t, 'Время записи журнала'), msg: text(entry.msg, 'Сообщение журнала'), risk: entry.risk === true };
    });
  }
  if ('kts_weights' in source) {
    if (!source.kts_weights || typeof source.kts_weights !== 'object' || Array.isArray(source.kts_weights)) invalid('Структура закупок', 'ожидается объект по годам');
    data.kts_weights = {};
    for (const [year, row] of Object.entries(source.kts_weights)) {
      if (!/^(?:20\d\d|2100)$/.test(year) || Number(year) < 2022) invalid('Год структуры закупок', 'ожидается год от 2022 до 2100');
      const r = record(row, ['USD', 'EUR', 'CNY', 'KZT', 'rev'], `Структура закупок ${year}`);
      data.kts_weights[year] = {
        USD: amount(r.USD, `Доля USD ${year}`, true, 100), EUR: amount(r.EUR, `Доля EUR ${year}`, true, 100),
        CNY: amount(r.CNY, `Доля CNY ${year}`, true, 100), KZT: amount(r.KZT, `Доля KZT ${year}`, true, 100),
        rev: r.rev == null ? null : amount(r.rev, `Выручка ${year}`, true, 1_000_000_000_000),
      };
    }
  }
  if ('kts_f27' in source) {
    const r = record(source.kts_f27, ['upd', 'rows'], 'Прогноз 2027');
    data.kts_f27 = { upd: russianDate(r.upd, 'Дата сводки 2027'), rows: list(r.rows, 1000, 'Прогноз 2027').map((row, i) => {
      const line = text(row, `Прогноз 2027 ${i + 1}`, 2000);
      const parts = line.split('|').map((part) => part.trim());
      if (parts.length !== 6 || !parts[0]) invalid(`Прогноз 2027 ${i + 1}`, 'нужны источник, дата, USD 2026, USD 2027, ставка 2026 и ставка 2027 через |');
      if (parts[1] && parts[1] !== '—') russianDate(parts[1], `Дата прогноза 2027 ${i + 1}`);
      return parts.join(' | ');
    }) };
  }
  return { at, version: root.version as CurrencySnapshot['version'], data };
}

export function validateCurrencyActor(value: unknown): string {
  return text(value, 'Автор изменения', 160);
}

export function validateCurrencyRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid('Версия данных', 'ожидается целое неотрицательное число');
  return value as number;
}

export function validateCurrencyCacheKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9:._-]{0,199}$/.test(value)) invalid('Ключ источника', 'некорректный ключ');
  return value;
}

export function validateCurrencyBaselineDay(value: unknown): CurrencyBaselineDay {
  validateCurrencyJson(value, 8192);
  const day = record(value, ['COPPER', 'BR'], 'База дня');
  if (!Object.keys(day).length) invalid('База дня', 'нет данных инструментов');
  const result: CurrencyBaselineDay = {};
  for (const asset of ['COPPER', 'BR'] as const) {
    if (!(asset in day)) continue;
    const r = record(day[asset], ['price', 'time', 'src', 'secid', 'capturedAt', 'quoteAt', 'stale', 'premium'], `База ${asset}`);
    if (typeof r.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(r.time)) invalid('Время базы', 'ожидается ЧЧ:ММ');
    if (typeof r.secid !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(r.secid)) invalid('Инструмент базы', 'некорректный идентификатор');
    if (typeof r.stale !== 'boolean') invalid('База дня', 'stale должен быть логическим значением');
    result[asset] = { price: amount(r.price, `Цена ${asset}`), time: r.time, src: text(r.src, 'Источник базы', 160), secid: r.secid,
      capturedAt: validateCurrencyTimestamp(r.capturedAt, 'Время фиксации базы'), quoteAt: r.quoteAt === null ? null : validateCurrencyTimestamp(r.quoteAt, 'Время котировки'), stale: r.stale,
      ...('premium' in r ? { premium: amount(r.premium, 'Премия базы', true, 1_000_000) } : {}),
    };
  }
  return result;
}
