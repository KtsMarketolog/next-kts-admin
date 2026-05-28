import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { hashPassword, requireEmployee } from '@/shared/lib/adminAuth';
import { createClientCompany, getClientCompanies, type ClientCompanyInput } from '@/shared/lib/db';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';
import { getClientIp } from '@/shared/lib/rateLimit';
import { normalizeTextField } from '@/shared/lib/wholesaleSecurity';

function managerIdFromBody(value: unknown) {
  const managerId = Number(value);
  return Number.isInteger(managerId) && managerId > 0 ? managerId : null;
}

function inputFromBody(body: Record<string, unknown>, passwordHash?: string): ClientCompanyInput {
  return {
    title: normalizeTextField(body.title, 200),
    inn: '',
    kpp: '',
    contactName: '',
    email: normalizeTextField(body.email, 180),
    phone: normalizeTextField(body.phone, 80),
    address: '',
    note: normalizeTextField(body.note, 2000),
    managerId: managerIdFromBody(body.managerId),
    supportManagerId: managerIdFromBody(body.supportManagerId),
    isActive: body.isActive !== false,
    passwordHash,
  };
}

export async function GET() {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;

  const companies = await getClientCompanies(session);
  return Response.json({ companies });
}

export async function POST(request: Request) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const limited = await enforceAdminActionRateLimit(session, 'client_company_create', 60);
  if (limited) return limited;

  const body = await request.json().catch(() => ({}));
  const password = typeof body.password === 'string' ? body.password : '';
  if (!password) {
    return Response.json({ error: 'Введите пароль клиента' }, { status: 400 });
  }
  const passwordPolicy = validatePasswordPolicy(password);
  if (!passwordPolicy.ok) {
    return Response.json({ error: passwordPolicy.error || 'Пароль не подходит' }, { status: 400 });
  }

  const input = inputFromBody(body, hashPassword(password));
  if (!input.title) {
    return Response.json({ error: 'Введите название компании' }, { status: 400 });
  }
  if (!input.email) {
    return Response.json({ error: 'Введите email клиента для входа' }, { status: 400 });
  }

  try {
    const company = await createClientCompany(input, session);
    await recordSecurityEvent({
      eventType: 'client_company_created',
      actorType: session.role === 'admin' ? 'admin' : session.role === 'wholesale_admin' ? 'wholesale_admin' : 'manager',
      adminUserId: session.adminUserId,
      managerId: session.managerId,
      sessionId: session.sessionId,
      entityType: 'client_company',
      entityId: company.id,
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: { title: company.title, managerId: company.managerId, supportManagerId: company.supportManagerId },
    });
    return Response.json({ company });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Не удалось добавить компанию клиента' },
      { status: 400 },
    );
  }
}
