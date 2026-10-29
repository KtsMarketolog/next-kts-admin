import type { PoolClient } from 'pg';

const ROOT_ACCESS_CONSTRAINT = 'knowledge_base_nodes_root_access_check';
// pg_get_expr uses this parenthesized form. Do not strip parentheses: a
// differently grouped AND/OR check is not the same security invariant.
const normalizeExpression = (value: string) => value.replace(/\s/g, '').toLowerCase();
const LEGACY_ROOT_RULE = normalizeExpression("((parent_id IS NOT NULL) OR ((kind = 'folder'::text) AND (acl_mode = 'custom'::text)))");
const ROOT_ACCESS_RULE = normalizeExpression("((parent_id IS NOT NULL) OR (acl_mode = 'custom'::text))");

/** Only relax the reviewed root-kind rule; existing nodes, grants and bytes stay untouched. */
export async function applyKnowledgeBaseRootFilesMigration(client: PoolClient) {
  const { rows } = await client.query<{ name: string; expression: string; validated: boolean }>(`
    select conname as name,pg_get_expr(conbin,conrelid) as expression,convalidated as validated
    from pg_constraint where conrelid='knowledge_base_nodes'::regclass and contype='c'
  `);
  // The initial migration used an unnamed CHECK. Locate its exact expression,
  // not its PostgreSQL-generated name, so no unrelated invariant is removed.
  const oldRules = rows.filter(row => normalizeExpression(row.expression) === LEGACY_ROOT_RULE);
  const newRule = rows.find(row => row.name === ROOT_ACCESS_CONSTRAINT);
  if (oldRules.length > 1 || (oldRules.length === 0 && !newRule)
    || (newRule && normalizeExpression(newRule.expression) !== ROOT_ACCESS_RULE)) {
    throw new Error('Unexpected knowledge base root constraint; migration stopped');
  }
  if (!newRule) {
    await client.query(`alter table knowledge_base_nodes add constraint ${ROOT_ACCESS_CONSTRAINT}
      check (parent_id is not null or acl_mode='custom')`);
  } else if (!newRule.validated) {
    await client.query(`alter table knowledge_base_nodes validate constraint ${ROOT_ACCESS_CONSTRAINT}`);
  }
  for (const oldRule of oldRules) {
    const identifier = '"' + oldRule.name.replace(/"/g, '""') + '"';
    await client.query(`alter table knowledge_base_nodes drop constraint ${identifier}`);
  }
}
