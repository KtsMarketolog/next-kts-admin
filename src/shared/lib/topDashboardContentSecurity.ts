// Compatibility facade: security policy, contracts, adapters and trusted frame
// transport live separately. Keep consumers on this stable public API.
export { TOP_DASHBOARD_DATA_MAX_BYTES } from './topDashboardLimits';
export {
  TOP_DASHBOARD_DATA_MESSAGE_MARKER,
  TOP_DASHBOARD_MULTI_FILE_MESSAGE_MARKER,
  TOP_DASHBOARD_DATA_ADAPTER_ATTRIBUTE,
} from './topDashboardContentSecurity/protocol';
export {
  detectTopDashboardExpectedProfile,
  detectTopDashboardExpectedSnapshotFormat,
  detectTopDashboardDataContract,
  type TopDashboardDataContract,
} from './topDashboardContentSecurity/dataContract';
export { getTopDashboardDataAdapterScript } from './topDashboardContentSecurity/adapterScript';
export { injectTopDashboardDataAdapter } from './topDashboardContentSecurity/document';
export { createTopDashboardFrameBridgeScript } from './topDashboardContentSecurity/frameBridgeScript';
export {
  buildTopDashboardFrameSecurityPolicy,
  buildTopDashboardContentSecurityPolicy,
} from './topDashboardContentSecurity/policy';
export {
  isTopDashboardBlockFrameRequest,
  getTopDashboardBlockDataFrameVersionId,
  isTopDashboardBlockDataMutationFrameRequest,
  isTopDashboardBlockDataFrameRequest,
} from './topDashboardContentSecurity/frameRequests';
