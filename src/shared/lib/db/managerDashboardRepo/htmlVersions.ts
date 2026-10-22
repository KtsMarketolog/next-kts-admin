import type { PersonalDashboardAudience } from '../../managerDashboardAudience';
import { positiveId, checkedAudience, actor } from './validation';
import { ensureSiteSchema } from '../schema';
import { query, withTransaction } from '../client';
import type { HtmlRow, HtmlStateRow } from './types';
import { HTML_SELECT, mapHtml, idOrNull } from './records';
import type { DashboardUploadUsageActor } from '../../dashboardUploadUsage';
import {
  PERSONAL_DASHBOARD_HTML_MAX_BYTES,
  PersonalDashboardError,
  personalDashboardSafeFilename,
} from '../../managerDashboardDomain';
import { createHash } from 'node:crypto';
import { enqueueDashboardUploadUsage } from '../dashboardUploadUsageOutboxRepo';

export async function getPersonalDashboardHtml(id?: number, preview = false, requestedAudience: PersonalDashboardAudience = 'development') {
  if (id !== undefined) positiveId(id);
  const audience = checkedAudience(requestedAudience);
  await ensureSiteSchema();
  const result = await query<HtmlRow & { html_content: string; active_version_id: string | null }>(`select ${HTML_SELECT}, v.html_content, st.active_version_id::text
    from personal_dashboard_html_versions v cross join personal_dashboard_html_state st
    where st.audience=$3 and v.audience=st.audience and v.id=coalesce($1::bigint,st.active_version_id)
      and ($2::boolean or (v.id=st.active_version_id and v.first_published_at is not null))`, [id ?? null, preview, audience]);
  const row = result.rows[0];
  return row ? { ...mapHtml(row, row.active_version_id), htmlContent: row.html_content } : null;
}

export async function createPersonalDashboardHtml(input: {
  originalName: string; htmlContent: string; fileSize: number; sha256: string; actorId: string; audience?: PersonalDashboardAudience;
  usageActor?: DashboardUploadUsageActor;
}) {
  const audience = checkedAudience(input.audience === undefined ? 'development' : input.audience);
  const size = Buffer.byteLength(input.htmlContent, 'utf8');
  if (size < 1 || size > PERSONAL_DASHBOARD_HTML_MAX_BYTES || size !== input.fileSize
    || createHash('sha256').update(input.htmlContent).digest('hex') !== input.sha256) {
    throw new PersonalDashboardError('HTML_SIZE', 'HTML должен быть непустым файлом размером до 5 МиБ');
  }
  const uploadedBy = actor(input.actorId);
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`kts-personal-dashboard-html:${audience}`]);
    const quota = await client.query<{ count: string; bytes: string }>(`select count(*)::text as count, coalesce(sum(file_size),0)::text as bytes from personal_dashboard_html_versions where audience=$1`, [audience]);
    if (Number(quota.rows[0].count) >= 50 || Number(quota.rows[0].bytes) + size > 100 * 1024 * 1024) {
      throw new PersonalDashboardError('HTML_QUOTA', 'Достигнут лимит HTML: 50 версий или 100 МиБ; история не удалена');
    }
    const result = await client.query<HtmlRow>(`insert into personal_dashboard_html_versions
      (original_name,html_content,file_size,sha256,uploaded_by,audience) values ($1,$2,$3,$4,$5,$6)
      returning id::text, audience, original_name, file_size::text, sha256, created_at::text, uploaded_by, first_published_at::text`,
    [personalDashboardSafeFilename(input.originalName), input.htmlContent, size, input.sha256, uploadedBy, audience]);
    if (input.usageActor) await enqueueDashboardUploadUsage(client, input.usageActor, {
      dashboardKey: `manager:${audience}`, versionId: Number(result.rows[0].id), resourceKey: `personal-html:${audience}:${result.rows[0].id}`,
      name: input.originalName, size, type: 'html',
    });
    return mapHtml(result.rows[0], null);
  });
}

