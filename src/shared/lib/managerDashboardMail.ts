/** Dashboard snapshots are uploaded manually. Legacy mail callers remain inert. */
export const MANAGER_DASHBOARD_MAIL_DISABLED_MESSAGE = 'Импорт снимков дашбордов из почты отключён. Загрузите файлы вручную в кабинете администратора.';

export type ManagerDashboardMailResult = {
  status: 'disabled';
  reason: 'manual_only';
  checkedMessages: number;
  attachments: number;
  imported: number;
  duplicates: number;
  stale: number;
  failed: number;
  skipped: { sender: number; messageSize: number; noAttachment: number; age: number };
  results: [];
  truncatedResults: false;
};

/** The legacy argument is deliberately unread, even when it contains an enabled flag. */
export function getManagerDashboardMailStatus(legacyEnvironment?: unknown) {
  void legacyEnvironment;
  return { enabled: false, configured: false, reason: 'manual_only' } as const;
}

/** Never reads credentials, opens a mailbox, connects to a DB, or changes import history. */
export async function importManagerDashboardFromEmail(legacyOptions?: unknown): Promise<ManagerDashboardMailResult> {
  void legacyOptions;
  return {
    status: 'disabled', reason: 'manual_only',
    checkedMessages: 0, attachments: 0, imported: 0, duplicates: 0, stale: 0, failed: 0,
    skipped: { sender: 0, messageSize: 0, noAttachment: 0, age: 0 },
    results: [], truncatedResults: false,
  };
}
