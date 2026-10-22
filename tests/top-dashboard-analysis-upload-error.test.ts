import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

test('HTML analysis deadline is a clear upload rejection, not a saved version or generic server error', async () => {
  class AnalysisLimit extends Error {}
  const error = new AnalysisLimit('HTML слишком сложен для безопасной проверки. Проверьте незакрытые теги и повторите загрузку.');
  const calls: string[] = [];
  const noop = async () => null;
  const unexpected = () => { assert.fail('No post-save side effect is allowed after analysis rejection'); };
  const dependencies: Record<string, unknown> = {
    '@/shared/lib/adminAuth': {
      requireTopDashboardManagementSession: async () => ({ session: { sessionId: 'test' }, denied: null }),
      getTopDashboardActor: () => ({ adminUserId: 1, managerId: null }),
    },
    '@/shared/lib/adminSecurity': { enforceAdminActionRateLimit: noop },
    '@/shared/lib/originProtection': { enforceSameOriginRequest: () => null },
    '@/shared/lib/dashboardProfitabilityHtml': { ProfitabilityHtmlAnalysisLimitError: AnalysisLimit },
    '@/shared/lib/db': {
      createTopDashboardBlockVersion: async () => { calls.push('classify-before-save'); throw error; },
      TopDashboardBlockNotFoundError: class extends Error {},
      TopDashboardDraftLimitError: class extends Error {},
    },
    '@/shared/lib/dashboardUploadUsage': { getDashboardUploadUsageActor: () => ({}), scheduleDashboardUploadUsageDrain: unexpected },
    '@/shared/lib/db/securityAuditRepo': { recordSecurityEvent: unexpected },
    '@/shared/lib/rateLimit': { getClientIp: unexpected },
    '@/shared/lib/topDashboardDataStorage': { deleteTopDashboardDataFiles: unexpected },
    '../../routeUtils': {
      parsePositiveId: Number,
      readTopDashboardHtmlUpload: async () => ({ upload: { htmlContent: 'synthetic', fileSize: 9, sha256: 'test' } }),
      errorResponse: (message: string, status = 400) => Response.json({ error: message }, { status }),
    },
  };
  const source = ts.transpileModule(readFileSync('src/app/api/admin/top-dashboard/blocks/[blockId]/versions/route.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: { POST?: (request: Request, context: { params: Promise<{ blockId: string }> }) => Promise<Response> } = {};
  runInNewContext(source, { exports, Response, console: { error: unexpected }, require(name: string) {
    assert.ok(name in dependencies, name); return dependencies[name];
  } });
  const response = await exports.POST!(new Request('https://kts.test/upload', { method: 'POST' }), { params: Promise.resolve({ blockId: '7' }) });
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: error.message });
  assert.deepEqual(calls, ['classify-before-save']);
});
