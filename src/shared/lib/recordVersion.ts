const MAX_RECORD_REVISION = '9223372036854775807';

/** Keep PostgreSQL bigint revisions as strings; never round them through JS numbers. */
export function parseRecordRevision(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) return null;
  if (value.length === MAX_RECORD_REVISION.length && value > MAX_RECORD_REVISION) return null;
  return value;
}

export class RecordVersionConflictError extends Error {
  readonly code = 'RECORD_VERSION_CONFLICT';
  readonly status = 409;

  constructor() {
    super('Данные уже изменены другим пользователем. Обновите данные и повторите изменения.');
    this.name = 'RecordVersionConflictError';
  }
}

/** Call under the record's transaction lock, before any side effects. */
export function assertRecordRevision(expected: unknown, current: string): void {
  const parsed = parseRecordRevision(expected);
  if (!parsed || parsed !== parseRecordRevision(current)) throw new RecordVersionConflictError();
}
