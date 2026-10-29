import type { PoolClient } from 'pg';

/** No existing material is removed: only explicit, subsequently confirmed archive deletions use these fields. */
export async function applyKnowledgeBaseDeletionMigration(client: PoolClient) {
  await client.query(`
    alter table knowledge_base_nodes add column deleted_at timestamptz;
    alter table knowledge_base_nodes add column deleted_by text;
    alter table knowledge_base_nodes add constraint knowledge_base_deleted_actor_check
      check ((deleted_at is null and deleted_by is null) or (deleted_at is not null and deleted_by is not null));
    create index knowledge_base_nodes_live_parent_idx on knowledge_base_nodes(parent_id,id) where deleted_at is null;
    create function knowledge_base_protect_deleted_node() returns trigger language plpgsql as $$
    begin
      if old.deleted_at is not null and new is distinct from old then
        raise exception 'Deleted knowledge base material is immutable' using errcode='23514';
      end if;
      return new;
    end $$;
    create trigger knowledge_base_protect_deleted_node before update on knowledge_base_nodes
      for each row execute function knowledge_base_protect_deleted_node();
    create table knowledge_base_deletions (
      id bigserial primary key,
      actor_key text not null, actor_role text not null,
      operation_id uuid not null, operation_digest text not null check(operation_digest ~ '^[0-9a-f]{64}$'),
      node_id bigint not null references knowledge_base_nodes(id) on delete restrict,
      title text not null, affected_count integer not null check(affected_count > 0),
      file_count integer not null check(file_count >= 0), folder_count integer not null check(folder_count >= 0),
      total_bytes bigint not null check(total_bytes >= 0), created_at timestamptz not null default now(),
      unique(actor_key,operation_id), check(affected_count=file_count+folder_count)
    );
    create table knowledge_base_file_deletions (
      node_id bigint primary key references knowledge_base_nodes(id) on delete restrict,
      deletion_id bigint not null references knowledge_base_deletions(id) on delete restrict,
      storage_path text not null, file_size bigint not null check(file_size between 1 and 26214400),
      sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
      attempts integer not null default 0 check(attempts>=0),
      next_attempt_at timestamptz not null default now(), completed_at timestamptz,
      failed_at timestamptz, last_error text,
      created_at timestamptz not null default now()
    );
    create index knowledge_base_file_deletions_due_idx on knowledge_base_file_deletions(next_attempt_at,node_id)
      where completed_at is null and failed_at is null;
    create index knowledge_base_file_deletions_operation_idx on knowledge_base_file_deletions(deletion_id);
  `);
}
