import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { hashPassword, requireEmployee } from '@/shared/lib/adminAuth';
import {
  deleteClientCompany,
  getClientCompany,
  ClientArchiveConflictError,
  updateClientCompany,
  type ClientCompanyInput,
} from '@/shared/lib/db';
import { publishClientRealtimeEvent } from '@/shared/lib/clientRealtime';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';
import { getClientIp } from '@/shared/lib/rateLimit';
import { normalizeTextField } from '@/shared/lib/wholesaleSecurity';
import { runPostCommitTasks } from '@/shared/lib/postCommitTasks';
import { TransactionCommitUnknownError } from '@/shared/lib/db/transactionOutcome';

type Context = {
  params: Promise<{ id: string }>;
};

function managerIdFromBody(value: unknown) {
  const managerId = Number(value);
  return Number.isInteger(managerId) && managerId > 0 ? managerId : null;
}

function inputFromBody(body: Record<string, unknown>, passwordHash?: string, displayPassword?: string): ClientCompanyInput {
  return {
    expectedUpdatedAt: typeof body.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt : undefined,
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
    requireTwoFactor: body.requireTwoFactor === true,
    isActive: body.isActive !== false,
    passwordHash,
    displayPassword,
  };
}

export async function GET(_request: Request, context: Context) {
  const headers = { 'Cache-Control': 'private, no-store' };
  const { denied, session } = await requireEmployee();
  if (denied) {
    denied.headers.set('Cache-Control', headers['Cache-Control']);
    return denied;
  }

  const { id } = await context.params;
  const numericId = Number(id);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    return Response.json({ error: 'Некорректная компания клиента' }, { status: 400, headers });
  }

  try {
    const company = await getClientCompany(numericId, session);
    if (!company) return Response.json({ error: 'Клиент не найден или недоступен' }, { status: 404, headers });
    // The read-only detail screen does not need password rotation metadata.
    return Response.json({ company: { ...company, passwordChangedAt: undefined } }, { headers });
  } catch {
    return Response.json({ error: 'Не удалось загрузить клиента. Попробуйте обновить страницу.' }, { status: 503, headers });
  }
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
  if (typeof body.expectedUpdatedAt !== 'string' || body.expectedUpdatedAt.length > 64 || !Number.isFinite(Date.parse(body.expectedUpdatedAt))) {
    return Response.json({ saved: false, error: 'Обновите данные клиента перед сохранением.' }, { status: 428 });
  }
  const password = typeof body.password === 'string' ? body.password.trim() : '';
  const passwordPolicy = password ? validatePasswordPolicy(password) : { ok: true };
  if (!passwordPolicy.ok) {
    return Response.json({ error: passwordPolicy.error || 'Пароль не подходит' }, { status: 400 });
  }

  const input = inputFromBody(body, password ? hashPassword(password) : undefined, password || undefined);
  if (!input.title) {
    return Response.json({ error: 'Введите название компании' }, { status: 400 });
  }
  if (!input.email) {
    return Response.json({ error: 'Введите email клиента для входа' }, { status: 400 });
  }

  try {
    const company = await updateClientCompany(numericId, input, session);
    const actorType = session.role === 'admin' ? 'admin' : session.role === 'wholesale_admin' ? 'wholesale_admin' : 'manager';
    const warnings = await runPostCommitTasks([
      {
        code: 'CLIENT_REALTIME_UNAVAILABLE',
        message: 'Клиент сохранён, но уведомление других открытых страниц не отправлено. Обновите их вручную.',
        run: () => publishClientRealtimeEvent({ type: 'client.updated', companyId: company.id }),
      },
      ...(password && company.clientUserId ? [{
        code: 'CLIENT_PASSWORD_AUDIT_UNAVAILABLE',
        message: 'Пароль сохранён, но запись о его смене в журнал не добавлена. Требуется повторить журналирование.',
        run: () => recordSecurityEvent({
          eventType: 'password_changed',
          actorType,
          adminUserId: session.adminUserId,
          managerId: session.managerId,
          sessionId: session.sessionId,
          entityType: 'client_user',
          entityId: company.clientUserId,
          ip: getClientIp(request),
          userAgent: request.headers.get('user-agent'),
          referer: request.headers.get('referer'),
          metadata: { companyId: company.id, title: company.title, source: 'admin_clients' },
        }, { required: true }),
      }] : []),
      {
        code: 'CLIENT_UPDATE_AUDIT_UNAVAILABLE',
        message: 'Клиент сохранён, но запись об изменении в журнал не добавлена. Требуется повторить журналирование.',
        run: () => recordSecurityEvent({
          eventType: 'client_company_updated',
          actorType,
          adminUserId: session.adminUserId,
          managerId: session.managerId,
          sessionId: session.sessionId,
          entityType: 'client_company',
          entityId: company.id,
          ip: getClientIp(request),
          userAgent: request.headers.get('user-agent'),
          referer: request.headers.get('referer'),
          metadata: { title: company.title, managerId: company.managerId, supportManagerId: company.supportManagerId },
        }, { required: true }),
      },
    ]);
    return Response.json({ company, saved: true, warnings });
  } catch (error) {
    if (error instanceof ClientArchiveConflictError) {
      return Response.json({ saved: false, error: error.message }, { status: 409 });
    }
    if (error instanceof TransactionCommitUnknownError) {
      return Response.json({ saved: null, code: 'COMMIT_OUTCOME_UNKNOWN', error: 'Не удалось подтвердить результат сохранения. Обновите данные перед повторной попыткой.' }, { status: 503 });
    }
    return Response.json(
      { saved: false, error: error instanceof Error ? error.message : 'Не удалось сохранить компанию клиента' },
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

  const body = await request.json().catch(() => null);
  const expectedUpdatedAt = body?.expectedUpdatedAt;
  if (typeof expectedUpdatedAt !== 'string' || expectedUpdatedAt.length > 64 || !Number.isFinite(Date.parse(expectedUpdatedAt))) {
    return Response.json({ saved: false, error: 'Обновите страницу перед архивированием клиента.' }, { status: 428 });
  }

  try {
    const company = await deleteClientCompany(numericId, session, expectedUpdatedAt);
    const warnings = await runPostCommitTasks([
      {
        code: 'CLIENT_REALTIME_UNAVAILABLE',
        message: 'Клиент перенесён в архив, но уведомление других открытых страниц не отправлено. Обновите их вручную.',
        run: () => publishClientRealtimeEvent({ type: 'client.updated', companyId: company.id }),
      },
      {
        code: 'CLIENT_ARCHIVE_AUDIT_UNAVAILABLE',
        message: 'Клиент перенесён в архив, но запись в журнал не добавлена. Требуется повторить журналирование.',
        run: () => recordSecurityEvent({
          eventType: 'client_company_archived',
          actorType: session.role === 'admin' ? 'admin' : session.role === 'wholesale_admin' ? 'wholesale_admin' : 'manager',
          adminUserId: session.adminUserId,
          managerId: session.managerId,
          sessionId: session.sessionId,
          entityType: 'client_company',
          entityId: company.id,
          ip: getClientIp(request),
          userAgent: request.headers.get('user-agent'),
          referer: request.headers.get('referer'),
          metadata: { title: company.title, userCount: company.userCount, archivedAt: company.archivedAt, automaticPurge: false },
        }, { required: true }),
      },
    ]);
    return Response.json({ ok: true, saved: true, company, warnings });
  } catch (error) {
    if (error instanceof ClientArchiveConflictError) {
      return Response.json({ saved: false, error: error.message }, { status: 409 });
    }
    if (error instanceof TransactionCommitUnknownError) {
      return Response.json({ saved: null, code: 'COMMIT_OUTCOME_UNKNOWN', error: 'Не удалось подтвердить результат архивирования. Обновите данные перед повторной попыткой.' }, { status: 503 });
    }
    return Response.json(
      { saved: false, error: error instanceof Error ? error.message : 'Не удалось архивировать клиента' },
      { status: 400 },
    );
  }
}
