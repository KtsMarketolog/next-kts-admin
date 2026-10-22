import assert from 'node:assert/strict';
import test from 'node:test';
import { toDraft, type ClientCompany, type ClientDraft } from '../src/features/admin/clients/AdminClientsModel';
import {
  CLIENT_EDITABLE_FIELDS, buildClientConflict, reconcileClientDrafts, resolveClientConflict,
  type ClientConflictComparison, type ClientEditableField,
} from '../src/features/admin/clients/clientConflict';

const version = (n = 0) => `2026-10-23 10:00:00.00000${n}+00`;
const company = (patch: Partial<ClientCompany> = {}): ClientCompany => ({
  id: 41, title: 'Synthetic client', email: 'synthetic@example.invalid', phone: '', note: '',
  managerId: 5, managerName: 'Synthetic manager', supportManagerId: null, supportManagerName: '',
  requireTwoFactor: false, userCount: 1, clientLogin: 'synthetic@example.invalid', clientUserId: 7,
  passwordChangedAt: '', chatUnreadCount: 0, isActive: true, archivedAt: null,
  createdAt: version(), updatedAt: version(), ...patch,
});

test('local note can be selected without restoring access disabled by another administrator', () => {
  const base = company();
  const local = { ...toDraft(base), note: 'My unsaved comment' };
  const latest = company({ isActive: false, updatedAt: version(1) });
  const comparison = buildClientConflict(base, local, latest);
  assert.deepEqual(comparison.fields.map(field => [field.key, field.localChanged, field.serverChanged]), [
    ['note', true, false], ['isActive', false, true],
  ]);
  assert.deepEqual(comparison.fields.map(field => field.label), ['Заметка', 'Активна']);
  const merged = resolveClientConflict(comparison, ['note', 'isActive']);
  assert.equal(merged.note, local.note); assert.equal(merged.isActive, false, 'unchanged local access cannot overwrite the server even if selected');
  assert.equal(merged.expectedUpdatedAt, version(1)); assert.equal(merged.password, '');
  assert.equal(base.isActive, true); assert.equal(local.expectedUpdatedAt, version());
});

test('same-field changes require a selected local value; unselected and unrelated fields use latest values', () => {
  const base = company({ note: 'Base comment', managerId: null });
  const local = { ...toDraft(base), note: '', managerId: 9, requireTwoFactor: true };
  const latest = company({ note: 'Server comment', managerId: 11, phone: 'Server phone', updatedAt: version(2) });
  const comparison = buildClientConflict(base, local, latest);
  assert.equal(comparison.fields.find(field => field.key === 'note')?.localValue, '');
  assert.equal(comparison.fields.find(field => field.key === 'note')?.serverChanged, true);
  assert.deepEqual(resolveClientConflict(comparison, []), toDraft(latest));
  const chosen = resolveClientConflict(comparison, ['note', 'managerId', 'requireTwoFactor']);
  assert.equal(chosen.note, ''); assert.equal(chosen.managerId, 9); assert.equal(chosen.requireTwoFactor, true);
  assert.equal(chosen.phone, 'Server phone'); assert.equal(chosen.expectedUpdatedAt, latest.updatedAt);
});

test('only differing editable business fields enter comparison; exact string, boolean, numeric and null values are retained', () => {
  const base = company({ note: 'spaces', managerId: 5, supportManagerId: 6 });
  const local = { ...toDraft(base), title: ' Synthetic client ', note: 'spaces ', managerId: null, supportManagerId: 8, isActive: false };
  const latest = company({ note: 'spaces', managerId: 5, supportManagerId: 6, chatUnreadCount: 12, managerName: 'Display name changed', updatedAt: version(1) });
  const comparison = buildClientConflict(base, local, latest);
  assert.deepEqual(comparison.fields.map(field => field.key), ['title', 'note', 'managerId', 'supportManagerId', 'isActive']);
  const resolved = resolveClientConflict(comparison, CLIENT_EDITABLE_FIELDS);
  assert.equal(resolved.title, ' Synthetic client '); assert.equal(resolved.note, 'spaces ');
  assert.equal(resolved.managerId, null); assert.equal(resolved.supportManagerId, 8); assert.equal(resolved.isActive, false);
});

