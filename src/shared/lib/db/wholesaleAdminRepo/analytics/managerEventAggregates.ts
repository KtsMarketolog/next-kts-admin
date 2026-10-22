import { type WholesaleManagerAnalyticsClient } from '../types';
import { mapAnalyticsEvent } from './mappers';
import type { ManagerExtendedData } from './managerExtendedData';

export function aggregateManagerEvents(rows: ManagerExtendedData['priceStats']['rows'], recentEventsResult: ManagerExtendedData['recentEventsResult']) {
  const recentEvents = recentEventsResult.rows.map(mapAnalyticsEvent);

  const recentViews = recentEvents.filter((event) => event.actorType === 'client' && ['public_price_opened', 'public_price_reopened'].includes(event.eventType));

  const recentDownloads = recentEvents.filter((event) => event.actorType === 'client' && event.eventType === 'public_price_pdf_downloaded');

  const lastAction = recentEvents.find((event) => event.actorType === 'admin' || event.actorType === 'manager') ?? null;

  const topViewed = [...rows].filter((row) => Number(row.views) > 0).sort((a, b) => Number(b.views) - Number(a.views));

  const topDownloaded = [...rows]
    .filter((row) => Number(row.pdf_downloads) > 0)
    .sort((a, b) => Number(b.pdf_downloads) - Number(a.pdf_downloads));

  const mostChanged = [...rows].filter((row) => Number(row.change_count) > 0).sort((a, b) => Number(b.change_count) - Number(a.change_count));

  const clientMap = new Map<string, WholesaleManagerAnalyticsClient>();

  for (const row of rows) {
    const clientName = row.client_name.trim();
    if (!clientName) continue;
    const key = clientName.toLowerCase();
    const current =
      clientMap.get(key) ??
      ({
        clientId: key,
        clientName,
        priceId: Number(row.id),
        priceTitle: row.title,
        priceCount: 0,
        viewsLast24Hours: 0,
        viewsLast7Days: 0,
        views: 0,
        uniqueVisitors: 0,
        pdfDownloads: 0,
        lastActivityAt: null,
        lastPriceCreatedAt: null,
        status: 'Не открывал',
      } satisfies WholesaleManagerAnalyticsClient);
    current.priceCount += 1;
    current.views += Number(row.views);
    current.viewsLast7Days += Number(row.views_last_7_days);
    current.uniqueVisitors += Number(row.unique_visitors);
    current.pdfDownloads += Number(row.pdf_downloads);
    const lastActivity = [row.last_view_at, row.last_pdf_at].filter(Boolean).sort().at(-1) ?? null;
    if (lastActivity && (!current.lastActivityAt || lastActivity > current.lastActivityAt)) {
      current.lastActivityAt = lastActivity;
      current.priceId = Number(row.id);
      current.priceTitle = row.title;
    }
    if (!current.lastPriceCreatedAt || row.created_at > current.lastPriceCreatedAt) current.lastPriceCreatedAt = row.created_at;
    clientMap.set(key, current);
  }

  return { recentEvents, recentViews, recentDownloads, lastAction, topViewed, topDownloaded, mostChanged, clientMap };
}
