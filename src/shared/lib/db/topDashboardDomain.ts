export type TopDashboardVersionStatus = 'active' | 'draft' | 'archived';

export type TopDashboardVersion = {
  id: number;
  originalName: string;
  fileSize: number;
  sha256: string;
  status: TopDashboardVersionStatus;
  uploadedByName: string;
  firstPublishedByName: string;
  firstPublishedAt: string | null;
  createdAt: string;
};

export type TopDashboardOverview = {
  activeVersionId: number | null;
  previousVersionId: number | null;
  updatedAt: string | null;
  versions: TopDashboardVersion[];
};

export type TopDashboardVersionContent = {
  id: number;
  originalName: string;
  htmlContent: string;
  fileSize: number;
  sha256: string;
};

export type CreateTopDashboardVersionInput = {
  originalName: string;
  htmlContent: string;
  fileSize: number;
  sha256: string;
  uploadedByAdminUserId: number | null;
};

export type ActivateTopDashboardVersionResult = {
  activeVersionId: number;
  previousVersionId: number | null;
  updatedAt: string;
  change: 'published' | 'rolled_back' | 'unchanged';
};

export type DeleteTopDashboardVersionResult = {
  deletedVersion: {
    id: number;
    originalName: string;
    fileSize: number;
    sha256: string;
    firstPublishedAt: string | null;
  };
  activeVersionId: number | null;
  previousVersionId: number | null;
  updatedAt: string;
  replacedPreviousVersion: boolean;
};

export class TopDashboardVersionNotFoundError extends Error {
  constructor() {
    super('Версия HTML не найдена');
    this.name = 'TopDashboardVersionNotFoundError';
  }
}

export class TopDashboardStateConflictError extends Error {
  currentActiveVersionId: number | null;

  constructor(currentActiveVersionId: number | null) {
    super('Активная версия уже изменилась');
    this.name = 'TopDashboardStateConflictError';
    this.currentActiveVersionId = currentActiveVersionId;
  }
}

export class TopDashboardActiveVersionDeleteError extends Error {
  activeVersionId: number;

  constructor(activeVersionId: number) {
    super('Активную версию нельзя удалить');
    this.name = 'TopDashboardActiveVersionDeleteError';
    this.activeVersionId = activeVersionId;
  }
}
