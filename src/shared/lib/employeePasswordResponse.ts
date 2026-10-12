import type { AdminSession } from './adminAuth';
import { enforceAdminActionRateLimit } from './adminSecurity';
import { parseEmployeePasswordIdentity, readEmployeePassword } from './db/employeePasswordRepo';
import { recordSecurityEvent } from './db/securityAuditRepo';
import { enforceSameOriginRequest } from './originProtection';
import { getClientIp } from './rateLimit';

export function uncachedPasswordResponse(response: Response) {
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Vary', 'Cookie');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}

async function readLegacyCandidate(request: Request): Promise<{ password?: string; invalid?: boolean }> {
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) { await reader.cancel().catch(() => {}); return { invalid: true }; }
      chunks.push(value);
    }
    if (!size) return {};
    const body: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { invalid: true };
    const password = (body as { legacyPassword?: unknown }).legacyPassword;
    if (password === undefined) return {};
    if (typeof password !== 'string' || !password || password.length > 200) return { invalid: true };
    return { password };
  } catch { return { invalid: true }; }
  finally { reader.releaseLock(); }
}

export async function employeePasswordResponse(request: Request, value: string, session: AdminSession) {
  const identity = parseEmployeePasswordIdentity(value);
  // Defence in depth: access management alone (Admin TOP) does not grant password disclosure.
  if (!identity || (session.role !== 'admin' && !(session.role === 'wholesale_admin' && identity.source === 'manager'))) {
    return uncachedPasswordResponse(Response.json({ error: 'Недостаточно прав или неверный сотрудник' }, { status: 403 }));
  }
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return uncachedPasswordResponse(forbiddenOrigin);

  try {
    const limited = await enforceAdminActionRateLimit(session, 'employee_password_view', 120);
    if (limited) return uncachedPasswordResponse(limited);
    const candidate = await readLegacyCandidate(request);
    if (candidate.invalid) return uncachedPasswordResponse(Response.json({ error: 'Некорректный запрос пароля' }, { status: 400 }));
    const result = await readEmployeePassword(identity, candidate.password);
    if (!result) return uncachedPasswordResponse(Response.json({ error: 'Сотрудник не найден' }, { status: 404 }));
    await recordSecurityEvent({
      eventType: 'employee_password_viewed',
      actorType: session.role === 'admin' ? 'admin' : 'wholesale_admin',
      adminUserId: session.adminUserId,
      sessionId: session.sessionId,
      entityType: identity.source === 'admin' ? 'admin_user' : 'wholesale_manager',
      entityId: identity.id,
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      metadata: { available: result.password !== null },
    }, { required: true });
    return uncachedPasswordResponse(Response.json(result));
  } catch {
    // No password, hash, ciphertext or encryption configuration in error responses/logs.
    return uncachedPasswordResponse(Response.json({ error: 'Не удалось получить актуальный пароль с сервера. Повторите позже.' }, { status: 503 }));
  }
}
