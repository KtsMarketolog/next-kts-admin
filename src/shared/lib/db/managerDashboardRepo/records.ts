import type {
  PersonalDashboardImportStatus,
  SnapshotRow,
  PersonalDashboardSnapshot,
  HtmlRow,
  PersonalDashboardHtmlVersion,
  ImportRow,
  PersonalDashboardImportResult,
} from './types';
import { personalDashboardToday } from '../../managerDashboardDomain';

export const IMPORT_MESSAGES: Record<PersonalDashboardImportStatus, string> = {
  imported: 'Личный снимок сохранён и назначен сотруднику',
  duplicate: 'Этот снимок уже обработан',
  unknown: 'Не найден активный МР, МС или руководитель (Админ, Админ ТОП, ТОП) с email этого снимка',
  ambiguous: 'Email снимка соответствует нескольким сотрудникам; требуется проверка',
  stale: 'Более старый снимок не заменяет текущий',
  expired: 'Срок действия снимка истёк',
  conflict: 'За эту дату уже есть другой снимок; требуется проверка',
  invalid: 'Снимок не прошёл проверку формата или доставки',
  quota: 'Лимит хранения личных снимков достигнут; текущие данные сохранены',
};

export const SNAPSHOT_SELECT = `s.id::text, s.manager_id::text, s.admin_user_id::text, s.original_name, s.file_size::text, s.sha256,
  s.email_hash, s.person_name, s.person_role, s.issued::text, s.expires::text,
  s.source_key, s.received_at::text, st.active_snapshot_id::text, st.previous_snapshot_id::text`;

export const HTML_SELECT = `v.id::text, v.audience, v.original_name, v.file_size::text, v.sha256, v.created_at::text,
  v.uploaded_by, v.first_published_at::text`;

export const IMPORT_SELECT = `id::text, original_name, status, code, manager_id::text, admin_user_id::text, snapshot_id::text`;

export const SNAPSHOT_OWNER_JOIN = '(st.manager_id=s.manager_id or st.admin_user_id=s.admin_user_id)';

export function idOrNull(id: string | null): number | null { return id === null ? null : Number(id); }

export function mapSnapshot(row: SnapshotRow): PersonalDashboardSnapshot {
  return {
    id: Number(row.id), managerId: idOrNull(row.manager_id), adminUserId: idOrNull(row.admin_user_id), originalName: row.original_name,
    fileSize: Number(row.file_size), sha256: row.sha256, emailHash: row.email_hash,
    name: row.person_name, role: row.person_role, issued: row.issued, expires: row.expires,
    sourceKey: row.source_key, receivedAt: row.received_at,
    status: row.id === row.active_snapshot_id ? 'active' : row.id === row.previous_snapshot_id ? 'previous' : 'archived',
    expired: row.expires < personalDashboardToday(),
  };
}

export function mapHtml(row: HtmlRow, activeId: string | null): PersonalDashboardHtmlVersion {
  return {
    id: Number(row.id), audience: row.audience, originalName: row.original_name, fileSize: Number(row.file_size), sha256: row.sha256,
    createdAt: row.created_at, uploadedBy: row.uploaded_by, firstPublishedAt: row.first_published_at,
    status: row.id === activeId ? 'active' : row.first_published_at ? 'archived' : 'draft',
  };
}

export function mapImport(row: ImportRow): PersonalDashboardImportResult {
  return { id: Number(row.id), originalName: row.original_name, status: row.status, code: row.code,
    message: row.code === 'REPLACED_SAME_DAY' ? 'Снимок за эту дату заменён по подтверждению; предыдущий доступен для отката'
      : row.code === 'SNAPSHOT_ROLLED_BACK' ? 'Восстановлен предыдущий личный снимок' : IMPORT_MESSAGES[row.status],
    managerId: idOrNull(row.manager_id), adminUserId: idOrNull(row.admin_user_id), snapshotId: idOrNull(row.snapshot_id) };
}
