import type { PoolClient } from 'pg';

/** Additive: existing accounts, reports, prices and uploaded documents are untouched. */
export async function applyKnowledgeBaseMigration(client: PoolClient) {
  await client.query(`
    create table knowledge_base_nodes (
      id bigserial primary key,
      parent_id bigint references knowledge_base_nodes(id) on delete restrict,
      kind text not null check (kind in ('folder','file')),
      title text not null check (char_length(title) between 1 and 200),
      revision bigint not null default 1 check (revision > 0),
      acl_mode text not null check (acl_mode in ('inherit','custom')),
      original_name text, mime_type text, file_size bigint, storage_path text, sha256 text,
      created_by text not null, operation_id uuid not null, operation_digest text not null,
      archived_at timestamptz,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      unique(created_by,operation_id),
      check (parent_id is not null or (kind='folder' and acl_mode='custom')),
      check (parent_id is null or parent_id <> id),
      check (operation_digest ~ '^[0-9a-f]{64}$'),
      check ((kind='folder' and original_name is null and mime_type is null and file_size is null and storage_path is null and sha256 is null)
        or (kind='file' and original_name is not null and char_length(original_name) between 1 and 255
          and mime_type is not null and char_length(mime_type) between 1 and 160
          and file_size is not null and file_size between 1 and 26214400
          and storage_path is not null and char_length(storage_path) between 1 and 1000
          and sha256 is not null and sha256 ~ '^[0-9a-f]{64}$'))
    );
    create index knowledge_base_nodes_parent_idx on knowledge_base_nodes(parent_id,id);
    create table knowledge_base_grants (
      node_id bigint not null references knowledge_base_nodes(id) on delete restrict,
      actor_key text not null check (actor_key ~ '^(admin|manager):[1-9][0-9]{0,14}$'),
      primary key(node_id,actor_key)
    );
    create index knowledge_base_grants_actor_idx on knowledge_base_grants(actor_key,node_id);
    create table knowledge_base_events (
      id bigserial primary key, actor_key text not null, actor_role text not null,
      event_id uuid not null, node_id bigint references knowledge_base_nodes(id) on delete restrict,
      action text not null check (action in ('section_open','folder_open','file_view','download_started')),
      created_at timestamptz not null default now(),
      unique(actor_key,event_id),
      check (actor_key ~ '^(admin:([1-9][0-9]{0,14}|primary)|manager:[1-9][0-9]{0,14})$'),
      check ((action='section_open' and node_id is null) or (action<>'section_open' and node_id is not null))
    );
    create index knowledge_base_events_actor_idx on knowledge_base_events(actor_key,created_at desc);
    create index knowledge_base_events_node_idx on knowledge_base_events(node_id,created_at desc);
  `);
}
