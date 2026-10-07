import { formatDashboardDataDate, formatDashboardTimestamp } from '@/shared/lib/dashboardDates';

export function DashboardDataDates({ uploadedAt, dataAsOf }: { uploadedAt?: string | null; dataAsOf?: string | null }) {
  return <>
    <span>Данные загружены: {uploadedAt ? formatDashboardTimestamp(uploadedAt) : 'ещё не загружены'}</span>
    {dataAsOf ? <span>Данные на: {formatDashboardDataDate(dataAsOf)}</span> : null}
  </>;
}
