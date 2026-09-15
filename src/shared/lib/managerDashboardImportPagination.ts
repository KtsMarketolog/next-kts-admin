export const PERSONAL_DASHBOARD_IMPORT_PAGE_SIZE = 5;

/** PostgreSQL BIGINT keyset cursor: keep the decimal string intact, even above 2^53. */
export function isPersonalDashboardImportCursor(value: unknown): value is string {
  return typeof value === 'string'
    && /^[1-9][0-9]{0,18}$/.test(value)
    && (value.length < 19 || value <= '9223372036854775807');
}
