import { enforceAdminActionRateLimit } from '@/shared/lib/adminSecurity';
import { hashPassword, requireEmployee } from '@/shared/lib/adminAuth';
import { createClientCompany, getClientCompanies, type ClientCompanyInput } from '@/shared/lib/db';
import { publishClientRealtimeEvent } from '@/shared/lib/clientRealtime';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { enforceSameOriginRequest } from '@/shared/lib/originProtection';
import { validatePasswordPolicy } from '@/shared/lib/passwordPolicy';
import { getClientIp } from '@/shared/lib/rateLimit';
import { normalizeTextField } from '@/shared/lib/wholesaleSecurity';
import { runPostCommitTasks } from '@/shared/lib/postCommitTasks';
import { TransactionCommitUnknownError } from '@/shared/lib/db/transactionOutcome';

function managerIdFromBody(value: unknown) {
  const managerId = Number(value);
  return Number.isInteger(managerId) && managerId > 0 ? managerId : null;
}

function inputFromBody(body: Record<string, unknown>, passwordHash?: string, displayPassword?: string): ClientCompanyInput {
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
    requireTwoFactor: body.requireTwoFactor === true,
    isActive: body.isActive !== false,
    passwordHash,
    displayPassword,
  };
}

export async function GET(request: Request) {
  const { denied, session } = await requireEmployee();
  if (denied) return denied;

  const scope = new URL(request.url).searchParams.get('scope') || 'active';
  if (scope !== 'active' && scope !== 'archived' && scope !== 'all') {
    return Response.json({ error: 'Некорректный раздел клиентов' }, { status: 400 });
  }
  const companies = await getClientCompanies(session, scope);
  return Response.json({ companies, canPermanentlyDelete: session.role === 'admin' || session.role === 'wholesale_admin' });
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

  const input = inputFromBody(body, hashPassword(password), password);
  if (!input.title) {
    return Response.json({ error: 'Введите название компании' }, { status: 400 });
  }
  if (!input.email) {
    return Response.json({ error: 'Введите email клиента для входа' }, { status: 400 });
  }

  try {
    const company = await createClientCompany(input, session);
    const warnings = await runPostCommitTasks([
      {
        code: 'CLIENT_REALTIME_UNAVAILABLE',
        message: 'Клиент создан, но уведомление других открытых страниц не отправлено. Обновите их вручную.',
        run: () => publishClientRealtimeEvent({ type: 'client.updated', companyId: company.id }),
      },
      {
        code: 'CLIENT_CREATE_AUDIT_UNAVAILABLE',
        message: 'Клиент создан, но запись о создании в журнал не добавлена. Требуется повторить журналирование.',
        run: () => recordSecurityEvent({
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
        }, { required: true }),
      },
    ]);
    return Response.json({ company, saved: true, warnings });
  } catch (error) {
    if (error instanceof TransactionCommitUnknownError) {
      return Response.json({ saved: null, code: 'COMMIT_OUTCOME_UNKNOWN', error: 'Не удалось подтвердить результат сохранения. Обновите данные перед повторной попыткой.' }, { status: 503 });
    }
    return Response.json(
      { saved: false, error: error instanceof Error ? error.message : 'Не удалось добавить компанию клиента' },
      { status: 400 },
    );
  }
}
