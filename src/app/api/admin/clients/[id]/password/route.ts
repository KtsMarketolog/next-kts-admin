import { isManagerSessionRole, isOperationalEmployeeSessionRole, requireEmployee } from '@/shared/lib/adminAuth';
import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { readClientCompanyPassword } from '@/shared/lib/db/clientPasswordRepo';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';

function uncached(response: Response) {
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Vary', 'Cookie');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { denied, session } = await requireEmployee();
    if (denied) return uncached(denied);
    // Dashboard/access-management permissions do not grant client password access.
    if (!session || !isOperationalEmployeeSessionRole(session.role)) {
      return uncached(Response.json({ error: 'Недостаточно прав' }, { status: 403 }));
    }
    const { id } = await context.params;
    const companyId = Number(id);
    if (!Number.isSafeInteger(companyId) || companyId <= 0 || String(companyId) !== id) {
      return uncached(Response.json({ error: 'Некорректная компания клиента' }, { status: 400 }));
    }
    const forbiddenOrigin = enforceSameOriginRequest(request);
    if (forbiddenOrigin) return uncached(forbiddenOrigin);
    const limited = await enforceAdminActionRateLimit(session, 'client_password_view', 120);
    if (limited) return uncached(limited);

    // Never recover a password from the request/browser; read the current scoped server copy.
    const result = await readClientCompanyPassword(companyId, session);
    if (!result) return uncached(Response.json({ error: 'Клиент не найден' }, { status: 404 }));
    const manager = isManagerSessionRole(session.role);
    await recordSecurityEvent({
      eventType: 'client_password_viewed',
      actorType: manager ? 'manager' : session.role === 'admin' ? 'admin' : 'wholesale_admin',
      adminUserId: manager ? null : session.adminUserId,
      managerId: manager ? session.managerId : null,
      sessionId: session.sessionId,
      entityType: 'client_user',
      entityId: result.clientUserId,
      metadata: { companyId, available: result.password !== null },
    }, { required: true });
    return uncached(Response.json({ password: result.password }));
  } catch {
    // No password, hash, ciphertext or encryption configuration in errors or logs.
    return uncached(Response.json({ error: 'Не удалось получить актуальный пароль с сервера. Повторите позже.' }, { status: 503 }));
  }
}
