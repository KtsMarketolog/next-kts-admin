import { randomUUID } from 'node:crypto';
import { getPersonalDashboardSnapshot, importPersonalDashboardSnapshot, recordPersonalDashboardImportFailure } from '@/shared/lib/db/managerDashboardRepo';
import { personalDashboardSafeFilename } from '@/shared/lib/managerDashboardDomain';
import { PERSONAL_PRIVATE_HEADERS, parsePersonalDashboardId } from '@/shared/lib/managerDashboardSecurity';
import { personalApiError, personalJson, personalMultipart, requirePersonalAccess } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const access = await requirePersonalAccess();
    if (access.denied) return access.denied;
    if (access.mode !== 'view') return personalJson({error: 'Личные данные доступны только их владельцу'}, 403);
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some((key) => key !== 'snapshot')) return personalJson({error: 'Некорректные параметры'}, 400);
    const id = parsePersonalDashboardId(query.get('snapshot'));
    if (query.has('snapshot') && !id) return personalJson({error: 'Некорректная версия снимка'}, 400);
    const snapshot = await getPersonalDashboardSnapshot(access.manager!.id, id ?? undefined);
    if (!snapshot) return personalJson({error: 'Снимок не найден или недоступен'}, 404);
    return new Response(new Uint8Array(snapshot.bytes), {headers: {
      ...PERSONAL_PRIVATE_HEADERS,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(snapshot.bytes.length),
      'Content-Disposition': 'attachment; filename="personal-snapshot.ktsp"',
      'X-Personal-Email': encodeURIComponent(access.manager!.email.trim().toLowerCase()),
      'X-Personal-Filename': encodeURIComponent(snapshot.originalName),
    }});
  } catch (error) { return personalApiError(error); }
}

export async function POST(request: Request) {
  try {
    const access = await requirePersonalAccess(request, true);
    if (access.denied) return access.denied;
    const form = await personalMultipart(request, 64 * 1024 * 1024);
    const files = [...form.getAll('files'), ...form.getAll('file')];
    if (!files.length || files.length > 32 || files.some((file) => !(file instanceof File))) return personalJson({error: 'Выберите от 1 до 32 файлов .ktsp'}, 400);
    const batch = randomUUID();
    const results = [];
    for (const [index, file] of (files as File[]).entries()) {
      const sourceKey = `manual:${access.actorId}:${batch}:${index}`;
      if (file.size > 8 * 1024 * 1024 || !file.size) {
        results.push({originalName: personalDashboardSafeFilename(file.name), status: 'error', message: 'Размер .ktsp должен быть от 1 байта до 8 МиБ'});
        continue;
      }
      try {
        results.push(await importPersonalDashboardSnapshot({filename: file.name, bytes: Buffer.from(await file.arrayBuffer()), sourceKey}));
      } catch {
        // Preserve successful items and continue the batch; never return a DB/library error.
        await recordPersonalDashboardImportFailure({filename: file.name, sourceKey: `${sourceKey}:failure`, code: 'ATTACHMENT_FAILED'}).catch(() => {});
        results.push({originalName: personalDashboardSafeFilename(file.name), status: 'error', message: 'Не удалось сохранить этот снимок. Повторите загрузку; уже принятые файлы не дублируются.'});
      }
    }
    return personalJson({results});
  } catch (error) { return personalApiError(error); }
}
