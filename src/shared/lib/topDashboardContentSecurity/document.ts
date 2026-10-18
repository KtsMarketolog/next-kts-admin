import { instrumentReviewedDashboardUsage } from '../dashboardUsageProfiles';
import { isSupportedProfitabilityHtml } from '../dashboardProfitabilityHtml';
import { detectTopDashboardDataContract } from './dataContract';
import { detectTopDashboardLegacyReadyFunction } from './legacyReady';
import { getTopDashboardDataAdapterScript } from './adapterScript';
import { TOP_DASHBOARD_DATA_ADAPTER_ATTRIBUTE } from './protocol';

const HEAD_OPEN_PATTERN = /<head\b[^>]*>/i;
const DOCTYPE_PATTERN = /<!doctype\b[^>]*>/i;

export function injectTopDashboardDataAdapter(
  htmlContent: string,
  options: { readOnly?: boolean; localInvoiceMode?: boolean } = {},
) {
  const contract = detectTopDashboardDataContract(htmlContent);
  const expectedFormat = contract.snapshotFormat;
  const expectedProfile = contract.profile;
  const legacyReadyFunction = detectTopDashboardLegacyReadyFunction(htmlContent);
  const localInvoiceMode = options.localInvoiceMode === true && isSupportedProfitabilityHtml(htmlContent);
  const readOnly = options.readOnly === true || contract.profile === 'profitability-unsupported';
  htmlContent = instrumentReviewedDashboardUsage(htmlContent);
  const adapter = `<script ${TOP_DASHBOARD_DATA_ADAPTER_ATTRIBUTE}>${getTopDashboardDataAdapterScript(expectedFormat, expectedProfile, readOnly, legacyReadyFunction, localInvoiceMode)}</script>`;
  const head = HEAD_OPEN_PATTERN.exec(htmlContent);
  if (head) {
    const index = head.index + head[0].length;
    return `${htmlContent.slice(0, index)}${adapter}${htmlContent.slice(index)}`;
  }

  const doctype = DOCTYPE_PATTERN.exec(htmlContent);
  if (doctype) {
    const index = doctype.index + doctype[0].length;
    return `${htmlContent.slice(0, index)}${adapter}${htmlContent.slice(index)}`;
  }

  return `${adapter}${htmlContent}`;
}
