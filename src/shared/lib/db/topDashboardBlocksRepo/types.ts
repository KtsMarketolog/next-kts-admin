import type {
  CreateTopDashboardVersionInput,
  DeleteTopDashboardVersionResult,
  TopDashboardBlockDataOverview,
  TopDashboardOverview,
  TopDashboardProfile,
  TopDashboardSnapshotFormat,
  TopDashboardVersion,
} from '../topDashboardDomain';

export type TopDashboardBlock = {
  id: number;
  title: string;
  createdAt: string;
};

export type TopDashboardBlockSummary = TopDashboardBlock & {
  activeVersionId: number | null;
  activeOriginalName: string | null;
  versionCount: number;
  updatedAt: string;
  dataUploadedAt: string | null;
  dataAsOf: string | null;
  htmlPublishedAt: string | null;
};

export type TopDashboardPublishedBlockSummary = {
  id: number;
  title: string;
  activeVersionId: number;
  updatedAt: string;
  dataUploadedAt: string | null;
  dataAsOf: string | null;
  htmlPublishedAt: string | null;
};

export type TopDashboardPublishedBlockOverview = {
  block: {
    id: number;
    title: string;
    createdAt: string;
  };
  activeVersionId: number;
  updatedAt: string;
  dataUploadedAt: string | null;
  dataAsOf: string | null;
  htmlPublishedAt: string | null;
};

export type TopDashboardBlockOverview = TopDashboardOverview & {
  block: TopDashboardBlock;
  data: TopDashboardBlockDataOverview;
};

export type RenameTopDashboardBlockResult = {
  block: TopDashboardBlock;
  previousTitle: string;
  changed: boolean;
};

export type DeleteTopDashboardBlockResult = {
  deletedBlock: TopDashboardBlock & {
    activeVersionId: number | null;
    previousVersionId: number | null;
    versionCount: number;
    storedBytes: number;
    dataVersionCount: number;
    dataStoredBytes: number;
  };
  deletedStoragePaths: string[];
};

export type CreateTopDashboardBlockVersionInput = CreateTopDashboardVersionInput & {
  blockId: number;
  usageActor?: import('../../dashboardUploadUsage').DashboardUploadUsageActor;
};

export type ActivateTopDashboardBlockVersionInput = {
  blockId: number;
  versionId: number;
  expectedActiveVersionId: number | null;
  expectedSnapshotFormat: TopDashboardSnapshotFormat | null;
  expectedProfile: TopDashboardProfile | null;
  adminUserId: number | null;
  managerId: number | null;
};

export type DeleteTopDashboardBlockVersionResult = DeleteTopDashboardVersionResult & {
  blockId: number;
  deletedStoragePaths: string[];
};

export type CreateTopDashboardBlockVersionResult = {
  version: TopDashboardVersion;
  prunedStoragePaths: string[];
};

export type PruneTopDashboardBlockHistoryInput = {
  blockId: number;
  expectedActiveHtmlVersionId: number | null;
  expectedPreviousHtmlVersionId: number | null;
  expectedActiveDataVersionId: number | null;
  expectedPreviousDataVersionId: number | null;
  dryRun?: boolean;
};

export type PruneTopDashboardBlockHistoryResult = {
  blockId: number;
  dryRun: boolean;
  activeHtmlVersionId: number | null;
  previousHtmlVersionId: number | null;
  activeDataVersionId: number | null;
  previousDataVersionId: number | null;
  prunedHtmlVersionIds: number[];
  prunedDataVersionIds: number[];
  prunedStoragePaths: string[];
  preservedHtmlVersionIds: number[];
  preservedDataVersionIds: number[];
  preservedDraftVersionIds: number[];
};

export class TopDashboardBlockNotFoundError extends Error {
  constructor() {
    super('Блок не найден');
    this.name = 'TopDashboardBlockNotFoundError';
  }
}

export class TopDashboardBlockTitleValidationError extends Error {
  constructor() {
    super('Название блока должно содержать от 1 до 120 символов');
    this.name = 'TopDashboardBlockTitleValidationError';
  }
}

export class TopDashboardBlockStateNotFoundError extends Error {
  constructor() {
    super('Состояние блока не найдено');
    this.name = 'TopDashboardBlockStateNotFoundError';
  }
}

export class TopDashboardDraftLimitError extends Error {
  constructor() {
    super('Недостаточно места для HTML. Удалите ненужные черновики и повторите загрузку.');
    this.name = 'TopDashboardDraftLimitError';
  }
}

export class TopDashboardDataStorageLimitError extends Error {
  constructor() {
    super('Недостаточно места для нового файла данных. Сохранённые версии не изменены.');
    this.name = 'TopDashboardDataStorageLimitError';
  }
}
