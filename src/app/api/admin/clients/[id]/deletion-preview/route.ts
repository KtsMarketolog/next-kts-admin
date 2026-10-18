import { requireEmployee } from '@/shared/lib/adminAuth';
import { canSeeAllClients } from '@/shared/lib/db/clientCompaniesRepo.helpers';
import { getClientCompanyDeletionPreview } from '@/shared/lib/db/clientArchivePurgeRepo';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;
  if (!canSeeAllClients(session)) return Response.json({ error: 'Недостаточно прав для окончательного удаления клиента' }, { status: 403 });
  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    return Response.json({ error: 'Некорректная компания клиента' }, { status: 400 });
  }
  try {
    const preview = await getClientCompanyDeletionPreview(numericId, session);
    return Response.json({ preview }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Не удалось проверить последствия удаления' }, { status: 400 });
  }
}
