import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import type {AdminSession} from '../src/shared/lib/adminAuth';
import {canViewDashboard,canReadTopDashboardBlock} from '../src/shared/lib/dashboardAccess';
import {canManageCurrencyDashboard} from '../src/shared/lib/currencyDashboardAccess';
import {personalDashboardMode,readPersonalRequestBytes} from '../src/shared/lib/managerDashboardSecurity';
import * as permissions from '../src/shared/lib/dashboardPermissions';
import {enforceSameOriginRequest} from '../src/shared/lib/originProtection';

test('universal view grants do not inherit legacy role viewing or confer management',()=>{
  for(const role of ['top','manager','support_manager','purchaser','wholesale_admin'] as const){
    const session:AdminSession={role,sessionId:'persisted',adminUserId:2,managerId:3,canAccessTopDashboard:true,dashboardAccess:[]};
    for(const key of ['top:7','route-planner','currency-rates']){
      assert.equal(canViewDashboard(session,key),false,`${role} cannot bypass revoked ${key}`);
      session.dashboardAccess=[key];assert.equal(canViewDashboard(session,key),true);
      assert.equal(canViewDashboard({...session,sessionId:undefined},key),false);
      assert.equal(canManageCurrencyDashboard(session),false);
      session.dashboardAccess=[];
    }
    assert.equal(canReadTopDashboardBlock({...session,dashboardAccess:['top:7']},8),false);
  }
});

test('personal checkboxes are bound to own operational audience and valid identity',()=>{
  const grants=['manager:development','manager:support'];
  for(const role of ['manager','support_manager'] as const){
    const session:AdminSession={role,managerId:3,sessionId:'persisted',dashboardAccess:grants};
    assert.equal(canViewDashboard(session,'manager:development'),role==='manager');
    assert.equal(canViewDashboard(session,'manager:support'),role==='support_manager');
    assert.equal(personalDashboardMode(session),'view');
    assert.equal(personalDashboardMode({...session,dashboardAccess:[]} ),null);
    assert.equal(personalDashboardMode({...session,managerId:undefined}),null);
  }
  for(const role of ['top','purchaser','wholesale_admin'] as const){
    const session:AdminSession={role,adminUserId:3,sessionId:'persisted',dashboardAccess:grants};
    assert.equal(canViewDashboard(session,grants[0]),false);assert.equal(canViewDashboard(session,grants[1]),false);
    assert.equal(personalDashboardMode(session),null);
  }
});

test('existing management is separate, and forged management on purchaser does not authorize writes',()=>{
  for(const role of ['admin','admintop','top','manager','support_manager'] as const){
    const session:AdminSession={role,adminUserId:2,managerId:3,sessionId:'persisted',canManageTopDashboard:true,dashboardAccess:[]};
    assert.equal(canViewDashboard(session,'top:7'),true);assert.equal(canManageCurrencyDashboard(session),true);
    assert.equal(canViewDashboard(session,'route-planner'),role==='admin'||role==='admintop');
  }
  assert.equal(canManageCurrencyDashboard({role:'purchaser',adminUserId:2,sessionId:'x',canManageTopDashboard:true,dashboardAccess:['currency-rates']}),false);
});

function audienceRoute(admin=true){
  const calls:string[]=[];
  const modules:Record<string,unknown>={
    '@/shared/lib/adminAuth':{requireAdminSession:async()=>admin?{session:{role:'admin',sessionId:'x',adminUserId:1},denied:null}:{denied:new Response(null,{status:403})}},
    '@/shared/lib/adminSecurity':{enforceAdminActionRateLimit:async()=>null},
    '@/shared/lib/dashboardPermissions':permissions,
    '@/shared/lib/db/dashboardAccessRepo':{getDashboardAudience:async()=>{calls.push('read');return{users:[],version:'a'.repeat(64)};},setDashboardAudience:async(key:string,ids:string[],version:string)=>{calls.push('write');return{key,ids,version};}},
    '@/shared/lib/db/securityAuditRepo':{recordSecurityEvent:async()=>calls.push('audit')},
    '@/shared/lib/originProtection':{enforceSameOriginRequest},
    '@/shared/lib/managerDashboardSecurity':{readPersonalRequestBytes},
  };
  const code=ts.transpileModule(readFileSync('src/app/api/admin/dashboard-access/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const loaded={exports:{} as {GET:(r:Request)=>Promise<Response>;PUT:(r:Request)=>Promise<Response>}};
  new Function('require','module','exports',code)((key:string)=>{assert.ok(key in modules,key);return modules[key];},loaded,loaded.exports);
  return{...loaded.exports,calls};
}
test('only current site admins can assign report audiences, with same-origin and bounded validated body',async()=>{
  const request=(overrides:Record<string,unknown>={},origin='https://example.test')=>new Request('https://example.test/api/admin/dashboard-access',{method:'PUT',headers:{origin,'content-type':'application/json'},body:JSON.stringify({key:'top:7',userIds:['manager:2'],version:'a'.repeat(64),...overrides})});
  const denied=audienceRoute(false);assert.equal((await denied.GET(new Request('https://example.test?key=top:7'))).status,403);
  assert.equal((await denied.PUT(request())).status,403);assert.deepEqual(denied.calls,[]);
  const api=audienceRoute();assert.equal((await api.PUT(request({},'https://evil.test'))).status,403);
  for(const body of [{key:'top:*'},{version:undefined},{userIds:['*']},{userIds:['manager:0']}])assert.equal((await api.PUT(request(body))).status,400);
  const large=new Request('https://example.test/api/admin/dashboard-access',{method:'PUT',headers:{origin:'https://example.test'},body:' '.repeat(128*1024+1)});
  assert.equal((await api.PUT(large)).status,400);assert.deepEqual(api.calls,[]);
  assert.equal((await api.PUT(request())).status,200);assert.deepEqual(api.calls,['write','audit']);
});
