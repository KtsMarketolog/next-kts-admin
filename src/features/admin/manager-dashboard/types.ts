import type { PersonalDashboardAudience } from '@/shared/lib/managerDashboardAudience';

export type ManagerDashboardSnapshot = {
  id: number;
  originalName: string;
  issued: string;
  expires: string;
  receivedAt: string;
};

export type ManagerDashboardHtmlVersion = {
  id: number;
  audience: PersonalDashboardAudience;
  originalName: string;
  fileSize: number;
  createdAt: string;
  firstPublishedAt?: string | null;
  format?: 'ktsp' | 'route-planner-v1';
};

export type ManagerDashboardImport = {
  id?: number | string;
  originalName: string;
  status: string;
  message?: string;
  createdAt?: string;
  receivedAt?: string;
};

export type ManagerDashboardSnapshotStatus = 'current' | 'stale' | 'expired' | 'missing';
export type ManagerDashboardBindingStatus = 'matched' | 'missing_email' | 'ambiguous_email';

export type ManagerDashboardGroup = {
  audience: PersonalDashboardAudience;
  htmlVersions: ManagerDashboardHtmlVersion[];
  activeHtmlVersionId: number | null;
  previousHtmlVersionId: number | null;
  managers: Array<{
    id: number;
    name: string;
    email: string;
    isActive?: boolean;
    bindingStatus?: 'matched' | 'unknown' | 'ambiguous';
    snapshot: ManagerDashboardSnapshot | null;
    snapshotStatus?: ManagerDashboardSnapshotStatus;
  }>;
};

export type ManagerDashboardSharedSnapshot = ManagerDashboardSnapshot & {
  email: string;
  fileSize?: number;
};

export type ManagerDashboardSupportShared = {
  htmlVersions: ManagerDashboardHtmlVersion[];
  activeHtmlVersionId: number | null;
  previousHtmlVersionId: number | null;
  snapshot: ManagerDashboardSharedSnapshot | null;
  history: ManagerDashboardSharedSnapshot[];
  jsonSnapshot?: ManagerDashboardSharedJsonSnapshot | null;
  jsonHistory?: ManagerDashboardSharedJsonSnapshot[];
};

export type ManagerDashboardSharedJsonSnapshot = {
  id: number;
  htmlVersionId: number;
  originalName: string;
  fileSize: number;
  sha256: string;
  savedAt: string;
  receivedAt: string;
  status: 'active' | 'previous' | 'archived';
};

/** Standalone shared report: never carries a personal manager/email identity. */
export type RoutePlannerOverview = {
  mode: 'manage' | 'view';
  supportShared: ManagerDashboardSupportShared | null;
};

export type ManagerDashboardOverview = {
  mode: 'manage';
  groups: ManagerDashboardGroup[];
  supportShared?: ManagerDashboardSupportShared | null;
  imports: ManagerDashboardImport[];
  importsNextCursor: string | null;
  mail?: { enabled: boolean; configured: boolean };
  expectedIssuedAfter?: string | null;
  expectedBy?: string | null;
} | {
  mode: 'view';
  audience: PersonalDashboardAudience;
  supportShared?: ManagerDashboardSupportShared | null;
  bindingStatus: ManagerDashboardBindingStatus;
  snapshot: ManagerDashboardSnapshot | null;
  snapshotStatus?: ManagerDashboardSnapshotStatus;
  history: ManagerDashboardSnapshot[];
  htmlVersion: Pick<ManagerDashboardHtmlVersion, 'id' | 'originalName' | 'audience'> | null;
  email: string;
  expectedIssuedAfter?: string | null;
  expectedBy?: string | null;
};

export type ManagerDashboardMutationResult = {
  results?: ManagerDashboardImport[];
  message?: string;
  version?: ManagerDashboardHtmlVersion;
};
