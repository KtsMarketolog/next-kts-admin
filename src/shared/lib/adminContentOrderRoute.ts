import { revalidatePath } from 'next/cache';

import { requireAdmin } from './adminAuth';
import { AdminContentOrderValidationError, readAdminContentOrderBody, type AdminContentOrderKind } from './adminContentOrder';
import { AdminContentOrderConflictError, reorderAdminContent } from './db/adminContentOrderRepo';
import { TransactionCommitUnknownError } from './db/transactionOutcome';
import { runPostCommitTasks } from './postCommitTasks';

export async function handleAdminContentReorder(request: Request, kind: AdminContentOrderKind) {
  const denied = await requireAdmin();
  if (denied) return denied;

  try {
    const items = await reorderAdminContent(kind, await readAdminContentOrderBody(request));
    const warnings = await runPostCommitTasks([{
      code: 'CONTENT_ORDER_CACHE_REFRESH_FAILED',
      message: 'Порядок сохранён, но обновление публичной страницы задерживается. Повторно сохранять порядок не нужно.',
      run: () => revalidatePath('/'),
    }]);
    return Response.json({ ok: true, items, ...(warnings.length ? { warnings } : {}) });
  } catch (error) {
    if (error instanceof AdminContentOrderValidationError) {
      return Response.json({ error: error.message, saveState: 'not_saved' }, { status: error.status });
    }
    if (error instanceof AdminContentOrderConflictError) {
      return Response.json({ error: error.message, code: error.code, saveState: 'not_saved' }, { status: 409 });
    }
    if (error instanceof TransactionCommitUnknownError) {
      return Response.json({ error: error.message, code: error.code, saveState: 'unknown' }, { status: 503 });
    }
    // Never expose database statements or credentials in the response/log.
    console.error(JSON.stringify({ event: 'admin_content_reorder_failed', kind }));
    return Response.json({ error: 'Не удалось сохранить порядок. Изменения не сохранены.', saveState: 'not_saved' }, { status: 500 });
  }
}
