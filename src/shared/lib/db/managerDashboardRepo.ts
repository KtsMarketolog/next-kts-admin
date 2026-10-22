/** Stable entry point; responsibilities live in managerDashboardRepo/. */
export type { PersonalDashboardRecipient } from '../managerDashboardRecipients';
export type {
  PersonalDashboardSnapshot,
  PersonalDashboardStatus,
  PersonalDashboardHtmlVersion,
  PersonalDashboardImportStatus,
  PersonalDashboardImportResult,
  ImportPersonalDashboardSnapshotInput,
  PersonalDashboardManagerBinding,
  PersonalDashboardRecipientBinding,
  PersonalDashboardReviewer,
  PersonalDashboardReportDates,
} from './managerDashboardRepo/types';
export {
  resolvePersonalDashboardManager,
  resolvePersonalDashboardRecipient,
} from './managerDashboardRepo/access';
export {
  getPersonalDashboardStatus,
  getPersonalDashboardSnapshot,
} from './managerDashboardRepo/snapshotReads';
export {
  getPersonalDashboardReviewOverview,
  getPersonalDashboardReviewHtml,
  getPersonalDashboardReviewSnapshot,
} from './managerDashboardRepo/reviewReads';
export {
  getPersonalDashboardReportDates,
} from './managerDashboardRepo/reportDates';
export {
  getPersonalDashboardHtml,
  createPersonalDashboardHtml,
  activatePersonalDashboardHtml,
  deletePersonalDashboardHtml,
} from './managerDashboardRepo/htmlVersions';
export {
  recordPersonalDashboardImportFailure,
  listPersonalDashboardImports,
} from './managerDashboardRepo/importJournal';
export {
  importPersonalDashboardSnapshot,
} from './managerDashboardRepo/snapshotImport';
export {
  preparePersonalDashboardSnapshotReplacement,
  confirmPersonalDashboardSnapshotReplacement,
  preparePersonalDashboardSnapshotRollback,
  confirmPersonalDashboardSnapshotRollback,
} from './managerDashboardRepo/snapshotReplacement';
export {
  listPersonalDashboardAdmin,
} from './managerDashboardRepo/adminReads';
