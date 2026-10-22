import { mapProblemPriceWithClock } from './mappers';
import type { ManagerExtendedData } from './managerExtendedData';

export function aggregateManagerPrices(priceStats: ManagerExtendedData['priceStats'], now: number, currentDate: Date, readDate: () => Date) {
  const rows = priceStats.rows;

  const day = 24 * 60 * 60 * 1000;

  const today = new Date(currentDate.getTime());

  today.setHours(0, 0, 0, 0);

  const todayTime = today.getTime();

  const validTime = (value: string | null) => (value ? new Date(`${value}T00:00:00`).getTime() : null);

  const itemCounts = rows.map((row) => Number(row.item_count)).sort((a, b) => a - b);

  const medianItemsPerPrice =
    itemCounts.length === 0
      ? 0
      : itemCounts.length % 2
        ? itemCounts[Math.floor(itemCounts.length / 2)]
        : (itemCounts[itemCounts.length / 2 - 1] + itemCounts[itemCounts.length / 2]) / 2;

  const expiredPrices = rows.filter((row) => {
    const value = validTime(row.valid_until);
    return value !== null && value < todayTime;
  }).length;

  const expiringSoon7Days = rows.filter((row) => {
    const value = validTime(row.valid_until);
    return value !== null && value >= todayTime && value <= todayTime + 7 * day;
  }).length;

  const expiringSoon30Days = rows.filter((row) => {
    const value = validTime(row.valid_until);
    return value !== null && value >= todayTime && value <= todayTime + 30 * day;
  }).length;

  const stalePrices30Days = rows.filter((row) => new Date(row.updated_at).getTime() < now - 30 * day).length;

  const pricesWithoutViews = rows.filter((row) => Number(row.views) === 0).length;

  const pricesWithoutPdfDownloads = rows.filter((row) => Number(row.pdf_downloads) === 0).length;

  const extendedProblems = rows
    .map((row) =>
      mapProblemPriceWithClock({
        id: row.id,
        title: row.title,
        client_name: row.client_name,
        valid_until: row.valid_until,
        created_at: row.created_at,
        updated_at: row.updated_at,
        item_count: row.item_count,
        views: row.views,
        pdf_downloads: row.pdf_downloads,
      }, readDate),
    )
    .filter((price) => price.problems.length > 0);

  return { rows, now, day, todayTime, medianItemsPerPrice, expiredPrices, expiringSoon7Days, expiringSoon30Days, stalePrices30Days, pricesWithoutViews, pricesWithoutPdfDownloads, extendedProblems };
}
