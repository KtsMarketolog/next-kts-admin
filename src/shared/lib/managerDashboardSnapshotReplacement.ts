import type { PersonalDashboardRecipient } from './managerDashboardRecipients';

/** Metadata only: encrypted bytes, passwords and session identifiers never enter the preview. */
export type PersonalSnapshotReplacementFile = {
  id?: number;
  originalName: string;
  fileSize: number;
  sha256: string;
  issued: string;
  expires: string;
  receivedAt?: string;
};

export type PersonalSnapshotReplacementPreview = {
  action: 'replace' | 'rollback';
  token: string;
  recipient: PersonalDashboardRecipient & { name: string; email: string };
  current: PersonalSnapshotReplacementFile;
  incoming: PersonalSnapshotReplacementFile;
  previous: PersonalSnapshotReplacementFile | null;
};
