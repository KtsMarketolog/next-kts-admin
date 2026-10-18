export type AdminCrudHookOptions = {
  setBusy: (busy: boolean) => void;
  showStatus: (message: string) => void;
  /** Browser-memory workspace, isolated by the authenticated administrator. */
  draftScope?: string;
  actionLock?: { current: boolean };
};
