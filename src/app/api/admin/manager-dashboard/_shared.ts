import { getAdminSession } from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { getWholesaleManagerById } from '@/shared/lib/db/wholesaleAdminRepo/managerRepo';
import { personalDashboardMode, personalDashboardAudienceSelection, PERSONAL_PRIVATE_HEADERS, readPersonalRequestBytes } from '@/shared/lib/managerDashboardSecurity';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';

export function personalJson(value: unknown, status = 200) {
  return Response.json(value, {status, headers: PERSONAL_PRIVATE_HEADERS});
}

export async function requirePersonalAccess(request?: Request, manageOnly = false) {
  const session = await getAdminSession();
  const mode = personalDashboardMode(session);
  if (!session || !mode || (manageOnly && mode !== 'manage')) {
    return {denied: personalJson({error: 'Нет доступа к личному дашборду. При необходимости войдите заново.'}, session ? 403 : 401)} as const;
  }
  const manager = mode === 'view' ? await getWholesaleManagerById(session.managerId!) : null;
  if (mode === 'view' && (!manager || !manager.isActive || manager.role !== session.role || (manager.role !== 'manager' && manager.role !== 'support_manager'))) {
    return {denied: personalJson({error: 'Учётная запись менеджера недоступна'}, 403)} as const;
  }
  if (request && request.method !== 'GET') {
    const originError = enforceSameOriginRequest(request);
    if (originError) return {denied: originError} as const;
    const limited = await enforceAdminActionRateLimit(session, 'personal_dashboard_write', 30, 10 * 60 * 1000);
    if (limited) return {denied: limited} as const;
  }
  return {session, mode, manager, actorId: `${session.role}:${session.adminUserId ?? session.sessionId}`, denied: null} as const;
}

export function personalRequestAudience(request: Request, access: { mode: 'manage' | 'view'; manager: { role: string } | null }) {
  const params = new URL(request.url).searchParams;
  if (params.getAll('audience').length > 1) return null;
  return personalDashboardAudienceSelection(access.mode, access.manager?.role, params.get('audience'));
}

export async function personalMultipart(request: Request, maxBytes: number) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;')) throw new Error('BAD_MULTIPART');
  const bytes = await readPersonalRequestBytes(request, maxBytes);
  try {
    return await new Response(bytes as Uint8Array<ArrayBuffer>, {headers: {'content-type': request.headers.get('content-type')!}}).formData();
  } catch {
    throw new Error('BAD_MULTIPART');
  }
}

export function personalApiError(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : '';
  if (message === 'REQUEST_TOO_LARGE') return personalJson({error: 'Превышен допустимый размер запроса'}, 413);
  if (message === 'BAD_MULTIPART') return personalJson({error: 'Нужна загрузка файлов multipart/form-data'}, 400);
  // Domain messages are authored safe text, never library/network errors.
  if (error instanceof Error && error.name === 'PersonalDashboardError') {
    return personalJson({error: message, code}, /conflict|stale/i.test(code) ? 409 : /limit|quota|size/i.test(code) ? 413 : 400);
  }
  console.error('Personal dashboard operation failed', {category: 'internal'});
  return personalJson({error: 'Не удалось выполнить операцию личного дашборда'}, 500);
}
