export class EmployeeIdentifierConflictError extends Error {
  readonly code = 'EMPLOYEE_IDENTIFIER_CONFLICT';
  constructor() {
    super('Этот логин или email уже используется другой учётной записью сотрудника. Укажите другое значение.');
  }
}

const IDENTIFIER_CONSTRAINTS = new Set([
  'employee_login_identifiers_unique',
  'admin_users_login_key',
  'wholesale_managers_login_key',
]);

/** Do not expose PostgreSQL DETAIL: it includes the conflicting identifier. */
export function rethrowEmployeeIdentifierConflict(error: unknown): never {
  const databaseError = error as { code?: string; constraint?: string } | null;
  if (databaseError?.code === '23505' && IDENTIFIER_CONSTRAINTS.has(databaseError.constraint ?? '')) {
    throw new EmployeeIdentifierConflictError();
  }
  throw error;
}