test('comparison does not retain entered or unexpected response credentials and resolution cannot transfer them', () => {
  const base = { ...company(), displayPassword: 'Synthetic hidden password', password_hash: 'Synthetic hash' };
  const latest = { ...company({ updatedAt: version(1) }), passwordCiphertext: 'Synthetic ciphertext', password: 'Synthetic secret' };
  const local = { ...toDraft(base), password: 'Synthetic newly entered secret', note: 'Local note' };
  const comparison = buildClientConflict(base, local, latest);
  assert.doesNotMatch(JSON.stringify(comparison), /Synthetic (?:hidden password|hash|ciphertext|secret|newly entered secret)/);
  assert.equal(comparison.local.password, '');
  const resolved = resolveClientConflict(comparison, ['note']);
  assert.equal(resolved.password, '');
  for (const invalid of ['password', 'expectedUpdatedAt', 'displayPassword', '__proto__']) {
    assert.throws(() => resolveClientConflict(comparison, [invalid as ClientEditableField]), /сопоставить/);
  }
  assert.equal(local.password, 'Synthetic newly entered secret', 'does not erase the callers separately controlled input');
});

test('comparison snapshots cannot change when caller records are subsequently edited', () => {
  const base = company(), local = { ...toDraft(base), note: 'Original local change' }, latest = company({ updatedAt: version(1), isActive: false });
  const comparison = buildClientConflict(base, local, latest);
  base.note = 'Later accidental mutation'; local.note = 'Later typing'; latest.isActive = true;
  const merged = resolveClientConflict(comparison, ['note']);
  assert.equal(merged.note, 'Original local change'); assert.equal(merged.isActive, false);
});

test('unknown baseline, mismatched identities, archived records and malformed latest snapshots fail closed', () => {
  const base = company(), local = { ...toDraft(base), note: 'Local note' }, latest = company({ updatedAt: version(1) });
  const invalidLatest: unknown[] = [null, {}, { ...latest, id: 99 }, { ...latest, id: '41' },
    { ...latest, updatedAt: undefined }, { ...latest, updatedAt: 'not a timestamp' }, { ...latest, updatedAt: '0' },
    { ...latest, archivedAt: version(1) }, { ...latest, archivedAt: undefined },
    { ...latest, note: null }, { ...latest, isActive: 'false' }, { ...latest, managerId: '5' },
    { ...latest, supportManagerId: -1 }, { ...latest, managerId: NaN }, { ...latest, requireTwoFactor: null }];
  for (const invalid of invalidLatest) assert.throws(() => buildClientConflict(base, local, invalid as ClientCompany), /сопоставить/);
  assert.throws(() => buildClientConflict(undefined as unknown as ClientCompany, local, latest), /сопоставить/);
  assert.throws(() => buildClientConflict(base, { ...local, expectedUpdatedAt: undefined }, latest), /сопоставить/);
  assert.throws(() => buildClientConflict(base, { ...local, expectedUpdatedAt: version(2) }, latest), /сопоставить/);
  assert.throws(() => buildClientConflict({ ...base, archivedAt: version() }, local, latest), /сопоставить/);
  const valid = buildClientConflict(base, local, latest);
  assert.throws(() => resolveClientConflict({ ...valid, latest: { ...latest, archivedAt: version(1) } }, ['note']), /сопоставить/);
});

test('resolution revalidates local changes and never trusts supplied comparison flags or field rows', () => {
  const base = company(), local = { ...toDraft(base), note: 'Local' }, latest = company({ isActive: false, updatedAt: version(1) });
  const comparison = buildClientConflict(base, local, latest);
  const fabricated = { ...comparison, fields: [{ key: 'isActive', localValue: true, localChanged: true }] } as ClientConflictComparison;
  assert.equal(resolveClientConflict(fabricated, ['isActive']).isActive, false);
});

