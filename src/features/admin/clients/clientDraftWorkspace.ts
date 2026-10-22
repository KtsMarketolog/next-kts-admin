import type { AdminSession } from '@/shared/lib/adminAuth';
import { emptyDraft, type ClientCompany, type ClientDraft, type ClientListScope } from './AdminClientsModel';
import { CLIENT_EDITABLE_FIELDS } from './clientConflict';

export type ClientDraftWorkspaceSnapshot = {
  creation: ClientDraft;
  drafts: Record<number, ClientDraft>;
  baselines: Map<number, ClientCompany>;
  expanded: Record<number, boolean>;
  scope: ClientListScope;
};

type SessionIdentity = Pick<AdminSession, 'role' | 'sessionId' | 'adminUserId' | 'managerId'>;
type Workspace = { scope: string; snapshot: ClientDraftWorkspaceSnapshot; dirty: boolean };

// One browser tab, one authenticated session. Never use browser storage, and
// never retain a workspace during server rendering across different requests.
let workspace: Workspace | undefined;
const listeners = new Set<() => void>();

function publishWorkspaceChange() {
  for (const listener of [...listeners]) listener();
}

/** Stable boolean snapshot for a leave guard that also remains mounted on the home screen. */
export function hasClientDraftWorkspaceChanges(scope: string | undefined): boolean {
  return typeof window !== 'undefined' && Boolean(scope && workspace?.scope === scope && workspace.dirty);
}

export function subscribeClientDraftWorkspace(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function hasBusinessChanges(snapshot: ClientDraftWorkspaceSnapshot): boolean {
  return CLIENT_EDITABLE_FIELDS.some(field => snapshot.creation[field] !== emptyDraft[field])
    || Object.entries(snapshot.drafts).some(([id, draft]) => {
      const base = snapshot.baselines.get(Number(id));
      return !base || CLIENT_EDITABLE_FIELDS.some(field => draft[field] !== base[field]);
    });
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** A new login or changed role/actor must not inherit another session's drafts. */
export function getClientDraftScope(session: SessionIdentity | null | undefined): string | undefined {
  if (!session || typeof session.sessionId !== 'string' || !session.sessionId.trim()) return undefined;
  if (session.adminUserId !== undefined && !positiveId(session.adminUserId)) return undefined;
  if (session.managerId !== undefined && !positiveId(session.managerId)) return undefined;
  if (session.role === 'manager' || session.role === 'support_manager') {
    if (!positiveId(session.managerId)) return undefined;
  } else if (session.role === 'wholesale_admin') {
    if (!positiveId(session.adminUserId)) return undefined;
  } else if (session.role !== 'admin') {
    return undefined;
  }
  // Legacy admin sessions may have no adminUserId, but must have sessionId.
  return `clients:${JSON.stringify([session.role, session.adminUserId ?? null, session.managerId ?? null, session.sessionId])}`;
}

export function emptyClientDraftWorkspace(): ClientDraftWorkspaceSnapshot {
  return { creation: { ...emptyDraft }, drafts: {}, baselines: new Map(), expanded: {}, scope: 'active' };
}

const text = (value: unknown) => typeof value === 'string' ? value : '';
const optionalId = (value: unknown) => positiveId(value) ? value : null;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** Allowlist primitive business fields: unexpected nested credentials cannot enter the cache. */
function copyDraft(draft: ClientDraft): ClientDraft {
  return {
    ...(typeof draft.expectedUpdatedAt === 'string' ? { expectedUpdatedAt: draft.expectedUpdatedAt } : {}),
    title: text(draft.title), email: text(draft.email), phone: text(draft.phone), note: text(draft.note),
    managerId: optionalId(draft.managerId), supportManagerId: optionalId(draft.supportManagerId),
    requireTwoFactor: draft.requireTwoFactor === true, isActive: draft.isActive === true,
    password: '',
  };
}

function copyCompany(company: ClientCompany): ClientCompany {
  return {
    id: company.id, title: text(company.title), email: text(company.email), phone: text(company.phone), note: text(company.note),
    managerId: optionalId(company.managerId), managerName: text(company.managerName),
    supportManagerId: optionalId(company.supportManagerId), supportManagerName: text(company.supportManagerName),
    requireTwoFactor: company.requireTwoFactor === true, userCount: count(company.userCount),
    clientLogin: text(company.clientLogin), clientUserId: optionalId(company.clientUserId),
    passwordChangedAt: text(company.passwordChangedAt), chatUnreadCount: count(company.chatUnreadCount),
    isActive: company.isActive === true, archivedAt: company.archivedAt === null ? null : text(company.archivedAt),
    createdAt: text(company.createdAt), updatedAt: text(company.updatedAt),
  };
}

function copySnapshot(snapshot: ClientDraftWorkspaceSnapshot): ClientDraftWorkspaceSnapshot {
  const drafts: Record<number, ClientDraft> = {};
  for (const [key, draft] of Object.entries(snapshot.drafts)) {
    const id = Number(key);
    if (positiveId(id) && String(id) === key && draft && typeof draft === 'object') drafts[id] = copyDraft(draft);
  }
  const baselines = new Map<number, ClientCompany>();
  for (const [id, company] of snapshot.baselines) {
    if (positiveId(id) && company?.id === id) baselines.set(id, copyCompany(company));
  }
  const expanded: Record<number, boolean> = {};
  for (const [key, value] of Object.entries(snapshot.expanded)) {
    const id = Number(key);
    if (positiveId(id) && String(id) === key && value === true) expanded[id] = true;
  }
  return {
    creation: copyDraft(snapshot.creation), drafts, baselines, expanded,
    scope: snapshot.scope === 'archived' ? 'archived' : 'active',
  };
}

/** Snapshot reads and writes are detached; tokens stay byte-for-byte unchanged. */
export function openClientDraftWorkspace(scope: string | undefined): {
  snapshot: ClientDraftWorkspaceSnapshot;
  save: (snapshot: ClientDraftWorkspaceSnapshot) => void;
} {
  if (typeof window === 'undefined') return { snapshot: emptyClientDraftWorkspace(), save: () => {} };
  if (!scope) {
    discardClientDraftWorkspace();
    return { snapshot: emptyClientDraftWorkspace(), save: () => {} };
  }
  if (workspace?.scope !== scope) {
    workspace = { scope, snapshot: emptyClientDraftWorkspace(), dirty: false };
    publishWorkspaceChange();
  }
  const owner = workspace;
  return {
    snapshot: copySnapshot(owner.snapshot),
    save: snapshot => {
      // A logout/identity change also fences writes from callbacks still in flight.
      if (workspace !== owner) return;
      owner.snapshot = copySnapshot(snapshot);
      const dirty = hasBusinessChanges(owner.snapshot);
      if (owner.dirty !== dirty) {
        owner.dirty = dirty;
        publishWorkspaceChange();
      }
    },
  };
}

/** Explicit logout/session invalidation; unmounting a section must not call this. */
export function discardClientDraftWorkspace(scope?: string): void {
  if (typeof window === 'undefined') return;
  if (workspace && (scope === undefined || workspace.scope === scope)) {
    workspace = undefined;
    publishWorkspaceChange();
  }
}
