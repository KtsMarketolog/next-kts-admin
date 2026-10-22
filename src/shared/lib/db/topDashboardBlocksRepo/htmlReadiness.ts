import { detectTopDashboardDataContract } from '../../topDashboardContentSecurity';
import { ProfitabilityHtmlAnalysisLimitError } from '../../dashboardProfitabilityRecognition';
import { query } from '../client';

// Bump whenever contract detection changes the answer for an existing HTML.
// Metadata is shared by all app processes and never replaces publication/ACL checks.
export const TOP_DASHBOARD_HTML_READINESS_REVISION = 1;

export type TopDashboardHtmlReadiness = {
  is_self_contained: boolean | null;
  self_contained_revision: number | null;
  self_contained_sha256: string | null;
  self_contained_error: 'analysis_limit' | null;
  self_contained_retry_pending: boolean;
  sha256: string;
};

export type TopDashboardHtmlReadinessResult = 'ready' | 'requires-data' | 'analysis-limit';

export function classifyTopDashboardHtmlReadiness(html: string): boolean {
  const contract = detectTopDashboardDataContract(html);
  return contract.mode === 'disabled' && contract.snapshotFormat === null
    && (contract.profile === 'profitability' || contract.profile === 'standalone');
}

export function cachedTopDashboardHtmlReadiness(row: TopDashboardHtmlReadiness): TopDashboardHtmlReadinessResult | null {
  if (row.self_contained_revision !== TOP_DASHBOARD_HTML_READINESS_REVISION
    || row.self_contained_sha256 !== row.sha256) return null;
  if (typeof row.is_self_contained === 'boolean') return row.is_self_contained ? 'ready' : 'requires-data';
  return row.self_contained_error === 'analysis_limit' && row.self_contained_retry_pending ? 'analysis-limit' : null;
}

export async function resolveTopDashboardHtmlReadiness(
  row: TopDashboardHtmlReadiness & { blockId: number; versionId: number; htmlContent: string | null },
): Promise<TopDashboardHtmlReadinessResult> {
  const cached = cachedTopDashboardHtmlReadiness(row);
  if (cached !== null) return cached;
  // A missing body is not evidence that a report is self-contained. SQL only
  // omits it for current metadata or a separately verified compatible snapshot.
  if (row.htmlContent === null) return 'requires-data';

  // A processing limit is NOT a negative classification. Isolate that one
  // immutable version and retry after a bounded cooldown, so it cannot break
  // every report listing or be parsed on every request. The DB clock is used
  // for the retry deadline, consistently across application processes.
  let ready: boolean | null = null;
  let analysisError: 'analysis_limit' | null = null;
  try {
    ready = classifyTopDashboardHtmlReadiness(row.htmlContent);
  } catch (error) {
    if (!(error instanceof ProfitabilityHtmlAnalysisLimitError)) throw error;
    analysisError = 'analysis_limit';
    console.warn('[top-dashboard] Deferred HTML readiness analysis', {
      blockId: row.blockId, versionId: row.versionId, code: analysisError,
    });
  }
  try {
    await query(`update top_dashboard_block_versions
      set is_self_contained = $4, self_contained_revision = $5, self_contained_sha256 = $3,
        self_contained_error = $6,
        self_contained_retry_after = case when $6::text is null then null else now() + interval '5 minutes' end
      where block_id = $1 and id = $2 and sha256 = $3
        and (self_contained_revision is null or self_contained_revision <= $5)
        and (self_contained_revision is distinct from $5
          or self_contained_sha256 is distinct from $3 or is_self_contained is null)`,
    [row.blockId, row.versionId, row.sha256, ready, TOP_DASHBOARD_HTML_READINESS_REVISION, analysisError]);
  } catch {
    // This is an optional derived-cache write, not a publication. A cache outage
    // must not turn an otherwise successful read into an unavailable report.
    console.warn('[top-dashboard] Could not persist derived HTML readiness', {
      blockId: row.blockId, versionId: row.versionId,
    });
  }
  return analysisError ? 'analysis-limit' : ready ? 'ready' : 'requires-data';
}
