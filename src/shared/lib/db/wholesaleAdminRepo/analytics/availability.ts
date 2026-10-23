/** Temporary contention, distinct from a database or programming failure. */
export class AnalyticsUnavailableError extends Error {
  constructor(message = 'Аналитика занята. Повторите запрос через несколько секунд.') {
    super(message); this.name = 'AnalyticsUnavailableError';
  }
}

export function analyticsUnavailableResponse(error: unknown): Response {
  if (!(error instanceof AnalyticsUnavailableError)) throw error;
  return Response.json({ error: error.message }, { status: 503,
    headers: { 'Retry-After': '2', 'Cache-Control': 'private, no-store' } });
}
