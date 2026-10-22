import { revalidatePath } from 'next/cache';

import { parseRecordRevision, RecordVersionConflictError } from './recordVersion';

/** A missing revision is an old form, never permission to overwrite the current row. */
export async function saveVersionedContent<T>(revision: unknown, save: (revision: string) => Promise<T>) {
  const expected = parseRecordRevision(revision);
  if (!expected) {
    const error = new RecordVersionConflictError();
    return Response.json({ error: error.message, code: error.code }, { status: 409 });
  }

  let item: T;
  try {
    item = await save(expected);
  } catch (error) {
    if (error instanceof RecordVersionConflictError) {
      return Response.json({ error: error.message, code: error.code }, { status: 409 });
    }
    throw error;
  }

  // A later GET could return somebody else's next revision. Acknowledge exactly
  // the row returned by our atomic UPDATE, not a second read of the collection.
  const warnings: string[] = [];
  try {
    revalidatePath('/');
  } catch {
    warnings.push('Запись сохранена, но обновление публичной страницы задерживается. Повторять сохранение не нужно.');
  }
  return Response.json({ ok: true, item, ...(warnings.length ? { warnings } : {}) });
}
