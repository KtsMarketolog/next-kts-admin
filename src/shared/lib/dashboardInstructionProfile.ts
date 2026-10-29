import { isProfitabilityHtmlCandidate } from './dashboardProfitabilityHtml';
import type { TopDashboardInstructionKind } from './dashboardInstructions';
import { detectTopDashboardExpectedProfile } from './topDashboardContentSecurity';

/** Server-side classification shared by overview and protected asset delivery. */
export function resolveTopDashboardInstructionKind(html: string): TopDashboardInstructionKind | null {
  const sales = detectTopDashboardExpectedProfile(html) === 'sales-analytics';
  const profitability = isProfitabilityHtmlCandidate(html);
  // Never choose a manual from a mutable report title/ID or ambiguous HTML.
  if (sales && profitability) return null;
  if (profitability) return 'deal-profitability';
  return sales ? 'sales-analytics' : null;
}
