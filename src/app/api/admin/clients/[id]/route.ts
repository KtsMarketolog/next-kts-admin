import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { hashPassword, requireEmployee } from '@/shared/lib/adminAuth';
import {
  deleteClientCompany,
  revokeClientUserSessions,
  updateClientCompany,
  updateWholesalePriceListManagerAssignmentsForClientCompany,
  type ClientCompanyInput,
} from '@/shared/lib/db';
import { publishClientRealtimeEvent } from '@/shared/lib/clientRealtime';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';
import { getClientIp } from '@/shared/lib/rateLimit';
import { normalizeTextField } from '@/shared/lib/wholesaleSecurity';

type Context = {
  params: Promise<{ id: string }>;
};

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

export async function PUT(request: Request, context: Context) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return Response.json({ error: 'Некорректная компания клиента' }, { status: 400 });
  }

  const limited = await enforceAdminActionRateLimit(session, 'client_company_update', 100);
  if (limited) return limited;

  const body = await request.json().catch(() => ({}));
  const password = typeof body.password === 'string' ? body.password.trim() : '';
  const passwordPolicy = password ? validatePasswordPolicy(password) : { ok: true };
  if (!passwordPolicy.ok) {
    return Response.json({ error: passwordPolicy.error || 'Пароль не подходит' }, { status: 400 });
  }

  const input = inputFromBody(body, password ? hashPassword(password) : undefined);
  if (!input.title) {
    return Response.json({ error: 'Введите название компании' }, { status: 400 });
  }
  if (!input.email) {
    return Response.json({ error: 'Введите email клиента для входа' }, { status: 400 });
  }

  try {
    const company = await updateClientCompany(numericId, input, session);
    await updateWholesalePriceListManagerAssignmentsForClientCompany(
      company.id,
      { managerId: company.managerId, supportManagerId: company.supportManagerId },
      session,
    );
    publishClientRealtimeEvent({ type: 'client.updated', companyId: company.id });
    if (password && company.clientUserId) {
      await revokeClientUserSessions(company.clientUserId);
    }
    await recordSecurityEvent({
      eventType: 'client_company_updated',
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
      { error: error instanceof Error ? error.message : 'Не удалось сохранить компанию клиента' },
      { status: 400 },
    );
  }
}

export async function DELETE(request: Request, context: Context) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;
  const forbiddenOrigin = enforceSameOriginRequest(request);
  if (forbiddenOrigin) return forbiddenOrigin;

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    return Response.json({ error: 'Некорректная компания клиента' }, { status: 400 });
  }

  const limited = await enforceAdminActionRateLimit(session, 'client_company_delete', 30);
  if (limited) return limited;

  try {
    const company = await deleteClientCompany(numericId, session);
    publishClientRealtimeEvent({ type: 'client.updated', companyId: company.id });
    await recordSecurityEvent({
      eventType: 'client_company_deleted',
      actorType: session.role === 'admin' ? 'admin' : session.role === 'wholesale_admin' ? 'wholesale_admin' : 'manager',
      adminUserId: session.adminUserId,
      managerId: session.managerId,
      sessionId: session.sessionId,
      entityType: 'client_company',
      entityId: company.id,
      ip: getClientIp(request),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: { title: company.title, userCount: company.userCount },
    });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : 'Не удалось удалить компанию клиента' },
      { status: 400 },
    );
  }
}
