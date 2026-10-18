import type { PoolClient } from 'pg';

/** Additive only: existing customers, documents, requests and prices stay untouched. */
export async function applyClientArchiveMigration(client: PoolClient) {
  await client.query(`
    alter table client_companies add column archived_at timestamptz;
    alter table client_companies add constraint client_company_archive_inactive
      check (archived_at is null or is_active = false);
    create index client_companies_archived_idx on client_companies(archived_at, title);

    -- No cascading FK: an explicit file-cleanup receipt must survive its source row.
    create table client_document_file_cleanup (
      id bigserial primary key,
      document_id bigint not null,
      company_id bigint not null,
      file_path text not null,
      created_at timestamptz not null default now(),
      attempts integer not null default 0 check (attempts >= 0),
      last_error text,
      completed_at timestamptz
    );
    create index client_document_file_cleanup_pending_idx
      on client_document_file_cleanup(id) where completed_at is null;
  `);
}
