export type PriceBuildErrorCode =
  | 'PRICE_BUILD_BUSY'
  | 'PRICE_BUILD_TIMEOUT'
  | 'PRICE_BUILD_UNAVAILABLE'
  | 'PRICE_BUILD_ABORTED'
  | 'PRICE_BUILD_FAILED';

export const retryAfterSeconds = 3;

/** Transient computation failures never mean that the saved price is missing. */
export class PriceBuildError extends Error {
  readonly retryAfterSeconds = retryAfterSeconds;
  constructor(readonly code: PriceBuildErrorCode, message = 'Прайс временно не удалось подготовить. Повторите попытку. Данные прайса сохранены.') {
    super(message);
    this.name = 'PriceBuildError';
  }
}

export function isPriceBuildRetryableError(error: unknown): error is PriceBuildError {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return ['PRICE_BUILD_BUSY', 'PRICE_BUILD_TIMEOUT', 'PRICE_BUILD_UNAVAILABLE', 'PRICE_BUILD_ABORTED', 'PRICE_BUILD_FAILED'].includes(String(error.code));
}
