// Stable public API. SQL operations live in modules grouped by responsibility.
export {
  type TopDashboardBlock,
  type TopDashboardBlockSummary,
  type TopDashboardPublishedBlockSummary,
  type TopDashboardPublishedBlockOverview,
  type TopDashboardBlockOverview,
  type RenameTopDashboardBlockResult,
  type DeleteTopDashboardBlockResult,
  type CreateTopDashboardBlockVersionInput,
  type ActivateTopDashboardBlockVersionInput,
  type DeleteTopDashboardBlockVersionResult,
  type CreateTopDashboardBlockVersionResult,
  type PruneTopDashboardBlockHistoryInput,
  type PruneTopDashboardBlockHistoryResult,
  TopDashboardBlockNotFoundError,
  TopDashboardBlockTitleValidationError,
  TopDashboardBlockStateNotFoundError,
  TopDashboardDraftLimitError,
  TopDashboardDataStorageLimitError,
} from './topDashboardBlocksRepo/types';
export {
  pruneTopDashboardBlockHistory,
} from './topDashboardBlocksRepo/history';
export {
  getPublishedTopDashboardBlocks,
  getPublishedTopDashboardBlockOverview,
  isActiveTopDashboardHtmlVersion,
  isPublishedTopDashboardBlockVersion,
  getPublishedTopDashboardBlockVersionContent,
} from './topDashboardBlocksRepo/publishedReads';
export {
  getTopDashboardBlocks,
  getTopDashboardBlockOverview,
  getActiveTopDashboardBlockDataContent,
  getActiveTopDashboardBlockHtmlContent,
  getTopDashboardBlockVersionContent,
} from './topDashboardBlocksRepo/reads';
export {
  normalizeTopDashboardBlockTitle,
  createTopDashboardBlock,
  renameTopDashboardBlock,
  deleteTopDashboardBlock,
} from './topDashboardBlocksRepo/blocks';
export {
  createTopDashboardBlockVersion,
  deleteTopDashboardBlockVersion,
} from './topDashboardBlocksRepo/htmlVersions';
export {
  activateTopDashboardBlockVersion,
} from './topDashboardBlocksRepo/publication';
export {
  createAndActivateTopDashboardBlockDataVersion,
  activateTopDashboardBlockDataVersion,
} from './topDashboardBlocksRepo/snapshots';
