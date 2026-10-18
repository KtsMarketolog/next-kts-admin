import assert from 'node:assert/strict';
import { query } from '../../src/shared/lib/db/client';
import { updateAccessUser } from '../../src/shared/lib/db/adminUsersRepo';
import { updateWholesaleManager } from '../../src/shared/lib/db/wholesaleAdminRepo/managerRepo';

// Existing non-concurrency acceptance scenarios represent a freshly opened form.
// Concurrency tests must call the repositories directly with a captured revision.
export async function currentAccessUserRevision(id: string): Promise<string> {
  const match = /^(admin|manager):([1-9]\d*)$/.exec(id);
  assert.ok(match, 'A synthetic persisted identity is required');
  const table = match[1] === 'admin' ? 'admin_users' : 'wholesale_managers';
  const result = await query<{ revision: string }>(`select revision::text from ${table} where id=$1`, [match[2]]);
  assert.ok(result.rows[0], 'The synthetic fixture must still exist');
  return result.rows[0].revision;
}

export async function updateCurrentAccessUser(...args: Parameters<typeof updateAccessUser>) {
  const [id, input, currentAdminUserId, actorRole] = args;
  return updateAccessUser(id, {
    ...input,
    expectedRevision: input.expectedRevision ?? await currentAccessUserRevision(id),
  }, currentAdminUserId, actorRole);
}

export async function updateCurrentWholesaleManager(...args: Parameters<typeof updateWholesaleManager>) {
  const [id, input] = args;
  return updateWholesaleManager(id, {
    ...input,
    expectedRevision: input.expectedRevision ?? await currentAccessUserRevision(`manager:${id}`),
  });
}
