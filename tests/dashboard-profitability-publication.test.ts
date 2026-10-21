import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as domain from '../src/shared/lib/db/topDashboardDomain';
import { TopDashboardBlockNotFoundError } from '../src/shared/lib/db/topDashboardBlocksRepo';
import { enforceSameOriginRequest } from '../src/shared/lib/originProtection';
import { parsePositiveId } from '../src/app/api/admin/top-dashboard/blocks/routeUtils';
import { detectTopDashboardDataContract, type TopDashboardDataContract } from '../src/shared/lib/topDashboardContentSecurity';

function harness(contract: TopDashboardDataContract, failure?: Error) {
  const activations: Record<string, unknown>[] = [];
  const audit: Record<string, unknown>[] = [];
  const session = {role:'admin', adminUserId:1, sessionId:'synthetic-session'};
  const actor = {adminUserId:1, managerId:null};
  const dependencies: Record<string, unknown> = {
    '@/shared/lib/adminAuth': {
      requireTopDashboardManagementSession: async () => ({denied:null, session}),
      getTopDashboardActor: () => actor,
    },
    '@/shared/lib/adminSecurity': {enforceAdminActionRateLimit: async () => null},
    '@/shared/lib/db': {
      ...domain,
      TopDashboardBlockNotFoundError,
      getTopDashboardBlockVersionContent: async () => ({htmlContent:'synthetic source'}),
      activateTopDashboardBlockVersion: async (input: Record<string, unknown>) => {
        activations.push(input);
        if (failure) throw failure;
        return {activeVersionId:19,previousVersionId:null,updatedAt:'2026-10-13',change:'published',prunedStoragePaths:[]};
      },
    },
    '@/shared/lib/db/securityAuditRepo': {recordSecurityEvent: async (input: Record<string, unknown>) => {audit.push(input);}},
    '@/shared/lib/originProtection': {enforceSameOriginRequest},
    '@/shared/lib/rateLimit': {getClientIp: () => '127.0.0.1'},
    '@/shared/lib/topDashboardDataStorage': {deleteTopDashboardDataFiles: async (paths: string[]) => assert.deepEqual(Array.from(paths),[])},
    '@/shared/lib/topDashboardContentSecurity': {detectTopDashboardDataContract: () => contract},
    '../../routeUtils': {parsePositiveId},
  };
  const source = readFileSync(path.join(process.cwd(),'src/app/api/admin/top-dashboard/blocks/[blockId]/active/route.ts'),'utf8');
  const compiled = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const exports: {PUT?: (request: Request, context: {params: Promise<{blockId:string}>}) => Promise<Response>} = {};
  runInNewContext(compiled,{exports,Response,console,require(name:string){assert.ok(name in dependencies,name);return dependencies[name];}});
  return {activations,audit,request(origin='https://kts-impex.ru') {
    return exports.PUT!(new Request('https://kts-impex.ru/api/admin/top-dashboard/blocks/7/active',{
      method:'PUT',headers:{origin,'content-type':'application/json'},body:JSON.stringify({versionId:19,expectedActiveVersionId:null}),
    }),{params:Promise.resolve({blockId:'7'})});
  }};
}

test('publication API admits the exact detector-approved local invoice profile without a shared contract', async () => {
  const route = harness({mode:'disabled',snapshotFormat:null,profile:'profitability',directUploadTarget:null});
  const response = await route.request();
  assert.equal(response.status,200);
  assert.equal(route.activations.length,1);
  assert.equal(route.activations[0].expectedSnapshotFormat,null);
  assert.equal(route.activations[0].expectedProfile,'profitability');
  assert.equal(route.activations[0].expectedActiveVersionId,null);
  assert.equal(route.audit.length,1);
  assert.equal(route.audit[0].eventType,'top_dashboard_version_published');
});

test('publication API admits standalone without shared data, still denies invalid disabled contracts, and retains generic data', async () => {
  const standalone = harness({mode:'disabled',snapshotFormat:null,profile:'standalone',directUploadTarget:null});
  assert.equal((await standalone.request()).status,200);
  assert.equal(standalone.activations[0].expectedSnapshotFormat,null);
  assert.equal(standalone.activations[0].expectedProfile,'standalone');
  for (const profile of ['profitability-unsupported',null] as const) {
    const route = harness({mode:'disabled',snapshotFormat:null,profile,directUploadTarget:null});
    assert.equal((await route.request()).status,422);
    assert.deepEqual(route.activations,[]);
    assert.deepEqual(route.audit,[]);
  }
  const contract = detectTopDashboardDataContract('<input id="files" type="file">');
  const route = harness(contract);
  assert.equal((await route.request()).status,200);
  assert.equal(route.activations[0].expectedSnapshotFormat,'multi-file-v1');
  assert.equal(route.activations[0].expectedProfile,'generic');
});

test('local invoice publication preserves origin, optimistic lock, and repo compatibility failures', async () => {
  const contract: TopDashboardDataContract = {mode:'disabled',snapshotFormat:null,profile:'profitability',directUploadTarget:null};
  const denied = harness(contract);
  assert.equal((await denied.request('https://untrusted.invalid')).status,403);
  assert.deepEqual(denied.activations,[]);
  const stale = harness(contract,new domain.TopDashboardStateConflictError(20));
  assert.equal((await stale.request()).status,409);
  assert.deepEqual(stale.audit,[]);
  const incompatible = harness(contract,new domain.TopDashboardDataCompatibilityError('synthetic incompatibility'));
  assert.equal((await incompatible.request()).status,422);
  assert.deepEqual(incompatible.audit,[]);
});
