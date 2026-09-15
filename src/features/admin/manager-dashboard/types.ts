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
};

export type ManagerDashboardImport = {
  id?: number;
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

export type ManagerDashboardOverview = {
  mode: 'manage';
  groups: ManagerDashboardGroup[];
  imports: ManagerDashboardImport[];
  mail: { enabled: boolean; configured: boolean };
  expectedIssuedAfter?: string | null;
  expectedBy?: string | null;
} | {
  mode: 'view';
  audience: PersonalDashboardAudience;
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