export async function activatePersonalDashboardHtml(input: { versionId: number; expectedActiveVersionId: number | null; actorId: string; audience?: PersonalDashboardAudience }) {
  const audience = checkedAudience(input.audience === undefined ? 'development' : input.audience);
  positiveId(input.versionId);
  if (input.expectedActiveVersionId !== null) positiveId(input.expectedActiveVersionId);
  const publishedBy = actor(input.actorId);
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`kts-personal-dashboard-html:${audience}`]);
    const stateResult = await client.query<HtmlStateRow>(`select active_version_id::text, previous_version_id::text from personal_dashboard_html_state where audience=$1 for update`, [audience]);
    const state = stateResult.rows[0];
    if (!state || idOrNull(state.active_version_id) !== input.expectedActiveVersionId) {
      throw new PersonalDashboardError('STATE_CONFLICT', 'Публикация уже изменилась; обновите страницу');
    }
    const found = await client.query(`select id from personal_dashboard_html_versions where id=$1 and audience=$2`, [input.versionId, audience]);
    if (!found.rowCount) throw new PersonalDashboardError('NOT_FOUND', 'HTML-версия не найдена');
    if (Number(state.active_version_id) !== input.versionId) {
      await client.query(`update personal_dashboard_html_versions set first_published_at=coalesce(first_published_at,now()),
        first_published_by=coalesce(first_published_by,$2) where id=$1 and audience=$3`, [input.versionId, publishedBy, audience]);
      await client.query(`update personal_dashboard_html_state set previous_version_id=active_version_id,
        active_version_id=$1,updated_by=$2,updated_at=now() where audience=$3`, [input.versionId, publishedBy, audience]);
    }
    // Protect the committed pair by pointer, not upload order; unpublished drafts are independent.
    await client.query(`delete from personal_dashboard_html_versions v using personal_dashboard_html_state st
      where st.audience=$1 and v.audience=st.audience and v.first_published_at is not null
        and v.id is distinct from st.active_version_id and v.id is distinct from st.previous_version_id`, [audience]);
    // Deliberately no snapshot mutations: HTML publication/rollback never clears personal data.
    return { audience, activeHtmlVersionId: input.versionId,
      previousHtmlVersionId: Number(state.active_version_id) === input.versionId ? idOrNull(state.previous_version_id) : idOrNull(state.active_version_id) };
  });
}

/** Delete only an inactive HTML version. Publication and personal snapshots are never changed. */
export async function deletePersonalDashboardHtml(input: { versionId: number; actorId: string; audience: PersonalDashboardAudience }) {
  const audience = checkedAudience(input.audience);
  positiveId(input.versionId);
  const deletedBy = actor(input.actorId);
  await ensureSiteSchema();
  return withTransaction(async (client) => {
    // Share the upload/publication lock: a version cannot become active between the check and DELETE.
    await client.query(`select pg_advisory_xact_lock(hashtext($1))`, [`kts-personal-dashboard-html:${audience}`]);
    const stateResult = await client.query<HtmlStateRow>(`select active_version_id::text, previous_version_id::text
      from personal_dashboard_html_state where audience=$1 for update`, [audience]);
    const state = stateResult.rows[0];
    if (!state) throw new PersonalDashboardError('STATE_CONFLICT', 'Состояние публикации изменилось; обновите страницу');
    if (idOrNull(state.active_version_id) === input.versionId) {
      throw new PersonalDashboardError('ACTIVE_VERSION_CONFLICT', 'Нельзя удалить опубликованный HTML. Сначала опубликуйте другую версию этой группы.');
    }
    const found = await client.query(`select id from personal_dashboard_html_versions where id=$1 and audience=$2`, [input.versionId, audience]);
    if (!found.rowCount) throw new PersonalDashboardError('NOT_FOUND', 'HTML-версия не найдена; обновите страницу');
    // Clear only the exact previous pointer before its RESTRICT foreign key is removed.
    // Record the actor without changing the active version, including when deleting a draft.
    await client.query(`update personal_dashboard_html_state
      set previous_version_id=case when previous_version_id=$1 then null else previous_version_id end,
        updated_by=$2,updated_at=now() where audience=$3`, [input.versionId, deletedBy, audience]);
    const deleted = await client.query(`delete from personal_dashboard_html_versions where id=$1 and audience=$2 returning id`, [input.versionId, audience]);
    if (deleted.rowCount !== 1) throw new PersonalDashboardError('STATE_CONFLICT', 'HTML-версия уже изменилась; обновите страницу');
    return { deletedVersionId: input.versionId, audience };
  });
}
