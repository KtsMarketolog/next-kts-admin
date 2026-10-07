import { getAdminSession, requireAdminSession } from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { canAccessReportsCatalog, canViewDashboard, getSharedDashboardViewer } from '@/shared/lib/dashboardAccess';
import { parseDashboardPairConfig, type DashboardPairOverview, type DashboardPairPanel } from '@/shared/lib/dashboardPair';
import { getDashboardPairConfig, saveDashboardPairConfig } from '@/shared/lib/db/dashboardPairRepo';
import { getPublishedTopDashboardBlocks, getPublishedTopDashboardBlockOverview } from '@/shared/lib/db/topDashboardBlocksRepo';
import { getSupportSharedDashboardOverview } from '@/shared/lib/db/supportSharedDashboardRepo';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const HEADERS = { 'Cache-Control': 'private, no-store' };
const json = (body: unknown, status = 200) => Response.json(body, {status, headers: HEADERS});

async function availableOptions() {
  const blocks = await getPublishedTopDashboardBlocks();
  return [
    ...blocks.map((block) => ({key: `top:${block.id}`, title: block.title})),
    {key: 'route-planner', title: 'Компоновщик рейсов'},
    {key: 'currency-rates', title: 'Курсы валют и медь'},
  ];
}

export async function GET() {
  const session = await getAdminSession();
  if (!session || !canAccessReportsCatalog(session)) return json({error:'Нет доступа к отчётам'}, session ? 403 : 401);
  try {
    const config = await getDashboardPairConfig();
    const canConfigure = session.role === 'admin';
    const panels: DashboardPairPanel[] = await Promise.all((config?.keys ?? []).map(async (key, index) => {
      if (!canViewDashboard(session, key)) {
        return {key:`restricted:${index}`, title:'Отчёт недоступен', available:false, message:'Для этого отчёта администратор должен предоставить доступ.'};
      }
      if (key === 'currency-rates') return {key, title:'Курсы валют и медь', available:true, kind:'currency'};
      if (key === 'route-planner') {
        const shared = await getSupportSharedDashboardOverview(session.role === 'admin' || session.role === 'admintop'
          ? undefined : getSharedDashboardViewer(session));
        const version = shared.htmlVersions.find((item) => item.id === shared.activeHtmlVersionId);
        const snapshotId = version?.format === 'route-planner-v1'
          ? shared.jsonSnapshot?.htmlVersionId === version.id ? shared.jsonSnapshot.id : undefined
          : shared.snapshot?.id;
        return {key, title:'Компоновщик рейсов', available: Boolean(version), kind:'route-planner', versionId:version?.id, snapshotId,
          ...(!version ? {message:'HTML отчёта ещё не опубликован.'} : {})};
      }
      const blockId = Number(key.slice(4));
      const overview = await getPublishedTopDashboardBlockOverview(blockId);
      return {key, title:overview?.block.title ?? 'Отчёт не опубликован', available:Boolean(overview), kind:'top', versionId:overview?.activeVersionId,
        reportRevision:overview?.updatedAt, dataUploadedAt:overview?.dataUploadedAt, dataAsOf:overview?.dataAsOf,
        ...(!overview ? {message:'Опубликованная версия отчёта не найдена.'} : {})};
    }));
    const result: DashboardPairOverview = {
      canConfigure, configured:config !== null, revision:config?.revision ?? 0,
      layout:config?.layout ?? 'columns', panels,
      ...(canConfigure ? {settings:config, options:await availableOptions()} : {}),
    };
    return json(result);
  } catch (error) {
    console.error('Failed to load dashboard pair', error);
    return json({error:'Не удалось открыть пару отчётов'}, 500);
  }
}

export async function PUT(request: Request) {
  const {denied, session} = await requireAdminSession();
  if (denied) return denied;
  const originError = enforceSameOriginRequest(request);
  if (originError) return originError;
  const limited = await enforceAdminActionRateLimit(session, 'dashboard_pair_configure', 30, 10 * 60 * 1000);
  if (limited) return limited;
  // Read a bounded body even if Content-Length is missing or misleading.
  const reader = request.body?.getReader();
  if (!reader) return json({error:'Настройка не передана'}, 400);
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) { await reader.cancel(); return json({error:'Слишком большой запрос'}, 413); }
      chunks.push(value);
    }
  } catch {
    return json({error:'Не удалось прочитать настройку'}, 400);
  } finally {
    reader.releaseLock();
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json({error:'Некорректная настройка'}, 400); }
  const config = parseDashboardPairConfig(parsed);
  if (!config) return json({error:'Выберите два разных отчёта и расположение'}, 400);
  try {
    const options = await availableOptions();
    if (config.keys.some((key) => !options.some((option) => option.key === key))) {
      return json({error:'Один из отчётов больше не опубликован. Обновите страницу.'}, 409);
    }
    const result = await saveDashboardPairConfig(config);
    if (!result) return json({error:'Настройка уже изменена другим администратором. Обновите страницу.'}, 409);
    await recordSecurityEvent({eventType:'dashboard_pair_configured', actorType:'admin', adminUserId:session.adminUserId,
      sessionId:session.sessionId, entityType:'dashboard_pair', entityId:'default',
      metadata:{keys:result.keys, layout:result.layout, revision:result.revision}});
    return json({ok:true, revision:result.revision});
  } catch (error) {
    console.error('Failed to save dashboard pair', error);
    return json({error:'Не удалось сохранить пару отчётов'}, 500);
  }
}
