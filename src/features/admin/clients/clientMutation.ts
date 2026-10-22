import { withoutClientCredentials, type ClientCompany } from './AdminClientsModel';
import { adminRequest, AdminRequestError } from '../shared/adminRequest';

const unknownOutcome = 'Не удалось подтвердить результат операции. Обновите данные перед повторной попыткой.';

export class ClientMutationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ClientMutationError';
  }
}

export async function submitClientMutation(url: string, init: RequestInit, request = adminRequest) {
  let response: Response;
  try {
    response = await request(url, init);
  } catch (error) {
    // The request may already have committed before the response was lost.
    throw error instanceof AdminRequestError ? error : new Error(unknownOutcome);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ClientMutationError(typeof data?.error === 'string' && data.error ? data.error : unknownOutcome, response.status);
  }
  const warnings: string[] = Array.isArray(data?.warnings)
    ? data.warnings.flatMap((warning: unknown) => (
      warning && typeof warning === 'object' && 'message' in warning && typeof warning.message === 'string'
        ? [warning.message] : []
    )) : [];
  if (!data) warnings.push('Ответ с обновлёнными данными не получен. Обновите список перед дальнейшим редактированием.');
  return { company: data?.company ? withoutClientCredentials(data.company as ClientCompany) : undefined, warnings };
}
