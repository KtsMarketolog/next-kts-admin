export type TopDashboardVersionStatus = 'active' | 'draft' | 'archived';

export type TopDashboardSnapshotFormat = 'kts-bundle-v1' | 'purchases-v1';

export type TopDashboardProfile =
  | 'sales-analytics'
  | 'assortment-optimization'
  | 'purchases';

export type TopDashboardBlockDataVersionStatus = 'active' | 'previous' | 'archived';

export type TopDashboardBlockDataVersion = {
  id: number;
  originalName: string;
  fileSize: number;
  uncompressedSize: number;
  sha256: string;
  snapshotFormat: TopDashboardSnapshotFormat;
  dashboardProfile: TopDashboardProfile;
  status: TopDashboardBlockDataVersionStatus;
  uploadedByName: string;
  createdAt: string;
};

export type TopDashboardBlockDataOverview = {
  activeVersionId: number | null;
  previousVersionId: number | null;
  updatedAt: string | null;
  versions: TopDashboardBlockDataVersion[];
};

export type TopDashboardBlockDataVersionContent = {
  id: number;
  originalName: string;
  content: Buffer;
  fileSize: number;
  uncompressedSize: number;
  sha256: string;
  snapshotFormat: TopDashboardSnapshotFormat;
  dashboardProfile: TopDashboardProfile;
  createdAt: string;
};

export type CreateAndActivateTopDashboardBlockDataVersionInput = {
  blockId: number;
  expectedActiveVersionId: number | null;
  expectedActiveHtmlVersionId: number;
  expectedHtmlSnapshotFormat: TopDashboardSnapshotFormat;
  expectedHtmlProfile: TopDashboardProfile;
  originalName: string;
  content: Buffer;
  fileSize: number;
  uncompressedSize: number;
  sha256: string;
  snapshotFormat: TopDashboardSnapshotFormat;
  dashboardProfile: TopDashboardProfile;
  uploadedByAdminUserId: number | null;
  uploadedByManagerId: number | null;
};

export type CreateAndActivateTopDashboardBlockDataVersionResult = {
  version: TopDashboardBlockDataVersion;
  activeVersionId: number;
  previousVersionId: number | null;
  updatedAt: string;
  prunedVersionIds: number[];
};

export type ActivateTopDashboardBlockDataVersionInput = {
  blockId: number;
  versionId: number;
  expectedActiveVersionId: number | null;
  expectedActiveHtmlVersionId: number;
  expectedHtmlSnapshotFormat: TopDashboardSnapshotFormat;
  expectedHtmlProfile: TopDashboardProfile;
  adminUserId: number | null;
  managerId: number | null;
};

export type ActivateTopDashboardBlockDataVersionResult = {
  activeVersionId: number;
  previousVersionId: number | null;
  updatedAt: string;
  change: 'rolled_back' | 'unchanged';
};

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
  uploadedByManagerId: number | null;
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

export class TopDashboardBlockDataVersionNotFoundError extends Error {
  constructor() {
    super('Версия файла данных не найдена');
    this.name = 'TopDashboardBlockDataVersionNotFoundError';
  }
}

export class TopDashboardBlockDataStateNotFoundError extends Error {
  constructor() {
    super('Состояние файла данных не найдено');
    this.name = 'TopDashboardBlockDataStateNotFoundError';
  }
}

export class TopDashboardBlockDataStateConflictError extends Error {
  currentActiveVersionId: number | null;

  constructor(currentActiveVersionId: number | null) {
    super('Активный файл данных уже изменился');
    this.name = 'TopDashboardBlockDataStateConflictError';
    this.currentActiveVersionId = currentActiveVersionId;
  }
}

export class TopDashboardDataCompatibilityError extends Error {
  constructor(message = 'HTML-страница и файл данных несовместимы') {
    super(message);
    this.name = 'TopDashboardDataCompatibilityError';
  }
}

export class TopDashboardActiveHtmlRequiredError extends Error {
  constructor() {
    super('Сначала опубликуйте HTML-страницу, затем загрузите данные');
    this.name = 'TopDashboardActiveHtmlRequiredError';
  }
}
