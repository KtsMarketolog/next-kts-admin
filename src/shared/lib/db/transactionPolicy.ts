/** PostgreSQL deadlines, not client-side promise deadlines: the server cancels work. */
export const DATABASE_OPERATION_PROFILES = {
  default: { statementTimeoutMs: 60_000, lockTimeoutMs: 10_000, idleTransactionTimeoutMs: 60_000 },
  read: { statementTimeoutMs: 30_000, lockTimeoutMs: 5_000, idleTransactionTimeoutMs: 30_000 },
  interactive: { statementTimeoutMs: 30_000, lockTimeoutMs: 5_000, idleTransactionTimeoutMs: 30_000 },
  import: { statementTimeoutMs: 180_000, lockTimeoutMs: 15_000, idleTransactionTimeoutMs: 60_000 },
  schema: { statementTimeoutMs: 180_000, lockTimeoutMs: 15_000, idleTransactionTimeoutMs: 60_000 },
} as const;

export type DatabaseOperationProfile = keyof typeof DATABASE_OPERATION_PROFILES;

export type TransactionOptions = {
  trackCommitOutcome?: boolean;
  profile?: DatabaseOperationProfile;
  /** Opt in only for callbacks containing replay-safe database work, not external side effects. */
  retryOnConflict?: boolean;
};

export const MAX_TRANSACTION_ATTEMPTS = 3;

export function databaseOperationProfile(profile: DatabaseOperationProfile = 'default') {
  if (!Object.prototype.hasOwnProperty.call(DATABASE_OPERATION_PROFILES, profile)) {
    throw new Error('Unknown database operation profile');
  }
  return DATABASE_OPERATION_PROFILES[profile];
}

/** Only these SQLSTATEs explicitly establish that PostgreSQL aborted the transaction. */
export function isRetryableTransactionConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return error.code === '40P01' || error.code === '40001';
}

/** Two bounded delays (25–74ms, 50–149ms), after the connection has been released. */
export async function waitBeforeTransactionRetry(failedAttempt: number) {
  const baseMs = 25 * 2 ** Math.min(Math.max(failedAttempt - 1, 0), 1);
  const delayMs = baseMs + Math.floor(Math.random() * baseMs * 2);
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
