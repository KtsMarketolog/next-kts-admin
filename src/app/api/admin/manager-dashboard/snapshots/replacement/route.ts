import { scheduleDashboardUploadUsageDrain } from '@/shared/lib/dashboardUploadUsage';
import {
  confirmPersonalDashboardSnapshotReplacement, confirmPersonalDashboardSnapshotRollback,
  preparePersonalDashboardSnapshotReplacement, preparePersonalDashboardSnapshotRollback,
} from '@/shared/lib/db/managerDashboardRepo';
import { PERSONAL_DASHBOARD_SNAPSHOT_MAX_BYTES } from '@/shared/lib/managerDashboardDomain';
import { personalApiError, personalJson, personalMultipart, requirePersonalAccess } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const access = await requirePersonalAccess(request, true);
    if (access.denied) return access.denied;
    const form = await personalMultipart(request, PERSONAL_DASHBOARD_SNAPSHOT_MAX_BYTES + 64 * 1024);
    const action = form.get('action');
    const allowed = action === 'prepare' ? ['action', 'file'] : action === 'confirm' ? ['action', 'file', 'token', 'confirmed']
      : action === 'prepare-rollback' ? ['action', 'recipientSource', 'recipientId'] : action === 'confirm-rollback' ? ['action', 'token', 'confirmed'] : [];
    if (!allowed.length || [...form.keys()].some(key => !allowed.includes(key) || form.getAll(key).length !== 1)) {
      return personalJson({error: 'Некорректные параметры подтверждения'}, 400);
    }
    if (action === 'prepare' || action === 'confirm') {
      const file = form.get('file');
      if (!(file instanceof File) || !file.size || file.size > PERSONAL_DASHBOARD_SNAPSHOT_MAX_BYTES) return personalJson({error: 'Выберите один файл .ktsp до 8 МиБ'}, 400);
      const input = {filename: file.name, bytes: Buffer.from(await file.arrayBuffer())};
      if (action === 'prepare') return personalJson({preview: await preparePersonalDashboardSnapshotReplacement(access.session, input)});
      if (form.get('confirmed') !== 'true' || typeof form.get('token') !== 'string') return personalJson({error: 'Сначала сравните файлы и подтвердите замену'}, 400);
      const result = await confirmPersonalDashboardSnapshotReplacement(access.session, {...input, token: form.get('token') as string});
      scheduleDashboardUploadUsageDrain();
      return personalJson({results: [result]});
    }
    if (action === 'prepare-rollback') {
      const source = form.get('recipientSource');
      const id = Number(form.get('recipientId'));
      if ((source !== 'manager' && source !== 'admin') || !Number.isSafeInteger(id) || id < 1) return personalJson({error: 'Выберите сотрудника'}, 400);
      return personalJson({preview: await preparePersonalDashboardSnapshotRollback(access.session, {source, id})});
    }
    if (form.get('confirmed') !== 'true' || typeof form.get('token') !== 'string') return personalJson({error: 'Сначала сравните файлы и подтвердите откат'}, 400);
    return personalJson({results: [await confirmPersonalDashboardSnapshotRollback(access.session, {token: form.get('token') as string})]});
  } catch (error) { return personalApiError(error); }
}
