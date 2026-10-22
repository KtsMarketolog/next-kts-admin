import { query } from '../../client';

export function readActiveClientCompany(id: number) {
  return query<{ id: string; title: string; }>(
    `select id::text, title
     from client_companies
     where id = $1 and is_active = true and archived_at is null
     limit 1`,
    [id],
  );
}
