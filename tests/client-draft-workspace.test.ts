import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { toDraft, type ClientCompany } from '../src/features/admin/clients/AdminClientsModel';
import {
  discardClientDraftWorkspace, emptyClientDraftWorkspace, getClientDraftScope, hasClientDraftWorkspaceChanges,
  openClientDraftWorkspace, subscribeClientDraftWorkspace,
  type ClientDraftWorkspaceSnapshot,
} from '../src/features/admin/clients/clientDraftWorkspace';

const version = '2026-10-23 00:00:00.000001+00';
const company = (): ClientCompany => ({
  id: 41, title: 'Synthetic client', email: 'synthetic@example.invalid', phone: '', note: 'Original note',
  managerId: 5, managerName: 'Synthetic manager', supportManagerId: null, supportManagerName: '',
  requireTwoFactor: false, userCount: 1, clientLogin: 'synthetic@example.invalid', clientUserId: 7,
  passwordChangedAt: '', chatUnreadCount: 0, isActive: true, archivedAt: null, createdAt: version, updatedAt: version,
});
const draftSnapshot = (): ClientDraftWorkspaceSnapshot => {
  const baseline = company();
  return {
    creation: { ...emptyClientDraftWorkspace().creation, title: 'New company' },
    drafts: { 41: { ...toDraft(baseline), note: 'Unsaved note' } },
    baselines: new Map([[41, baseline]]), expanded: { 41: true }, scope: 'archived',
  };
};
let previousWindow: PropertyDescriptor | undefined;
beforeEach(() => {
  previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const fakeWindow = Object.defineProperties({}, {
    localStorage: { get() { throw new Error('Must never access localStorage'); } },
    sessionStorage: { get() { throw new Error('Must never access sessionStorage'); } },
    indexedDB: { get() { throw new Error('Must never access indexedDB'); } },
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  discardClientDraftWorkspace();
});
afterEach(() => {
  discardClientDraftWorkspace();
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

test('session-scoped workspace restores business drafts, exact CAS and frozen baselines between section mounts', () => {
  const session = { role: 'admin' as const, adminUserId: 3, sessionId: 'synthetic-session' };
  const scope = getClientDraftScope(session);
  const workspace = openClientDraftWorkspace(scope);
  assert.deepEqual(workspace.snapshot, emptyClientDraftWorkspace());
  const changed = draftSnapshot();
  workspace.save(changed);
  const restored = openClientDraftWorkspace(scope).snapshot;
  assert.deepEqual(restored, changed);
  assert.equal(restored.drafts[41].expectedUpdatedAt, version);
  assert.equal(restored.baselines.get(41)?.updatedAt, version);
  assert.equal(restored.baselines.get(41)?.note, 'Original note');
  assert.equal(restored.drafts[41].note, 'Unsaved note');
});

test('all snapshots use allowlisted primitives, excluding entered and unexpected nested credentials', () => {
  const original = draftSnapshot();
  const secret = 'SYNTHETIC_SECRET_NOT_TO_PERSIST';
  original.creation.password = secret;
  original.drafts[41].password = secret;
  Object.assign(original, { passwordDrafts: { 41: secret }, private: { password: secret } });
  Object.assign(original.creation, { nested: { password: secret }, passwordCiphertext: secret });
  Object.assign(original.drafts[41], { private: { password: secret }, passwordHash: secret });
  Object.assign(original.baselines.get(41)!, { password: secret, display_password: secret, private: { password: secret } });
  const handle = openClientDraftWorkspace('scope');
  handle.save(original);
  const restored = openClientDraftWorkspace('scope').snapshot;
  assert.equal(restored.creation.password, '');
  assert.equal(restored.drafts[41].password, '');
  assert.doesNotMatch(JSON.stringify({ ...restored, baselines: [...restored.baselines] }), /SYNTHETIC_SECRET|nested|private|passwordHash|passwordCiphertext|passwordDrafts|display_password/);
  assert.equal(original.creation.password, secret, 'sanitization does not mutate the currently mounted password input');
  assert.equal(original.drafts[41].password, secret);
});

test('unexpected objects inside allowed scalar fields cannot retain nested secrets', () => {
  const original = draftSnapshot();
  const secret = { password: 'SYNTHETIC_NESTED_SECRET' };
  Object.assign(original.creation, { note: secret, managerId: secret, expectedUpdatedAt: secret });
  Object.assign(original.drafts[41], { phone: secret, supportManagerId: secret });
  Object.assign(original.baselines.get(41)!, { email: secret, managerName: secret, archivedAt: secret });
  openClientDraftWorkspace('scope').save(original);
  const restored = openClientDraftWorkspace('scope').snapshot;
  assert.equal(restored.creation.note, ''); assert.equal(restored.creation.managerId, null);
  assert.equal(restored.creation.expectedUpdatedAt, undefined);
  assert.doesNotMatch(JSON.stringify({ ...restored, baselines: [...restored.baselines] }), /SYNTHETIC_NESTED_SECRET/);
});

test('saved and opened snapshots are detached from caller objects, maps and returned clones', () => {
  const original = draftSnapshot();
  const handle = openClientDraftWorkspace('scope');
  handle.save(original);
  original.creation.title = 'Later mutation'; original.drafts[41].note = 'Later mutation';
  original.baselines.get(41)!.isActive = false; original.expanded[41] = false;
  const restored = openClientDraftWorkspace('scope').snapshot;
  assert.equal(restored.creation.title, 'New company'); assert.equal(restored.drafts[41].note, 'Unsaved note');
  assert.equal(restored.baselines.get(41)?.isActive, true); assert.equal(restored.expanded[41], true);
  restored.creation.title = 'Mutated read'; restored.drafts[41].note = 'Mutated read';
  restored.baselines.clear(); delete restored.expanded[41];
  assert.deepEqual(openClientDraftWorkspace('scope').snapshot, draftSnapshot());
});

test('same-scope opens preserve valid handles for StrictMode and section remounts', () => {
  const first = openClientDraftWorkspace('scope');
  const second = openClientDraftWorkspace('scope');
  first.save(draftSnapshot());
  assert.deepEqual(openClientDraftWorkspace('scope').snapshot, draftSnapshot());
  second.save(emptyClientDraftWorkspace());
  assert.deepEqual(openClientDraftWorkspace('scope').snapshot, emptyClientDraftWorkspace());
});

test('saved or deleted drafts do not reappear after replacing a workspace with its acknowledged state', () => {
  const handle = openClientDraftWorkspace('scope');
  handle.save(draftSnapshot());
  const acknowledged = draftSnapshot();
  acknowledged.drafts[41] = toDraft(acknowledged.baselines.get(41)!);
  acknowledged.creation = emptyClientDraftWorkspace().creation;
  handle.save(acknowledged);
  assert.equal(openClientDraftWorkspace('scope').snapshot.drafts[41].note, 'Original note');
  delete acknowledged.drafts[41]; acknowledged.baselines.delete(41); delete acknowledged.expanded[41];
  handle.save(acknowledged);
  assert.deepEqual(openClientDraftWorkspace('scope').snapshot.drafts, {});
  assert.equal(openClientDraftWorkspace('scope').snapshot.baselines.size, 0);
});

test('actor switch discards the previous workspace and invalidates all previous write handles', () => {
  const first = openClientDraftWorkspace('first-actor');
  first.save(draftSnapshot());
  const second = openClientDraftWorkspace('second-actor');
  assert.deepEqual(second.snapshot, emptyClientDraftWorkspace());
  first.save(draftSnapshot());
  assert.deepEqual(openClientDraftWorkspace('second-actor').snapshot, emptyClientDraftWorkspace());
  assert.deepEqual(openClientDraftWorkspace('first-actor').snapshot, emptyClientDraftWorkspace());
  second.save(draftSnapshot());
  first.save(draftSnapshot());
  assert.deepEqual(openClientDraftWorkspace('first-actor').snapshot, emptyClientDraftWorkspace(), 'old handle stays invalid even if its scope later returns');
});

test('logout invalidates in-flight writes, including when the same scope is reopened', () => {
  const old = openClientDraftWorkspace('scope');
  old.save(draftSnapshot());
  discardClientDraftWorkspace('scope');
  const current = openClientDraftWorkspace('scope');
  old.save(draftSnapshot());
  assert.deepEqual(current.snapshot, emptyClientDraftWorkspace());
  assert.deepEqual(openClientDraftWorkspace('scope').snapshot, emptyClientDraftWorkspace());
  current.save(draftSnapshot());
  discardClientDraftWorkspace();
  current.save(draftSnapshot());
  assert.deepEqual(openClientDraftWorkspace('scope').snapshot, emptyClientDraftWorkspace());
});

test('discarding an old actor does not clear the current actor workspace', () => {
  openClientDraftWorkspace('first-actor').save(draftSnapshot());
  openClientDraftWorkspace('second-actor').save(draftSnapshot());
  discardClientDraftWorkspace('first-actor');
  assert.deepEqual(openClientDraftWorkspace('second-actor').snapshot, draftSnapshot());
});

test('undefined identity has no persistence and invalidates authenticated cached drafts', () => {
  const previous = openClientDraftWorkspace('scope'); previous.save(draftSnapshot());
  const anonymous = openClientDraftWorkspace(undefined);
  anonymous.save(draftSnapshot()); previous.save(draftSnapshot());
  assert.deepEqual(openClientDraftWorkspace(undefined).snapshot, emptyClientDraftWorkspace());
  assert.deepEqual(openClientDraftWorkspace('scope').snapshot, emptyClientDraftWorkspace());
});

test('server rendering cannot store or restore drafts between requests', () => {
  Reflect.deleteProperty(globalThis, 'window');
  openClientDraftWorkspace('same-session').save(draftSnapshot());
  assert.deepEqual(openClientDraftWorkspace('same-session').snapshot, emptyClientDraftWorkspace());
  assert.deepEqual(openClientDraftWorkspace('other-session').snapshot, emptyClientDraftWorkspace());
});

test('scope includes session, role and actor identity; legacy admin still requires a unique session', () => {
  const base = { role: 'admin' as const, adminUserId: 3, sessionId: 'synthetic-session' };
  const scopes = [getClientDraftScope(base), getClientDraftScope({ ...base, sessionId: 'new-session' }),
    getClientDraftScope({ ...base, adminUserId: 4 }), getClientDraftScope({ ...base, role: 'wholesale_admin' }),
    getClientDraftScope({ role: 'manager', managerId: 3, sessionId: base.sessionId }),
    getClientDraftScope({ role: 'support_manager', managerId: 3, sessionId: base.sessionId }),
    getClientDraftScope({ role: 'admin', sessionId: base.sessionId })];
  assert.equal(scopes.some(scope => !scope), false); assert.equal(new Set(scopes).size, scopes.length);
  assert.equal(getClientDraftScope(null), undefined); assert.equal(getClientDraftScope(undefined), undefined);
  for (const role of ['admin', 'wholesale_admin', 'manager', 'support_manager'] as const) {
    assert.equal(getClientDraftScope({ role }), undefined);
    assert.equal(getClientDraftScope({ role, sessionId: ' ' }), undefined);
  }
  assert.equal(getClientDraftScope({ role: 'wholesale_admin', sessionId: 's' }), undefined);
  assert.equal(getClientDraftScope({ role: 'manager', sessionId: 's' }), undefined);
  for (const id of [0, -1, NaN, 1.5, Infinity]) {
    assert.equal(getClientDraftScope({ ...base, adminUserId: id }), undefined);
    assert.equal(getClientDraftScope({ role: 'manager', managerId: id, sessionId: 's' }), undefined);
  }
  for (const role of ['top', 'admintop', 'purchaser'] as const) {
    assert.equal(getClientDraftScope({ role, adminUserId: 3, sessionId: 's' }), undefined);
  }
});

test('invalid record keys and mismatched baseline IDs cannot alias another company', () => {
  const original = draftSnapshot();
  Object.assign(original.drafts, { '041': toDraft(company()), '-1': toDraft(company()), notAnId: toDraft(company()) });
  Object.assign(original.expanded, { '041': true, '-1': true, notAnId: true });
  original.baselines.set(42, company());
  openClientDraftWorkspace('scope').save(original);
  const restored = openClientDraftWorkspace('scope').snapshot;
  assert.deepEqual(Object.keys(restored.drafts), ['41']); assert.deepEqual(Object.keys(restored.expanded), ['41']);
  assert.deepEqual([...restored.baselines.keys()], [41]);
});

test('workspace subscriptions report dirty transitions only, allowing repeated layout saves without loops', t => {
  const states: boolean[] = [];
  const unsubscribe = subscribeClientDraftWorkspace(() => states.push(hasClientDraftWorkspaceChanges('scope')));
  t.after(unsubscribe);
  const handle = openClientDraftWorkspace('scope');
  assert.deepEqual(states, [false], 'opening the owner publishes its clean state');
  handle.save(emptyClientDraftWorkspace());
  handle.save(draftSnapshot());
  handle.save(draftSnapshot());
  const changedAgain = draftSnapshot(); changedAgain.drafts[41].note = 'Another unsaved value';
  handle.save(changedAgain);
  assert.deepEqual(states, [false, true]);
  assert.equal(hasClientDraftWorkspaceChanges('scope'), true);
  assert.equal(hasClientDraftWorkspaceChanges('other-scope'), false);
  assert.equal(hasClientDraftWorkspaceChanges(undefined), false);
  handle.save(emptyClientDraftWorkspace());
  assert.deepEqual(states, [false, true, false]);
  unsubscribe();
  handle.save(draftSnapshot());
  assert.deepEqual(states, [false, true, false], 'unsubscribed listeners do not receive later transitions');
});

test('workspace dirty state considers business fields, not passwords, revisions or UI state', () => {
  const handle = openClientDraftWorkspace('scope');
  const clean = emptyClientDraftWorkspace();
  clean.creation.password = 'SYNTHETIC_PASSWORD';
  clean.creation.expectedUpdatedAt = version;
  clean.scope = 'archived'; clean.expanded[41] = true;
  const baseline = company();
  clean.baselines.set(41, baseline);
  clean.drafts[41] = { ...toDraft(baseline), password: 'SYNTHETIC_PASSWORD', expectedUpdatedAt: 'another token' };
  handle.save(clean);
  assert.equal(hasClientDraftWorkspaceChanges('scope'), false);
  clean.drafts[41].isActive = false;
  handle.save(clean);
  assert.equal(hasClientDraftWorkspaceChanges('scope'), true);
  clean.baselines.get(41)!.isActive = false;
  handle.save(clean);
  assert.equal(hasClientDraftWorkspaceChanges('scope'), false, 'an acknowledged business value clears dirty state');
  clean.creation.requireTwoFactor = true;
  handle.save(clean);
  assert.equal(hasClientDraftWorkspaceChanges('scope'), true);
  clean.creation.requireTwoFactor = false;
  clean.baselines.delete(41);
  handle.save(clean);
  assert.equal(hasClientDraftWorkspaceChanges('scope'), true, 'a draft with no known baseline is not assumed clean');
});

test('owner switches and logout notify subscribers while stale callbacks cannot restore dirty state', t => {
  let notifications = 0;
  const unsubscribe = subscribeClientDraftWorkspace(() => { notifications++; });
  t.after(unsubscribe);
  const first = openClientDraftWorkspace('first');
  first.save(draftSnapshot());
  assert.equal(notifications, 2);
  const second = openClientDraftWorkspace('second');
  assert.equal(notifications, 3);
  assert.equal(hasClientDraftWorkspaceChanges('first'), false);
  first.save(draftSnapshot());
  discardClientDraftWorkspace('first');
  assert.equal(notifications, 3);
  second.save(draftSnapshot());
  assert.equal(hasClientDraftWorkspaceChanges('second'), true);
  discardClientDraftWorkspace('second');
  assert.equal(notifications, 5);
  assert.equal(hasClientDraftWorkspaceChanges('second'), false);
  second.save(draftSnapshot());
  discardClientDraftWorkspace();
  assert.equal(notifications, 5);
  openClientDraftWorkspace('third');
  openClientDraftWorkspace(undefined);
  assert.equal(notifications, 7);
  openClientDraftWorkspace(undefined);
  assert.equal(notifications, 7, 'already empty anonymous opens do not notify repeatedly');
});

test('server subscriptions and snapshots do not share browser draft notifications', () => {
  Reflect.deleteProperty(globalThis, 'window');
  let notifications = 0;
  const unsubscribe = subscribeClientDraftWorkspace(() => { notifications++; });
  openClientDraftWorkspace('scope').save(draftSnapshot());
  assert.equal(hasClientDraftWorkspaceChanges('scope'), false);
  assert.equal(notifications, 0);
  unsubscribe();
});
