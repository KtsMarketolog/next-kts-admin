import type { GroupCompany } from '@/entities/site/model/defaultGroupCompanies';

import { query } from './client';
import { ensureSiteSchema } from './schema';

type GroupCompanyRow = {
  id: string | number;
  image_url: string;
  sort_order: number;
  is_active: boolean;
};

function mapGroupCompany(row: GroupCompanyRow): GroupCompany {
  return {
    id: Number(row.id),
    imageUrl: row.image_url,
    sortOrder: row.sort_order,
    isActive: row.is_active,
  };
}

export async function getGroupCompanies({ activeOnly = false } = {}) {
  await ensureSiteSchema();
  const result = await query<GroupCompanyRow>(
    `select id, image_url, sort_order, is_active
     from group_companies
     ${activeOnly ? 'where is_active = true' : ''}
     order by sort_order asc, id asc`,
  );
  return result.rows.map(mapGroupCompany);
}

export async function createGroupCompany(company: Omit<GroupCompany, 'id'>) {
  await ensureSiteSchema();
  const result = await query<{ id: string }>(
    `insert into group_companies (image_url, sort_order, is_active)
     values ($1, $2, $3)
     returning id`,
    [company.imageUrl, company.sortOrder, company.isActive],
  );
  return Number(result.rows[0].id);
}

export async function updateGroupCompany(id: number, company: Partial<Omit<GroupCompany, 'id'>>) {
  await ensureSiteSchema();
  await query(
    `update group_companies
     set image_url = coalesce($2, image_url),
         sort_order = coalesce($3, sort_order),
         is_active = coalesce($4, is_active),
         updated_at = now()
     where id = $1`,
    [id, company.imageUrl ?? null, company.sortOrder ?? null, company.isActive ?? null],
  );
}

export async function deleteGroupCompany(id: number) {
  await ensureSiteSchema();
  await query(`delete from group_companies where id = $1`, [id]);
}
