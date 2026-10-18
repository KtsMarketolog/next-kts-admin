import type { ClientCompany } from './AdminClientsModel';

const unknownOutcome = 'Не удалось подтвердить результат операции. Обновите данные перед повторной попыткой.';

export async function submitClientMutation(url: string, init: RequestInit) {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    // The request may already have committed before the response was lost.
    throw new Error(unknownOutcome);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(typeof data?.error === 'string' && data.error ? data.error : unknownOutcome);
  }
  const warnings: string[] = Array.isArray(data?.warnings)
    ? data.warnings.flatMap((warning: unknown) => (
      warning && typeof warning === 'object' && 'message' in warning && typeof warning.message === 'string'
        ? [warning.message] : []
    )) : [];
  if (!data) warnings.push('Ответ с обновлёнными данными не получен. Обновите список перед дальнейшим редактированием.');
  return { company: data?.company as ClientCompany | undefined, warnings };
}
