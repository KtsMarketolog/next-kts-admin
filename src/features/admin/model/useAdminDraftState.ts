'use client';

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from 'react';

type Key = string | number;
type WorkspaceEntry = { kind: 'draft' | 'collection'; state: unknown };
const workspaceCache = new Map<string, WorkspaceEntry>();
const workspaceTokens = new Map<string, object>();
const MAX_WORKSPACE_ENTRIES = 256;

function workspaceToken(scopeKey: string | undefined) {
  if (typeof window === 'undefined' || !scopeKey) return undefined;
  const token = workspaceTokens.get(scopeKey) ?? {};
  workspaceTokens.delete(scopeKey);
  workspaceTokens.set(scopeKey, token);
  while (workspaceTokens.size > MAX_WORKSPACE_ENTRIES) {
    const oldest = workspaceTokens.keys().next().value!;
    workspaceTokens.delete(oldest);
    workspaceCache.delete(oldest);
  }
  return token;
}

function readWorkspace<S>(scopeKey: string | undefined, kind: WorkspaceEntry['kind']): S | undefined {
  if (typeof window === 'undefined' || !scopeKey) return undefined;
  const entry = workspaceCache.get(scopeKey);
  if (!entry || entry.kind !== kind) return undefined;
  workspaceCache.delete(scopeKey);
  workspaceCache.set(scopeKey, entry);
  return entry.state as S;
}

function rememberWorkspace(scopeKey: string | undefined, kind: WorkspaceEntry['kind'], state: unknown) {
  if (typeof window === 'undefined' || !scopeKey) return;
  workspaceToken(scopeKey);
  workspaceCache.delete(scopeKey);
  workspaceCache.set(scopeKey, { kind, state });
  while (workspaceCache.size > MAX_WORKSPACE_ENTRIES) workspaceCache.delete(workspaceCache.keys().next().value!);
}

/** Browser memory only: no content or credentials are persisted to web storage. */
export function discardAdminDraftWorkspace(prefix: string) {
  if (typeof window === 'undefined' || !prefix) return;
  const boundary = prefix.endsWith(':') ? prefix : `${prefix}:`;
  for (const key of workspaceTokens.keys()) {
    if (!key.startsWith(boundary)) continue;
    workspaceTokens.set(key, {});
    workspaceCache.delete(key);
  }
}

function useWorkspaceState<S>(initial: () => S, scopeKey: string | undefined, kind: WorkspaceEntry['kind']) {
  type Owner = { identity: object; scopeKey: string | undefined; token: object | undefined };
  const [state, setState] = useState(initial);
  const identity = useMemo(() => ({ scopeKey }), [scopeKey]);
  const current = useRef(state);
  const owner = useRef<Owner | null>(null);
  const makeInitial = useRef(initial);
  // The server and the first browser render are identical. Restore before paint,
  // then let the normal server read merge fresh fields with these drafts.
  useLayoutEffect(() => {
    const nextOwner = { identity, scopeKey, token: workspaceToken(scopeKey) };
    const next = readWorkspace<S>(scopeKey, kind) ?? makeInitial.current();
    owner.current = nextOwner;
    current.current = next;
    setState(next);
    return () => { if (owner.current === nextOwner) owner.current = null; };
  }, [scopeKey, kind, identity]);
  const commit = useCallback((next: S) => {
    if (owner.current?.identity !== identity || owner.current.scopeKey !== scopeKey) return;
    // Logout also invalidates writes still in flight before React unmounts.
    if (typeof window !== 'undefined' && scopeKey && workspaceTokens.get(scopeKey) !== owner.current.token) return;
    current.current = next;
    rememberWorkspace(scopeKey, kind, next);
    setState(next);
  }, [scopeKey, kind, identity]);
  return { state, current, commit };
}

export function sameDraftValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameDraftValue(value, right[index]));
  }
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every((key) => Object.hasOwn(b, key) && sameDraftValue(a[key], b[key]));
}

