export type LoginMode = 'client' | 'employee';

type LoginPayload = { login: string; password: string } | { twoFactorChallengeId: string; twoFactorCode: string };

type LoginResult =
  | { kind: 'error'; message: string }
  | { kind: 'challenge'; challengeId: string; email: string }
  | { kind: 'success'; role?: string };

export const LOGIN_SERVER_ERROR = 'Сервис входа временно недоступен. Попробуйте позже.';
export const LOGIN_NETWORK_ERROR = 'Не удалось связаться с сервером. Проверьте подключение и попробуйте ещё раз.';
export const LOGIN_DELIVERY_ERROR = 'Не удалось отправить код подтверждения на почту. Попробуйте позже.';

export async function requestLogin(
  mode: LoginMode,
  payload: LoginPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<LoginResult> {
  let response: Response;
  try {
    response = await fetchImpl(mode === 'client' ? '/api/client/login' : '/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return { kind: 'error', message: LOGIN_NETWORK_ERROR };
  }

  const body: unknown = await response.json().catch(() => null);
  const data = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;

  if (!response.ok) {
    if (response.status === 429) {
      return { kind: 'error', message: 'Слишком много попыток. Попробуйте позже.' };
    }
    if (response.status === 503 && data?.code === 'TWO_FACTOR_DELIVERY_FAILED') {
      return { kind: 'error', message: LOGIN_DELIVERY_ERROR };
    }
    if (response.status === 401) {
      return {
        kind: 'error',
        message: 'twoFactorChallengeId' in payload
          ? 'Код неверен или больше не действует. Введите пароль заново, чтобы получить новый.'
          : 'Неверный логин или пароль',
      };
    }
    return { kind: 'error', message: LOGIN_SERVER_ERROR };
  }

  if (data?.twoFactorRequired === true && typeof data.challengeId === 'string' && data.challengeId) {
    return { kind: 'challenge', challengeId: data.challengeId, email: typeof data.email === 'string' ? data.email : '' };
  }
  if (data?.ok !== true || data.twoFactorRequired) {
    return { kind: 'error', message: LOGIN_SERVER_ERROR };
  }
  return { kind: 'success', role: typeof data.role === 'string' ? data.role : undefined };
}
