import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { archiveClientConfirmation, clientMatchesScope, mergeClientDrafts, readClientDeletionPreview, toDraft, type ClientCompany } from '../src/features/admin/clients/AdminClientsModel';

const company = (id: number, archivedAt: string | null = null): ClientCompany => ({
  id, title: `Synthetic ${id}`, email: `${id}@example.invalid`, phone: '', note: '',
  managerId: null, managerName: '', supportManagerId: null, supportManagerName: '',
  requireTwoFactor: false, userCount: 1, clientLogin: `${id}@example.invalid`, clientUserId: id,
  passwordChangedAt: '', displayPassword: '', chatUnreadCount: 0, isActive: !archivedAt,
  archivedAt, createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z',
});

test('archive confirmation spells out retained data, access closure and public-link exception', () => {
  const text = archiveClientConfirmation(company(1));
  for (const fragment of ['сессии завершены', 'пользователи и пароли', 'переписка', 'документы', 'заявки', 'привязки прайсов и файлы сохранятся', 'НЕ отключаются', 'ручного удаления администратором', 'Несохранённые правки']) assert.ok(text.includes(fragment), fragment);
  assert.doesNotMatch(text, /будут удалены/);
});

test('active scope includes disabled clients but never archived clients', () => {
  assert.equal(clientMatchesScope({ ...company(1), isActive: false }, 'active'), true);
  assert.equal(clientMatchesScope(company(2, '2026-10-18T00:00:00Z'), 'active'), false);
  assert.equal(clientMatchesScope(company(2, '2026-10-18T00:00:00Z'), 'archived'), true);
});

test('switching scopes preserves hidden and changed drafts, clean forms refresh', () => {
  const first = company(1), second = company(2), archived = company(3, '2026-10-18T00:00:00Z');
  const baseline = new Map([[1, first], [2, second]]);
  const drafts = { 1: { ...toDraft(first), note: 'unsaved' }, 2: toDraft(second) };
  const archiveDrafts = mergeClientDrafts(drafts, [archived], baseline);
  assert.equal(archiveDrafts[1].note, 'unsaved');
  baseline.set(3, archived);
  const restored = mergeClientDrafts(archiveDrafts, [{ ...first, note: 'server change' }, { ...second, note: 'new clean value' }], baseline);
  assert.equal(restored[1].note, 'unsaved');
  assert.equal(restored[2].note, 'new clean value');
  assert.deepEqual(restored[3], toDraft(archived));
  assert.equal(drafts[2].note, '', 'input remains untouched');
});

test('archive UI guards mutations and uses optimistic archive/restore version', () => {
  const source = readFileSync('src/features/admin/clients/AdminClientsSection.tsx', 'utf8');
  assert.equal((source.match(/expectedUpdatedAt: company\.updatedAt/g) ?? []).length, 2);
  assert.match(source, /sequence !== loadSequence\.current/);
  assert.match(source, /scope !== scopeRef\.current/);
  const detail = readFileSync('src/features/admin/clients/AdminClientDetailSection.tsx', 'utf8');
  assert.equal((detail.match(/\/api\/admin\/clients\?scope=all/g) ?? []).length, 2);
  assert.match(detail, /if \(client\?\.archivedAt\)/);
  assert.equal((detail.match(/readOnly=\{Boolean\(client\.archivedAt\)\}/g) ?? []).length, 2);
  assert.match(detail, /typeof data\.warning === 'string'/);
});

test('retained dirty draft keeps the original version through external archive and restoration', () => {
  const original = company(1);
  const draft = { ...toDraft(original), note: 'Unsaved before archive' };
  const archived = { ...original, isActive: false, archivedAt: '2026-10-18T01:00:00Z', updatedAt: '2026-10-18T01:00:00Z' };
  const restored = { ...archived, archivedAt: null, updatedAt: '2026-10-18T02:00:00Z' };
  const afterArchive = mergeClientDrafts({ 1: draft }, [archived], new Map([[1, original]]));
  const afterRestore = mergeClientDrafts(afterArchive, [restored], new Map([[1, archived]]));
  assert.equal(afterRestore[1].expectedUpdatedAt, original.updatedAt, 'server must reject stale isActive=true form');
  assert.equal(afterRestore[1].note, 'Unsaved before archive');
  const clean = mergeClientDrafts({ 1: toDraft(original) }, [restored], new Map([[1, original]]));
  assert.equal(clean[1].expectedUpdatedAt, restored.updatedAt);
  assert.equal(clean[1].isActive, false);
});

test('permanent deletion preview accepts only a matching archived company and complete nonnegative counts', () => {
  const counts = { users: 1, sessions: 0, twoFactorChallenges: 0, chatMessages: 2, chatReadStates: 1, documents: 3, files: 3, fileBytes: 30, priceRequests: 4, priceLists: 2 };
  const preview = { id: 2, title: 'Company', archivedAt: '2026-10-18T01:00:00Z', updatedAt: '2026-10-18T01:00:00Z', revision: 'a'.repeat(64), counts };
  assert.equal(readClientDeletionPreview(preview, 2), preview);
  for (const invalid of [null, { ...preview, id: 1 }, { ...preview, archivedAt: null }, { ...preview, revision: '' }, { ...preview, counts: {} }, { ...preview, counts: { ...counts, files: -1 } }]) {
    assert.throws(() => readClientDeletionPreview(invalid, 2), /состав удаляемых данных/);
  }
});
