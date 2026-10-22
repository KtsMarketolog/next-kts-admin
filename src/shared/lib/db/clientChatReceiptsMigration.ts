import type { PoolClient } from 'pg';

/** Additive only: retain all correspondence and existing legacy read markers.
 * New acknowledgements refer to exact messages rather than a company-wide time. */
export async function applyClientChatReceiptsMigration(client: PoolClient) {
  await client.query(`
    alter table client_chat_messages add column read_by_other_at timestamptz;
    create index client_chat_messages_unread_idx
      on client_chat_messages(company_id, author_type, created_at, id)
      where read_by_other_at is null;
  `);
}
