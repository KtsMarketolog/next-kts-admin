import { getSupportSharedDashboardSnapshot, importSupportSharedDashboardSnapshot } from '@/shared/lib/db/supportSharedDashboardRepo';
import { PERSONAL_PRIVATE_HEADERS, parsePersonalDashboardId } from '@/shared/lib/managerDashboardSecurity';
import { personalApiError, personalJson, personalMultipart } from '../../_shared';
import { requireSharedAccess, sharedQuery } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const access = await requireSharedAccess();
    if (access.denied) return access.denied;
    if (access.mode !== 'view') return personalJson({error: 'Данные общего отчёта доступны в кабинете сопровождения'}, 403);
    const query = sharedQuery(request, ['snapshot']);
    const id = parsePersonalDashboardId(query?.get('snapshot') ?? null);
    if (!query || (query.has('snapshot') && !id)) return personalJson({error: 'Некорректные параметры снимка'}, 400);
    const snapshot = await getSupportSharedDashboardSnapshot(access.manager!.id, id ?? undefined);
    if (!snapshot) return personalJson({error: 'Общий снимок не найден или недоступен'}, 404);
    return new Response(new Uint8Array(snapshot.bytes), {headers: {
      ...PERSONAL_PRIVATE_HEADERS, 'Content-Type': 'application/octet-stream',
      'Content-Length': String(snapshot.bytes.length),
      'Content-Disposition': 'attachment; filename="support-shared-snapshot.ktsp"',
      'X-Personal-Email': encodeURIComponent(snapshot.email),
      'X-Personal-Filename': encodeURIComponent(snapshot.originalName),
    }});
  } catch (error) { return personalApiError(error); }
}

export async function POST(request: Request) {
  try {
    const access = await requireSharedAccess(request, true);
    if (access.denied) return access.denied;
    if (!sharedQuery(request, [])) return personalJson({error: 'Некорректные параметры'}, 400);
    const form = await personalMultipart(request, 8 * 1024 * 1024 + 256 * 1024);
    const fields = ['file', 'email', 'expectedActiveSnapshotId', 'confirmShared'];
    if ([...form.keys()].some((key) => !fields.includes(key)) || fields.some((key) => form.getAll(key).length !== 1)) {
      return personalJson({error: 'Нужен один общий снимок, email выпуска и подтверждение доступа всей группы'}, 400);
    }
    const file = form.get('file');
    const email = form.get('email');
    const expected = form.get('expectedActiveSnapshotId');
    const expectedId = typeof expected === 'string' ? parsePersonalDashboardId(expected) : null;
    if (!(file instanceof File) || typeof email !== 'string' || form.get('confirmShared') !== 'true'
      || !(expected === 'null' || expectedId)) return personalJson({error: 'Проверьте файл, email выпуска и подтверждение общего доступа'}, 400);
    if (!file.size || file.size > 8 * 1024 * 1024) return personalJson({error: 'Размер .ktsp должен быть от 1 байта до 8 МиБ'}, 413);
    const result = await importSupportSharedDashboardSnapshot({filename: file.name, bytes: Buffer.from(await file.arrayBuffer()), email,
      actorId: access.actorId, expectedActiveSnapshotId: expectedId});
    return personalJson({...result, message: result.status === 'duplicate' ? 'Этот общий снимок уже загружен.' : 'Общий снимок загружен для всех менеджеров по сопровождению.'});
  } catch (error) { return personalApiError(error); }
}
