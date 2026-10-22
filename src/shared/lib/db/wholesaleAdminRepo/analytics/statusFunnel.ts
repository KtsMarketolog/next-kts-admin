import type { WholesaleAnalyticsStatusFunnel, WholesaleAnalyticsStatusFunnelStep } from '../types';
import type { AnalyticsWorkflowRow } from './rows';
import { rowStatus, averageHours } from './workflowValues';

export function buildStatusFunnel(rows: AnalyticsWorkflowRow[]): WholesaleAnalyticsStatusFunnel {
  const total = rows.length;
  const reachedSent = rows.filter((row) => rowStatus(row) !== 'not_sent').length;
  const opened = rows.filter((row) => Number(row.views) > 0).length;
  const pdf = rows.filter((row) => Number(row.pdf_downloads) > 0).length;
  const requested = rows.filter((row) => Number(row.requests_sent) > 0).length;
  const negotiation = rows.filter((row) => ['negotiation', 'confirmed', 'rejected'].includes(rowStatus(row))).length;
  const confirmed = rows.filter((row) => rowStatus(row) === 'confirmed').length;
  const rejected = rows.filter((row) => rowStatus(row) === 'rejected').length;
  const rawSteps = [
    { key: 'created', label: 'Создано прайсов', count: total },
    { key: 'sent', label: 'Отправлено клиенту', count: reachedSent },
    { key: 'opened', label: 'Открыто клиентом', count: opened },
    { key: 'pdf', label: 'Скачали PDF', count: pdf },
    { key: 'request', label: 'Отправили заявку', count: requested },
    { key: 'negotiation', label: 'На согласовании', count: negotiation },
    { key: 'confirmed', label: 'Подтверждено', count: confirmed },
    { key: 'rejected', label: 'Отклонено', count: rejected },
  ];
  const steps = rawSteps.map<WholesaleAnalyticsStatusFunnelStep>((step, index) => {
    const previous = index === 0 ? step.count : rawSteps[index - 1].count;
    return {
      ...step,
      dropFromPrevious: Math.max(0, previous - step.count),
      conversionFromPrevious: previous > 0 ? Math.round((step.count / previous) * 100) : 0,
      conversionFromTotal: total > 0 ? Math.round((step.count / total) * 100) : 0,
    };
  });

  return {
    steps,
    biggestDrop: steps.slice(1).sort((a, b) => b.dropFromPrevious - a.dropFromPrevious)[0] ?? null,
    averageTimeToOpenHours: averageHours(rows, 'created_at', 'first_view_at'),
    averageTimeToPdfHours: averageHours(rows, 'first_view_at', 'first_pdf_at'),
    averageTimeToRequestHours: averageHours(rows, 'first_view_at', 'first_request_at'),
  };
}
