import type { PersonalSnapshotMetadata } from '../../managerDashboardDomain';
import type { PersonalDashboardAudience } from '../../managerDashboardAudience';
import type { DashboardUploadUsageActor } from '../../dashboardUploadUsage';
import type { PersonalDashboardRecipient } from '../../managerDashboardRecipients';

export type PersonalDashboardSnapshot = PersonalSnapshotMetadata & {
  id: number;
  managerId: number | null;
  adminUserId: number | null;
  sourceKey: string;
  receivedAt: string;
  status: 'active' | 'previous' | 'archived';
  expired: boolean;
};

export type PersonalDashboardStatus = {
  audience: PersonalDashboardAudience;
  email: string;
  snapshot: PersonalDashboardSnapshot | null;
  history: PersonalDashboardSnapshot[];
  bindingStatus: 'matched' | 'missing_email' | 'ambiguous_email';
};

export type PersonalDashboardHtmlVersion = {
  id: number;
  audience: PersonalDashboardAudience;
  originalName: string;
  fileSize: number;
  sha256: string;
  createdAt: string;
  uploadedBy: string;
  firstPublishedAt: string | null;
  status: 'draft' | 'active' | 'archived';
};

export type PersonalDashboardImportStatus = 'imported' | 'duplicate' | 'unknown' | 'ambiguous' | 'stale' | 'expired' | 'conflict' | 'invalid' | 'quota';

export type PersonalDashboardImportResult = {
  id: number;
  originalName: string;
  status: PersonalDashboardImportStatus;
  code: string;
  message: string;
  managerId: number | null;
  adminUserId?: number | null;
  snapshotId: number | null;
};

export type ImportPersonalDashboardSnapshotInput = {
  filename: string;
  bytes: Buffer;
  sourceKey: string;
  sender?: string;
  messageId?: string;
  usageActor?: DashboardUploadUsageActor;
};

export type PersonalDashboardManagerBinding = { id: number; email: string; isActive: boolean; role: string | null };

export type PersonalDashboardRecipientBinding = PersonalDashboardManagerBinding & { source: PersonalDashboardRecipient['source'] };

export type ManagerRow = { id: string; name: string; email: string; role: string | null; is_active: boolean };

export type RecipientRow = ManagerRow & { source: PersonalDashboardRecipient['source'] };

export type SnapshotRow = {
  id: string; manager_id: string | null; admin_user_id: string | null; original_name: string; file_size: string; sha256: string;
  email_hash: string; person_name: string; person_role: string; issued: string; expires: string;
  source_key: string; received_at: string; active_snapshot_id: string | null; previous_snapshot_id: string | null;
};

export type HtmlRow = {
  id: string; audience: PersonalDashboardAudience; original_name: string; file_size: string; sha256: string; created_at: string;
  uploaded_by: string; first_published_at: string | null;
};

export type HtmlStateRow = { active_version_id: string | null; previous_version_id: string | null };

export type ImportRow = {
  id: string; original_name: string; status: PersonalDashboardImportStatus; code: string;
  manager_id: string | null; admin_user_id: string | null; snapshot_id: string | null;
};

export type ImportJournalRow = ImportRow & { sender: string; message_id: string; received_at: string; issued: string | null };

export type PersonalDashboardReviewer = { adminUserId: number; sessionId: string };

export type PersonalDashboardReportDates = {
  dataUploadedAt: string | null; dataAsOf: string | null; htmlPublishedAt: string | null;
};
