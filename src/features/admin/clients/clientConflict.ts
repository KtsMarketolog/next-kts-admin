import { toDraft, withoutClientCredentials, type ClientCompany, type ClientDraft } from './AdminClientsModel';

/** Only business fields can be reapplied; credential and version fields never participate. */
export const CLIENT_EDITABLE_FIELDS = [
  'title', 'email', 'phone', 'note', 'managerId', 'supportManagerId', 'requireTwoFactor', 'isActive',
] as const;

export type ClientEditableField = typeof CLIENT_EDITABLE_FIELDS[number];
export type ClientConflictValue = ClientDraft[ClientEditableField];
export type ClientConflictField = {
  key: ClientEditableField;
  label: string;
  baseValue: ClientConflictValue;
  localValue: ClientConflictValue;
  serverValue: ClientConflictValue;
  localChanged: boolean;
  serverChanged: boolean;
};
export type ClientConflictComparison = {
  base: ClientCompany;
  local: ClientDraft;
  latest: ClientCompany;
  fields: ClientConflictField[];
};

const labels: Record<ClientEditableField, string> = {
  title: 'Компания',
  email: 'Email',
  phone: 'Телефон',
  note: 'Заметка',
  managerId: 'Менеджер',
  supportManagerId: 'Сопровождение',
  requireTwoFactor: 'Требовать код на email при входе',
  isActive: 'Активна',
};

const incompleteComparison = 'Не удалось сопоставить ваши правки с актуальными данными клиента. Загрузите актуальную карточку перед новым сохранением.';

function validVersion(value: unknown): value is string {
  // Keep the original database timestamp, including microseconds: parsing it to
  // a Date and serializing back would lose part of the optimistic-lock token.
  if (typeof value !== 'string' || value.length > 64) return false;
  const parts = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(value);
  if (!parts) return false;
  // WebKit does not consistently parse PostgreSQL's space / +00 notation.
  // Normalize a validation-only copy, never the revision sent back to the API.
  const offset = parts[4] === 'Z' ? 'Z' : parts[4].length === 3 ? `${parts[4]}:00`
    : parts[4].length === 5 ? `${parts[4].slice(0, 3)}:${parts[4].slice(3)}` : parts[4];
  return Number.isFinite(Date.parse(`${parts[1]}T${parts[2]}.${(parts[3] ?? '').slice(0, 3).padEnd(3, '0')}${offset}`));
}

function hasEditableFields(value: unknown): value is Pick<ClientDraft, ClientEditableField> {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return CLIENT_EDITABLE_FIELDS.every(key => {
    if (key === 'managerId' || key === 'supportManagerId') {
      return record[key] === null || (Number.isSafeInteger(record[key]) && Number(record[key]) > 0);
    }
    if (key === 'requireTwoFactor' || key === 'isActive') return typeof record[key] === 'boolean';
    return typeof record[key] === 'string';
  });
}

function validCompany(value: unknown): value is ClientCompany {
  if (!value || typeof value !== 'object' || !hasEditableFields(value)) return false;
  const company = value as ClientCompany;
  return Number.isSafeInteger(company.id) && company.id > 0 && validVersion(company.updatedAt)
    && (company.archivedAt === null || validVersion(company.archivedAt));
}

function editableFieldsEqual(left: Pick<ClientDraft, ClientEditableField>, right: Pick<ClientDraft, ClientEditableField>) {
  return CLIENT_EDITABLE_FIELDS.every(key => left[key] === right[key]);
}

/** This pure comparison deliberately discards entered/revealed passwords. */
export function buildClientConflict(base: ClientCompany, local: ClientDraft, latest: ClientCompany): ClientConflictComparison {
  if (!validCompany(base) || !validCompany(latest) || !hasEditableFields(local)
    || base.id !== latest.id || base.archivedAt !== null || latest.archivedAt !== null
    || local.expectedUpdatedAt !== base.updatedAt) {
    throw new Error(incompleteComparison);
  }
  const safeLocal = toDraft(base);
  for (const key of CLIENT_EDITABLE_FIELDS) Object.assign(safeLocal, { [key]: local[key] });
  return {
    base: withoutClientCredentials(base),
    local: safeLocal,
    latest: withoutClientCredentials(latest),
    fields: CLIENT_EDITABLE_FIELDS.flatMap(key => {
      const localChanged = local[key] !== base[key];
      const serverChanged = latest[key] !== base[key];
      return localChanged || serverChanged ? [{ key, label: labels[key], baseValue: base[key], localValue: local[key],
        serverValue: latest[key], localChanged, serverChanged }] : [];
    }),
  };
}

/** Build a new unsaved draft; applying the result never makes a server request. */
export function resolveClientConflict(comparison: ClientConflictComparison, selectedFields: readonly ClientEditableField[]): ClientDraft {
  // Recheck snapshots rather than trusting a caller-supplied row/changed flag.
  const checked = buildClientConflict(comparison.base, comparison.local, comparison.latest);
  if (!Array.isArray(selectedFields) || selectedFields.some(key => !CLIENT_EDITABLE_FIELDS.includes(key))) {
    throw new Error(incompleteComparison);
  }
  const selected = new Set(selectedFields);
  const resolved = toDraft(checked.latest);
  for (const field of checked.fields) {
    if (field.localChanged && selected.has(field.key)) Object.assign(resolved, { [field.key]: field.localValue });
  }
  return resolved;
}

/**
 * A refreshed list is not the baseline of an older local draft. Keep that
 * baseline and its exact version until explicit save/discard/conflict recovery.
 * Hidden drafts (scope/filter changes) are retained without storing passwords
 * in any additional comparison or baseline state.
 */
export function reconcileClientDrafts(
  current: Record<number, ClientDraft>,
  companies: ClientCompany[],
  baselines: Map<number, ClientCompany>,
  passwordEditIds: Record<number, boolean> = {},
): { drafts: Record<number, ClientDraft>; baselines: Map<number, ClientCompany> } {
  const drafts = { ...current };
  const nextBaselines = new Map(baselines);
  for (const company of companies) {
    if (!validCompany(company)) throw new Error('Получена неполная карточка клиента. Несохранённые правки оставлены; обновите список.');
    const local = current[company.id];
    const base = baselines.get(company.id);
    if (local) {
      const dirty = !validCompany(base) || base.id !== company.id || !hasEditableFields(local)
        || local.expectedUpdatedAt !== base.updatedAt || !editableFieldsEqual(local, base)
        || Boolean(local.password) || passwordEditIds[company.id] === true;
      if (dirty) continue;
    } else if (passwordEditIds[company.id] === true && validCompany(base)) {
      drafts[company.id] = toDraft(base);
      continue;
    }
    const safeCompany = withoutClientCredentials(company);
    drafts[company.id] = toDraft(safeCompany);
    nextBaselines.set(company.id, safeCompany);
  }
  return { drafts, baselines: nextBaselines };
}
