export type AdminCrudHookOptions = {
  setBusy: (busy: boolean) => void;
  showStatus: (message: string) => void;
  reloadAdminData: () => Promise<void>;
};