/** Three-way acknowledgement: server normalization must not erase newer typing. */
export function mergeSavedDraft<T extends object>(current: T, submitted: T, saved: T, fields?: Array<keyof T>): T {
  const next = { ...current };
  for (const field of fields ?? Object.keys(saved) as Array<keyof T>) {
    if (sameDraftValue(current[field], submitted[field])) next[field] = saved[field];
  }
  return next;
}

export function useAdminDraft<T extends object>(initial: T, scopeKey?: string) {
  const { state, current, commit } = useWorkspaceState(() => ({ value: initial, base: initial }), scopeKey, 'draft');
  const setValue = useCallback((action: SetStateAction<T>) => {
    const previous = current.current;
    commit({ ...previous, value: typeof action === 'function' ? (action as (value: T) => T)(previous.value) : action });
  }, [commit, current]);
  const hydrate = useCallback((saved: T) => {
    const previous = current.current;
    commit({ value: mergeSavedDraft(previous.value, previous.base, saved), base: saved });
  }, [commit, current]);
  const accept = useCallback((submitted: T, saved: T, fields?: Array<keyof T>) => {
    const previous = current.current;
    const base = { ...previous.base };
    for (const field of fields ?? Object.keys(saved) as Array<keyof T>) base[field] = saved[field];
    commit({ base, value: mergeSavedDraft(previous.value, submitted, saved, fields) });
  }, [commit, current]);
  const resetAfterSave = useCallback((submitted: T) => {
    const previous = current.current;
    commit({ ...previous, value: mergeSavedDraft(previous.value, submitted, previous.base) });
  }, [commit, current]);
  return { value: state.value, setValue, hydrate, accept, resetAfterSave, dirty: !sameDraftValue(state.value, state.base) };
}

type CollectionState<T> = { items: T[]; base: Map<Key, T> };

export function useAdminDraftCollection<T extends object>(keyOf: (row: T) => Key, scopeKey?: string) {
  const [key] = useState(() => keyOf);
  const { state, current, commit } = useWorkspaceState<CollectionState<T>>(() => ({ items: [], base: new Map() }), scopeKey, 'collection');
  const hydrate = useCallback((rows: T[]) => {
    const previous = current.current;
    const existing = new Map(previous.items.map((row) => [key(row), row]));
    const base = new Map(rows.map((row) => [key(row), row]));
    const items = rows.map((row) => {
      const id = key(row), local = existing.get(id), old = previous.base.get(id);
      return local && old ? mergeSavedDraft(local, old, row) : local ?? row;
    });
    // Never silently discard a local edit when a later read omits the row.
    for (const row of previous.items) {
      const id = key(row), old = previous.base.get(id);
      if (!base.has(id) && !sameDraftValue(row, old)) {
        items.push(row);
        if (old) base.set(id, old);
      }
    }
    commit({ items, base });
  }, [commit, key, current]);
  const update = useCallback((id: Key, patch: Partial<T>) => {
    const previous = current.current;
    commit({ ...previous, items: previous.items.map((row) => key(row) === id ? { ...row, ...patch } : row) });
  }, [commit, key, current]);
  const accept = useCallback((submitted: T, saved: T, fields?: Array<keyof T>) => {
    const previous = current.current, id = key(saved), base = new Map(previous.base);
    const old = base.get(id);
    const nextBase = { ...(old ?? saved) };
    for (const field of fields ?? Object.keys(saved) as Array<keyof T>) nextBase[field] = saved[field];
    base.set(id, nextBase);
    const exists = previous.items.some((row) => key(row) === id);
    const items = exists ? previous.items.map((row) => key(row) === id ? mergeSavedDraft(row, submitted, saved, fields) : row) : [...previous.items, saved];
    commit({ items, base });
  }, [commit, key, current]);
  const remove = useCallback((id: Key) => {
    const previous = current.current, base = new Map(previous.base);
    base.delete(id);
    commit({ items: previous.items.filter((row) => key(row) !== id), base });
  }, [commit, key, current]);
  const baseline = useCallback((id: Key) => current.current.base.get(id), [current]);
  const dirtyKeys = new Set(state.items.filter((row) => !sameDraftValue(row, state.base.get(key(row)))).map(key));
  return { items: state.items, hydrate, update, accept, remove, baseline, dirtyKeys };
}
