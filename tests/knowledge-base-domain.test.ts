import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { assertKnowledgeBaseId, assertKnowledgeBaseRevision, assertKnowledgeBaseUuid, canAccessKnowledgeBase, canManageKnowledgeBase,
  knowledgeBaseActorKey, isKnowledgeBaseManagementRole, parseKnowledgeBaseAccess, parseKnowledgeBaseSearch, parseKnowledgeBaseTitle,
  KNOWLEDGE_BASE_MAX_FILE_BYTES } from '../src/shared/lib/knowledgeBase';
import type { AdminSession } from '../src/shared/lib/adminAuth';

test('knowledge base management includes Admin, Admin TOP and TOP, not other delegated dashboard managers', () => {
  for (const role of ['admin', 'admintop', 'top', 'wholesale_admin', 'purchaser', 'manager', 'support_manager'] as const) {
    const session: AdminSession = { role, adminUserId: 1, managerId: 2, sessionId: randomUUID(), canManageTopDashboard: true };
    assert.equal(canAccessKnowledgeBase(session), true);
    const manages = role === 'admin' || role === 'admintop' || role === 'top';
    assert.equal(canManageKnowledgeBase(session), manages);
    assert.equal(isKnowledgeBaseManagementRole(role), manages);
    assert.equal(knowledgeBaseActorKey(session), role === 'manager' || role === 'support_manager' ? 'manager:2' : 'admin:1');
  }
  assert.equal(canAccessKnowledgeBase({ role: 'top', sessionId: randomUUID() }), false);
  assert.equal(canManageKnowledgeBase({ role: 'top', sessionId: randomUUID() }), false);
  assert.equal(canManageKnowledgeBase({ role: 'top', adminUserId: 1 }), false);
  assert.equal(canManageKnowledgeBase({ role: 'top', adminUserId: 1, sessionId: randomUUID(), canManageTopDashboard: false }), true);
  assert.equal(isKnowledgeBaseManagementRole('unknown'), false);
  assert.equal(canManageKnowledgeBase({ role: 'admin' }), false);
  assert.equal(knowledgeBaseActorKey({ role: 'admin', sessionId: randomUUID() }), 'admin:primary');
});
test('root starts private; child defaults to inheritance; grants canonicalized without broadening', () => {
  assert.deepEqual(parseKnowledgeBaseAccess(undefined, true), { mode: 'custom', actorKeys: [] });
  assert.deepEqual(parseKnowledgeBaseAccess(undefined), { mode: 'inherit', actorKeys: [] });
  assert.deepEqual(parseKnowledgeBaseAccess({ mode: 'custom', actorKeys: ['manager:3', 'admin:9'] }), { mode: 'custom', actorKeys: ['admin:9', 'manager:3'] });
  for (const value of [null, [], { mode: 'custom' }, { mode: 'inherit', actorKeys: ['admin:1'] }, { mode: 'custom', actorKeys: ['admin:primary'] },
    { mode: 'custom', actorKeys: ['admin:1', 'admin:1'] }, { mode: 'custom', actorKeys: ['manager:0'] }, { mode: 'custom', actorKeys: [], unknown: true }]) {
    assert.throws(() => parseKnowledgeBaseAccess(value));
  }
  assert.throws(() => parseKnowledgeBaseAccess({ mode: 'inherit', actorKeys: [] }, true));
  assert.throws(() => parseKnowledgeBaseAccess({ mode: 'custom', actorKeys: Array.from({ length: 1001 }, (_, i) => `admin:${i + 1}`) }));
});
test('knowledge base bounded scalar validators reject ambiguous or oversized input', () => {
  assert.equal(KNOWLEDGE_BASE_MAX_FILE_BYTES, 25 * 1024 * 1024);
  assert.equal(parseKnowledgeBaseTitle(' Title '), 'Title');
  assert.equal(parseKnowledgeBaseSearch(' %_ '), '%_');
  assertKnowledgeBaseId(1); assertKnowledgeBaseRevision('9223372036854775807'); assertKnowledgeBaseUuid(randomUUID());
  for (const id of [0, -1, 0.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => assertKnowledgeBaseId(id));
  for (const revision of [1, '', '01', '0', '-1', '9223372036854775808']) assert.throws(() => assertKnowledgeBaseRevision(revision));
  for (const title of ['', '  ', 'x'.repeat(201), 'a\nb', '\0', 1]) assert.throws(() => parseKnowledgeBaseTitle(title));
  for (const search of ['x'.repeat(101), '\n', 2]) assert.throws(() => parseKnowledgeBaseSearch(search));
  for (const id of ['', 'x', '00000000-0000-0000-0000-000000000000', 1]) assert.throws(() => assertKnowledgeBaseUuid(id));
});
