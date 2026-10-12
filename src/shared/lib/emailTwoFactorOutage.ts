type OutageConfiguration = {
  EMAIL_2FA_OUTAGE_START_AT?: string;
  EMAIL_2FA_OUTAGE_END_AT?: string;
};

function utcTimestamp(value: string | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? parsed : null;
}

// Trusted server configuration only; password and account checks remain mandatory.
export function isEmailTwoFactorOutageActive(
  now = new Date(),
  config: OutageConfiguration = {
    EMAIL_2FA_OUTAGE_START_AT: process.env.EMAIL_2FA_OUTAGE_START_AT,
    EMAIL_2FA_OUTAGE_END_AT: process.env.EMAIL_2FA_OUTAGE_END_AT,
  },
) {
  const start = utcTimestamp(config.EMAIL_2FA_OUTAGE_START_AT);
  const end = utcTimestamp(config.EMAIL_2FA_OUTAGE_END_AT);
  if (!start || !end || !Number.isFinite(now.getTime())) return false;

  const latestEnd = new Date(start);
  latestEnd.setUTCMonth(start.getUTCMonth() + 3, 1);
  const lastDay = new Date(latestEnd);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  latestEnd.setUTCDate(Math.min(start.getUTCDate(), lastDay.getUTCDate()));

  return start.getTime() < end.getTime()
    && end.getTime() <= latestEnd.getTime()
    && start.getTime() <= now.getTime()
    && now.getTime() < end.getTime();
}
