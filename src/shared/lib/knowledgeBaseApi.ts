import { getAdminSession, type AdminSession } from './adminAuth';
import { enforceAdminActionRateLimit } from './adminSecurity';
import { enforceSameOriginRequest } from './originProtection';
import { createUploadRequestGuard, UploadRequestError } from './uploadRequestGuard';
import { canAccessKnowledgeBase, canManageKnowledgeBase, KnowledgeBaseError, knowledgeBaseInvalid } from './knowledgeBase';
import { TransactionCommitUnknownError } from './db/transactionOutcome';

export function knowledgeBasePrivateResponse(response: Response) {
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Vary', 'Cookie');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

export async function knowledgeBaseRoute(request: Request,
  options: { manage?: boolean; mutation?: boolean; action: string; limit?: number },
  execute: (session: AdminSession) => Promise<Response>) {
  try {
    const session = await getAdminSession();
    if (!canAccessKnowledgeBase(session)) throw new KnowledgeBaseError(401, 'UNAUTHORIZED', 'Необходимо войти');
    if (options.manage && !canManageKnowledgeBase(session)) throw new KnowledgeBaseError(403, 'FORBIDDEN', 'Недостаточно прав');
    if (options.mutation) {
      const denied = enforceSameOriginRequest(request);
      if (denied) return knowledgeBasePrivateResponse(denied);
    }
    const limited = await enforceAdminActionRateLimit(session, `knowledge_base_${options.action}`, options.limit ?? 120);
    if (limited) return knowledgeBasePrivateResponse(limited);
    return knowledgeBasePrivateResponse(await execute(session));
  } catch (error) {
    if (error instanceof TransactionCommitUnknownError) {
      return knowledgeBasePrivateResponse(Response.json({ error: 'Изменение могло сохраниться. Обновите данные перед повторной попыткой.', code: error.code }, { status: 503 }));
    }
    if (error instanceof KnowledgeBaseError || error instanceof UploadRequestError) {
      return knowledgeBasePrivateResponse(Response.json({ error: error.message, code: error.code }, { status: error.status }));
    }
    // Storage paths, source contents and database details are never returned.
    return knowledgeBasePrivateResponse(Response.json({ error: 'Не удалось выполнить операцию. Повторите позже.' }, { status: 503 }));
  }
}

export function knowledgeBaseQueryId(value: string | null, optional = false): number | undefined {
  if (optional && value === null) return undefined;
  if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw knowledgeBaseInvalid();
  return Number(value);
}

export function knowledgeBaseQueryBoolean(value: string | null) {
  if (value === null || value === 'false' || value === '0') return false;
  if (value === 'true' || value === '1') return true;
  throw knowledgeBaseInvalid();
}

export function knowledgeBaseObject(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) throw knowledgeBaseInvalid();
  return value as Record<string, unknown>;
}

export async function readKnowledgeBaseJson(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw knowledgeBaseInvalid();
  const guard = createUploadRequestGuard(request, { maxBytes: 64 * 1024, idleTimeoutMs: 10_000, totalTimeoutMs: 15_000 });
  try {
    if (!guard.request.body) throw knowledgeBaseInvalid();
    const reader = guard.request.body.getReader();
    const bytes = new Uint8Array(64 * 1024);
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes.set(value, size); size += value.length;
      }
    } finally { reader.releaseLock(); }
    guard.assertActive();
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))) as unknown; }
    catch { throw knowledgeBaseInvalid(); }
  } finally { guard.dispose(); }
}
