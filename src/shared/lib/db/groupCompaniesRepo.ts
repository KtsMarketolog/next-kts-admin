import type { GroupCompany } from '@/entities/site/model/defaultGroupCompanies';

import { parseRecordRevision, RecordVersionConflictError } from '../recordVersion';
import { query } from './client';
import { ensureSiteSchema } from './schema';

type GroupCompanyRow = {
  id: string | number;
  revision: string;
  image_url: string;
  link_url: string;
  sort_order: number;
  is_active: boolean;
};

function mapGroupCompany(row: GroupCompanyRow): GroupCompany {
  return {
    id: Number(row.id),
    revision: row.revision,
    imageUrl: row.image_url,
    linkUrl: row.link_url,
    sortOrder: row.sort_order,
    isActive: row.is_active,
  };
}

export async function getGroupCompanies({ activeOnly = false } = {}) {
  await ensureSiteSchema();
  const result = await query<GroupCompanyRow>(
    `select id, revision::text, image_url, link_url, sort_order, is_active
     from group_companies
     ${activeOnly ? 'where is_active = true' : ''}
     order by sort_order asc, id asc`,
  );
  return result.rows.map(mapGroupCompany);
}

export async function createGroupCompany(company: Omit<GroupCompany, 'id'>) {
  await ensureSiteSchema();
  const result = await query<{ id: string }>(
    `insert into group_companies (image_url, link_url, sort_order, is_active)
     values ($1, $2, $3, $4)
     returning id`,
    [company.imageUrl, company.linkUrl, company.sortOrder, company.isActive],
  );
  return Number(result.rows[0].id);
}

export async function updateGroupCompany(id: number, company: Partial<Omit<GroupCompany, 'id'>>, expectedRevision: string) {
  const revision = parseRecordRevision(expectedRevision);
  if (!revision) throw new RecordVersionConflictError();
  await ensureSiteSchema();
  const result = await query<GroupCompanyRow>(
    `update group_companies
     set image_url = coalesce($2, image_url),
         link_url = coalesce($3, link_url),
         sort_order = coalesce($4, sort_order),
         is_active = coalesce($5, is_active),
         updated_at = now()
     where id = $1 and revision = $6::bigint
     returning id, revision::text, image_url, link_url, sort_order, is_active`,
    [id, company.imageUrl ?? null, company.linkUrl ?? null, company.sortOrder ?? null, company.isActive ?? null, revision],
  );
  if (!result.rows[0]) throw new RecordVersionConflictError();
  return mapGroupCompany(result.rows[0]);
}

export async function deleteGroupCompany(id: number) {
  await ensureSiteSchema();
  await query(`delete from group_companies where id = $1`, [id]);
}
