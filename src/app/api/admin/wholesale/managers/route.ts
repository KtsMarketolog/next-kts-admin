import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { hashPassword, requireEmployee, requireWholesaleAdminSession } from '@/shared/lib/adminAuth';
import { createWholesaleManager, getWholesaleManagers } from '@/shared/lib/db';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';
import { getClientIp } from '@/shared/lib/rateLimit';
import { normalizeTextField } from '@/shared/lib/wholesaleSecurity';

export async function GET() {
  const { denied } = await requireEmployee();
  if (denied) return denied;

  const managers = await getWholesaleManagers();
  return Response.json({ managers });
}

export async function POST(request: Request) {
  const { denied, session } = await requireWholesaleAdminSession();
  if (denied) return denied;
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const limited = await enforceAdminActionRateLimit(session, 'manager_create', 40);
  if (limited) return limited;

  const body = await request.json().catch(() => ({}));
  const name = normalizeTextField(body.name, 120);
  const login = normalizeTextField(body.login, 80);
  const email = normalizeTextField(body.email, 160);
  const phone = normalizeTextField(body.phone, 60);
  const password = typeof body.password === 'string' ? body.password : '';
  const role = body.role === 'support_manager' ? 'support_manager' : 'manager';
  const normalizedSupportManagerId = null;
  const hasCanAccessTopDashboard = Object.prototype.hasOwnProperty.call(body, 'canAccessTopDashboard');
  if (hasCanAccessTopDashboard && typeof body.canAccessTopDashboard !== 'boolean') {
    return Response.json({ error: 'Доступ TOP должен быть указан как да или нет' }, { status: 400 });
  }
  const canAccessTopDashboard = hasCanAccessTopDashboard ? body.canAccessTopDashboard : false;

  if (!name || !login || !password) {
    return Response.json({ error: 'Имя, логин и пароль обязательны' }, { status: 400 });
  }
  const passwordPolicy = validatePasswordPolicy(password);
  if (!passwordPolicy.ok) {
    return Response.json({ error: passwordPolicy.error }, { status: 400 });
  }

  let id: number;
  try {
    id = await createWholesaleManager({
      name,
      login,
      email,
      phone,
      role,
      supportManagerId: normalizedSupportManagerId,
      passwordHash: hashPassword(password),
      displayPassword: password,
      isActive: Boolean(body.isActive ?? true),
      canAccessTopDashboard,
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Не удалось добавить менеджера' }, { status: 400 });
  }

  await recordSecurityEvent({
    eventType: 'manager_created',
    actorType: session.role === 'admin' ? 'admin' : 'wholesale_admin',
    adminUserId: session.adminUserId,
    sessionId: session.sessionId,
    entityType: 'wholesale_manager',
    entityId: id,
    ip: getClientIp(request),
    userAgent: request.headers.get('user-agent'),
    referer: request.headers.get('referer'),
    metadata: {
      login,
      email,
      phone,
      role,
      supportManagerId: normalizedSupportManagerId,
      canAccessTopDashboard,
    },
  });

  return Response.json({ id });
}