test('repeated list refresh retains dirty draft and original baseline/version, updates only clean drafts', () => {
  const base = company(), clean = company({ id: 42, note: 'Clean original' });
  const drafts: Record<number, ClientDraft> = { 41: { ...toDraft(base), note: 'Unsaved local note' }, 42: toDraft(clean) };
  const baselines = new Map([[41, base], [42, clean]]);
  let reconciled = { drafts, baselines };
  for (const n of [1, 2, 3]) {
    reconciled = reconcileClientDrafts(reconciled.drafts, [company({ isActive: false, updatedAt: version(n) }), company({ id: 42, note: `Server ${n}`, updatedAt: version(n) })], reconciled.baselines, {});
    assert.equal(reconciled.drafts[41].note, 'Unsaved local note');
    assert.equal(reconciled.drafts[41].expectedUpdatedAt, version());
    assert.equal(reconciled.baselines.get(41)?.updatedAt, version());
    assert.equal(reconciled.baselines.get(41)?.isActive, true);
    assert.equal(reconciled.drafts[42].note, `Server ${n}`); assert.equal(reconciled.baselines.get(42)?.updatedAt, version(n));
  }
  assert.equal(baselines.get(42)?.note, 'Clean original', 'does not mutate incoming map');
  assert.equal(drafts[42].note, 'Clean original', 'does not mutate incoming draft record');
  const comparison = buildClientConflict(reconciled.baselines.get(41)!, reconciled.drafts[41], company({ isActive: false, updatedAt: version(3) }));
  assert.equal(resolveClientConflict(comparison, ['note']).isActive, false);
});

test('password-only editing freezes version and baseline even when all business fields are clean', () => {
  const base = company(), current = { 41: toDraft(base) }, baselines = new Map([[41, base]]);
  const latest = company({ isActive: false, updatedAt: version(1), passwordChangedAt: version(1) });
  const reconciled = reconcileClientDrafts(current, [latest], baselines, { 41: true });
  assert.equal(reconciled.drafts[41].expectedUpdatedAt, version());
  assert.equal(reconciled.baselines.get(41)?.updatedAt, version());
  assert.equal(reconciled.drafts[41].isActive, true, 'the stale form must still conflict before any new password is saved');
  const resolved = resolveClientConflict(buildClientConflict(base, reconciled.drafts[41], latest), CLIENT_EDITABLE_FIELDS);
  assert.equal(resolved.isActive, false); assert.equal(resolved.password, '');
  const cancelled = reconcileClientDrafts(reconciled.drafts, [latest], reconciled.baselines, { 41: false });
  assert.equal(cancelled.drafts[41].expectedUpdatedAt, version(1));
});

test('hidden drafts and baselines survive scope refresh; an unknown baseline is not silently replaced by latest', () => {
  const base = company(), archived = company({ id: 43, archivedAt: version(1), updatedAt: version(1), isActive: false });
  const unknownDraft = { ...toDraft(company({ id: 44 })), note: 'Unbound draft' };
  const current: Record<number, ClientDraft> = { 41: { ...toDraft(base), note: 'Hidden draft' }, 44: unknownDraft };
  const reconciled = reconcileClientDrafts(current, [archived, company({ id: 44, updatedAt: version(2) })], new Map([[41, base]]), {});
  assert.equal(reconciled.drafts[41], current[41]); assert.equal(reconciled.baselines.get(41), base);
  assert.equal(reconciled.drafts[44], unknownDraft); assert.equal(reconciled.baselines.has(44), false);
  assert.deepEqual(reconciled.drafts[43], toDraft(archived)); assert.equal(reconciled.baselines.get(43)?.archivedAt, version(1));
});

test('a stale expected version or invalid refreshed snapshot cannot silently advance draft baseline', () => {
  const base = company(), current = { 41: { ...toDraft(base), expectedUpdatedAt: version(2) } }, baselines = new Map([[41, base]]);
  const reconciled = reconcileClientDrafts(current, [company({ updatedAt: version(3) })], baselines, {});
  assert.equal(reconciled.drafts[41].expectedUpdatedAt, version(2)); assert.equal(reconciled.baselines.get(41)?.updatedAt, version());
  assert.throws(() => reconcileClientDrafts(current, [company({ updatedAt: '' })], baselines, {}), /неполная карточка/);
  assert.equal(baselines.get(41)?.updatedAt, version());
});
