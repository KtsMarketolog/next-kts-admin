import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { hashPassword, requireWholesaleAdmin, requireWholesaleAdminSession } from '@/shared/lib/adminAuth';
import { createWholesaleManager, getWholesaleManagers } from '@/shared/lib/db';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';
import { getClientIp } from '@/shared/lib/rateLimit';
import { normalizeTextField } from '@/shared/lib/wholesaleSecurity';

export async function GET() {
  const denied = await requireWholesaleAdmin();
  if (denied) return denied;

  const managers = await getWholesaleManagers();
  return Response.json({ managers });
}

export async function POST(request: Request) {
  const { denied, session } = await requireWholesaleAdminSession();
  if (denied) return denied;
  const limited = await enforceAdminActionRateLimit(session, 'manager_create', 40);
  if (limited) return limited;

  const body = await request.json().catch(() => ({}));
  const name = normalizeTextField(body.name, 120);
  const login = normalizeTextField(body.login, 80);
  const email = normalizeTextField(body.email, 160);
  const password = typeof body.password === 'string' ? body.password : '';

  if (!name || !login || !password) {
    return Response.json({ error: 'Name, login and password are required' }, { status: 400 });
  }
  const passwordPolicy = validatePasswordPolicy(password);
  if (!passwordPolicy.ok) {
    return Response.json({ error: passwordPolicy.error }, { status: 400 });
  }

  const id = await createWholesaleManager({
    name,
    login,
    email,
    passwordHash: hashPassword(password),
    isActive: Boolean(body.isActive ?? true),
  });

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
    metadata: { login, email },
  });

  return Response.json({ id });
}
