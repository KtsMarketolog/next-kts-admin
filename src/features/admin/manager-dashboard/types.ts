export type ManagerDashboardSnapshot = {
  id: number;
  originalName: string;
  issued: string;
  expires: string;
  receivedAt: string;
};

export type ManagerDashboardHtmlVersion = {
  id: number;
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

export type ManagerDashboardOverview = {
  mode: 'manage';
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
  imports: ManagerDashboardImport[];
  mail: { enabled: boolean; configured: boolean };
  expectedIssuedAfter?: string | null;
  expectedBy?: string | null;
} | {
  mode: 'view';
  snapshot: ManagerDashboardSnapshot | null;
  snapshotStatus?: ManagerDashboardSnapshotStatus;
  history: ManagerDashboardSnapshot[];
  htmlVersion: Pick<ManagerDashboardHtmlVersion, 'id' | 'originalName'> | null;
  email: string;
  expectedIssuedAfter?: string | null;
  expectedBy?: string | null;
};

export type ManagerDashboardMutationResult = {
  results?: ManagerDashboardImport[];
  message?: string;
  version?: ManagerDashboardHtmlVersion;
};
