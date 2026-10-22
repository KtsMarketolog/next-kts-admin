'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { CLIENT_EDITABLE_FIELDS, type ClientConflictComparison } from './clientConflict';
import { openClientDraftWorkspace } from './clientDraftWorkspace';
import { emptyDraft, type AdminClientsSectionProps, type ClientCompany, type ClientDraft, type ClientListScope } from './AdminClientsModel';

type DraftOptions = Pick<AdminClientsSectionProps, 'draftScope' | 'onNavigationStateChange'> & { busy: boolean };

/** Business drafts survive section navigation; passwords never enter the workspace. */
export function useAdminClientDrafts({ draftScope, onNavigationStateChange, busy }: DraftOptions) {
  const companyBaselines = useRef(new Map<number, ClientCompany>());
  const [scope, setScope] = useState<ClientListScope>('active');
  const scopeRef = useRef<ClientListScope>('active');
  const [draft, setDraft] = useState<ClientDraft>(emptyDraft);
  const [{ drafts: companyDrafts, baselines: draftBaselines }, setDraftState] = useState(() => ({
    drafts: {} as Record<number, ClientDraft>, baselines: new Map<number, ClientCompany>(),
  }));
  const companyDraftsRef = useRef<Record<number, ClientDraft>>({});
  const [clientPasswordEditIds, setClientPasswordEditIds] = useState<Record<number, boolean>>({});
  const clientPasswordEditIdsRef = useRef<Record<number, boolean>>({});
  const [clientPasswordDrafts, setClientPasswordDrafts] = useState<Record<number, string>>({});
  const [companyConflicts, setCompanyConflicts] = useState<Record<number, { comparison: ClientConflictComparison | null; error: string }>>({});
  const [expandedCompanyIds, setExpandedCompanyIds] = useState<Record<number, boolean>>({});
  const [savedCompanyId, setSavedCompanyId] = useState<number | null>(null);
  const creationRef = useRef(draft);
  const expandedRef = useRef(expandedCompanyIds);
  const workspaceRef = useRef<ReturnType<typeof openClientDraftWorkspace> | null>(null);

  // Capture committed state before the restore effect. Its cleanup reads live
  // refs, not the render that opened the editor (also safe in Strict Mode).
  useLayoutEffect(() => {
    creationRef.current = draft;
    expandedRef.current = expandedCompanyIds;
    workspaceRef.current?.save({ creation: draft, drafts: companyDraftsRef.current,
      baselines: companyBaselines.current, expanded: expandedCompanyIds, scope: scopeRef.current });
  });
  useLayoutEffect(() => {
    const workspace = openClientDraftWorkspace(draftScope);
    workspaceRef.current = workspace;
    const saved = workspace.snapshot;
    creationRef.current = saved.creation;
    expandedRef.current = saved.expanded;
    companyDraftsRef.current = saved.drafts;
    companyBaselines.current = saved.baselines;
    scopeRef.current = saved.scope;
    setDraft(saved.creation);
    setExpandedCompanyIds(saved.expanded);
    setDraftState({ drafts: saved.drafts, baselines: new Map(saved.baselines) });
    setScope(saved.scope);
    // No passwords, password-edit flags, access grants or rendered company
    // list are cached. Fresh permission-filtered reads decide what is visible.
    return () => {
      workspace.save({ creation: creationRef.current, drafts: companyDraftsRef.current,
        baselines: companyBaselines.current, expanded: expandedRef.current, scope: scopeRef.current });
      if (workspaceRef.current === workspace) workspaceRef.current = null;
    };
  }, [draftScope]);

  const passwordPending = Boolean(draft.password) || Object.values(clientPasswordEditIds).some(Boolean);
  const hasUnsaved = passwordPending || CLIENT_EDITABLE_FIELDS.some((field) => draft[field] !== emptyDraft[field])
    || Object.entries(companyDrafts).some(([id, value]) => {
      const base = draftBaselines.get(Number(id));
      return !base || CLIENT_EDITABLE_FIELDS.some((field) => value[field] !== base[field]);
    });
  useLayoutEffect(() => {
    onNavigationStateChange?.({ dirty: hasUnsaved, busy, passwordPending });
  }, [onNavigationStateChange, hasUnsaved, busy, passwordPending]);
  useLayoutEffect(() => () => {
    onNavigationStateChange?.({ dirty: false, busy: false, passwordPending: false });
  }, [onNavigationStateChange]);

  const replaceCompanyDrafts = useCallback((update: (current: Record<number, ClientDraft>) => Record<number, ClientDraft>) => {
    const next = update(companyDraftsRef.current);
    companyDraftsRef.current = next;
    // Publish drafts with their exact baseline in the same render; event-time
    // refs remain available for stale-response fencing without render-time reads.
    setDraftState({ drafts: next, baselines: new Map(companyBaselines.current) });
  }, []);

  const replacePasswordEditIds = (update: (current: Record<number, boolean>) => Record<number, boolean>) => {
    const next = update(clientPasswordEditIdsRef.current);
    clientPasswordEditIdsRef.current = next;
    setClientPasswordEditIds(next);
  };

  const updateCompanyDraft = (id: number, patch: Partial<ClientDraft>) => {
    replaceCompanyDrafts((current) => ({
      ...current,
      [id]: { ...(current[id] ?? emptyDraft), ...patch },
    }));
  };

  const toggleCompanyExpanded = (companyId: number) => {
    setExpandedCompanyIds((current) => ({ ...current, [companyId]: !current[companyId] }));
  };

  const toggleClientPasswordEdit = (companyId: number) => {
    replacePasswordEditIds((current) => ({ ...current, [companyId]: !current[companyId] }));
    setClientPasswordDrafts((current) => {
      const next = { ...current };
      delete next[companyId];
      return next;
    });
  };


  return {
    draft, setDraft, companyDrafts, companyDraftsRef, companyBaselines, replaceCompanyDrafts,
    clientPasswordEditIds, clientPasswordEditIdsRef, replacePasswordEditIds,
    clientPasswordDrafts, setClientPasswordDrafts, companyConflicts, setCompanyConflicts,
    expandedCompanyIds, setExpandedCompanyIds, savedCompanyId, setSavedCompanyId,
    scope, scopeRef, setScope, hasUnsaved, passwordPending,
    updateCompanyDraft, toggleCompanyExpanded, toggleClientPasswordEdit,
  };
}

export type AdminClientDraftState = ReturnType<typeof useAdminClientDrafts>;
