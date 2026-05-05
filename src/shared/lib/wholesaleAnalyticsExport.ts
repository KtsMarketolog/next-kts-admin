import { existsSync } from 'fs';
import PDFDocument from 'pdfkit';

import type {
  WholesaleAdminAnalytics,
  WholesaleAdminAnalyticsPeriod,
  WholesaleManagerAnalytics,
} from './db';

export type WholesaleAnalyticsExportFormat = 'pdf' | 'xls';

type CellValue = string | number | null | undefined;

type ReportSection = {
  title: string;
  rows: Array<Record<string, CellValue>>;
};

type Report = {
  title: string;
  subtitle: string;
  filenameBase: string;
  metrics: Array<{ label: string; value: CellValue; note?: string }>;
  sections: ReportSection[];
};

const periodLabels: Record<WholesaleAdminAnalyticsPeriod, string> = {
  '7d': '7 дней',
  '30d': '30 дней',
  all: 'всё время',
};

const problemLabels: Record<string, string> = {
  EMPTY: 'Пустой',
  NO_CLIENT: 'Без клиента',
  NO_EXPIRATION: 'Без срока',
  EXPIRED: 'Просрочен',
  EXPIRING_SOON: 'Скоро истекает',
  STALE: 'Не обновлялся',
  NO_VIEWS: 'Без просмотров',
};

function text(value: CellValue) {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

function dateText(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function escapeHtml(value: CellValue) {
  return text(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeFilename(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-zа-я0-9]+/giu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function resolveExistingFile(candidates: string[]) {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function fontPaths() {
  const regular = resolveExistingFile([
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
    'C:/Windows/Fonts/arial.ttf',
  ]);
  const bold = resolveExistingFile([
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf',
    'C:/Windows/Fonts/arialbd.ttf',
  ]);

  return { regular, bold };
}

function problemText(problems?: string[]) {
  if (!problems?.length) return '—';
  return problems.map((problem) => problemLabels[problem] ?? problem).join(', ');
}

function adminReport(analytics: WholesaleAdminAnalytics, period: WholesaleAdminAnalyticsPeriod): Report {
  const summary = analytics.summary;
  return {
    title: 'Общая аналитика индивидуальных прайсов',
    subtitle: `Все менеджеры • период: ${periodLabels[period]}`,
    filenameBase: `wholesale-analytics-all-${period}`,
    metrics: [
      { label: 'Всего прайсов', value: summary.totalPrices },
      { label: 'Активные прайсы', value: summary.activePrices },
      { label: 'Просроченные', value: summary.expiredPrices },
      { label: 'Проблемные', value: summary.problemPrices },
      { label: 'Создано за период', value: summary.pricesCreatedInSelectedPeriod },
      { label: 'Менеджеры', value: summary.totalManagers, note: `активных: ${summary.activeManagers}` },
      { label: 'Просмотры', value: summary.publicViewsInSelectedPeriod, note: `всего: ${summary.totalPublicViews}` },
      { label: 'PDF', value: summary.pdfDownloadsInSelectedPeriod, note: `всего: ${summary.totalPdfDownloads}` },
      { label: 'Клиенты с активностью', value: summary.clientsWithActivity },
      { label: 'Среднее качество', value: summary.averageQualityScore },
    ],
    sections: [
      {
        title: 'Рейтинг менеджеров',
        rows: analytics.managers.map((manager) => ({
          Менеджер: manager.name,
          Email: manager.email,
          Телефон: manager.phone,
          Прайсов: manager.totalPrices,
          Активных: manager.activePrices,
          Проблемных: manager.problemPrices,
          Действий: manager.actionsInSelectedPeriod,
          Просмотров: manager.publicViews,
          PDF: manager.pdfDownloads,
          Качество: manager.qualityScore,
          'Последний вход': dateText(manager.lastLoginAt),
        })),
      },
      {
        title: 'Проблемные прайсы',
        rows: analytics.problemPrices.slice(0, 100).map((price) => ({
          Прайс: price.title,
          Клиент: price.clientName,
          Менеджер: price.managerName,
          Проблемы: problemText(price.problems),
          Создан: dateText(price.createdAt),
          Обновлён: dateText(price.updatedAt),
          Срок: price.validUntil,
          Просмотры: price.views,
          PDF: price.pdfDownloads,
        })),
      },
      {
        title: 'Топ публичных ссылок',
        rows: analytics.publicLinks.topViewedPrices.map((price) => ({
          Прайс: price.title,
          Клиент: price.clientName,
          Менеджер: price.managerName,
          Просмотры: price.views,
          Уникальные: price.uniqueVisitors,
          Повторные: price.repeatViews,
          'Последний просмотр': dateText(price.lastViewAt),
        })),
      },
      {
        title: 'Топ PDF',
        rows: analytics.pdf.topDownloadedPrices.map((price) => ({
          Прайс: price.title,
          Клиент: price.clientName,
          Менеджер: price.managerName,
          Скачивания: price.downloads,
          Уникальные: price.uniqueDownloaders,
          Просмотры: price.views,
          'Последнее скачивание': dateText(price.lastDownloadAt),
        })),
      },
      {
        title: 'Топ клиентов по активности',
        rows: analytics.clients.topClientsByActivity.map((client) => ({
          Клиент: client.clientName,
          Менеджер: client.managerName,
          Прайс: client.priceTitle,
          Прайсов: client.priceCount,
          Просмотры: client.views,
          PDF: client.pdfDownloads,
          'Последняя активность': dateText(client.lastActivityAt),
        })),
      },
      {
        title: 'Последние события',
        rows: analytics.recentEvents.slice(0, 100).map((event) => ({
          Дата: dateText(event.createdAt),
          Источник: event.actorType,
          Событие: event.eventType,
          Менеджер: event.managerName,
          Прайс: event.priceTitle,
          Клиент: event.clientName,
          Детали: event.details,
        })),
      },
    ],
  };
}

function managerReport(analytics: WholesaleManagerAnalytics, period: WholesaleAdminAnalyticsPeriod): Report {
  const summary = analytics.summary;
  return {
    title: 'Аналитика менеджера по индивидуальным прайсам',
    subtitle: `${analytics.manager.name} • ${analytics.manager.email || 'email не указан'} • период: ${periodLabels[period]}`,
    filenameBase: `wholesale-analytics-manager-${analytics.manager.id}-${period}`,
    metrics: [
      { label: 'Всего прайсов', value: summary.totalPrices },
      { label: 'Активные прайсы', value: summary.activePrices },
      { label: 'Просроченные', value: summary.expiredPrices },
      { label: 'Создано за период', value: summary.periodPrices },
      { label: 'Пустые', value: summary.emptyPrices },
      { label: 'Без клиента', value: summary.pricesWithoutClient },
      { label: 'Без срока', value: summary.pricesWithoutExpiration },
      { label: 'Качество', value: summary.qualityScore ?? '—' },
      { label: 'Просмотры', value: analytics.publicViews.periodViews, note: `всего: ${analytics.publicViews.total}` },
      { label: 'PDF', value: analytics.pdf?.downloadsInSelectedPeriod ?? 0, note: `всего: ${analytics.pdf?.totalDownloads ?? 0}` },
    ],
    sections: [
      {
        title: 'Проблемные прайсы',
        rows: analytics.problemPrices.slice(0, 100).map((price) => ({
          Прайс: price.title,
          Клиент: price.clientName,
          Проблемы: problemText(price.problems),
          Создан: dateText(price.createdAt),
          Обновлён: dateText(price.updatedAt),
          Срок: price.validUntil,
          Просмотры: price.views,
          PDF: price.pdfDownloads,
        })),
      },
      {
        title: 'Публичные ссылки',
        rows: analytics.publicViews.topPrices.map((price) => ({
          Прайс: price.title,
          Клиент: price.clientName,
          Просмотры: price.views,
          Уникальные: price.uniqueVisitors,
          'Последний просмотр': dateText(price.lastViewAt),
        })),
      },
      {
        title: 'PDF',
        rows: (analytics.pdf?.topDownloadedPrices ?? []).map((price) => ({
          Прайс: price.title,
          Клиент: price.clientName,
          Скачивания: price.downloads,
          Уникальные: price.uniqueDownloaders,
          Просмотры: price.views,
          'Последнее скачивание': dateText(price.lastDownloadAt),
        })),
      },
      {
        title: 'Клиенты',
        rows: (analytics.clients?.topClientsByViews ?? []).map((client) => ({
          Клиент: client.clientName,
          Прайс: client.priceTitle,
          Просмотры: client.views,
          PDF: client.pdfDownloads,
          'Последняя активность': dateText(client.lastActivityAt),
          Статус: client.status,
        })),
      },
      {
        title: 'Последние события',
        rows: (analytics.recentEvents ?? []).slice(0, 100).map((event) => ({
          Дата: dateText(event.createdAt),
          Источник: event.actorType,
          Событие: event.eventType,
          Прайс: event.priceTitle,
          Клиент: event.clientName,
          Детали: event.details,
        })),
      },
    ],
  };
}

function createPdf(report: Report) {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 38 });
    const chunks: Buffer[] = [];
    const fonts = fontPaths();
    const regularFont = fonts.regular ? 'Regular' : 'Helvetica';
    const boldFont = fonts.bold ? 'Bold' : regularFont;
    if (fonts.regular) doc.registerFont(regularFont, fonts.regular);
    if (fonts.bold) doc.registerFont(boldFont, fonts.bold);

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font(boldFont).fontSize(18).text(report.title);
    doc.moveDown(0.25);
    doc.font(regularFont).fontSize(10).fillColor('#555').text(report.subtitle).fillColor('#000');
    doc.moveDown(0.7);

    const metricWidth = 165;
    let metricsBottom = doc.y;
    report.metrics.forEach((metric, index) => {
      const x = doc.page.margins.left + (index % 3) * (metricWidth + 8);
      const y = doc.y;
      if (index > 0 && index % 3 === 0) doc.moveDown(1.2);
      const rowY = index % 3 === 0 ? doc.y : y;
      doc.roundedRect(x, rowY, metricWidth, 54, 5).stroke('#dfe3ef');
      doc.font(boldFont).fontSize(8).fillColor('#6f7182').text(metric.label, x + 8, rowY + 8, { width: metricWidth - 16 });
      doc.font(boldFont).fontSize(18).fillColor('#242633').text(text(metric.value), x + 8, rowY + 23, { width: metricWidth - 16 });
      if (metric.note) doc.font(regularFont).fontSize(7).fillColor('#77798a').text(metric.note, x + 8, rowY + 43, { width: metricWidth - 16 });
      doc.fillColor('#000');
      metricsBottom = Math.max(metricsBottom, rowY + 62);
      if (index % 3 === 2) doc.y = rowY + 62;
    });
    doc.y = metricsBottom;
    doc.moveDown(1);

    for (const section of report.sections) {
      if (doc.y > 700) doc.addPage();
      doc.font(boldFont).fontSize(13).fillColor('#242633').text(section.title);
      doc.moveDown(0.25);
      if (section.rows.length === 0) {
        doc.font(regularFont).fontSize(9).fillColor('#77798a').text('Нет данных');
        doc.fillColor('#000').moveDown(0.7);
        continue;
      }

      const columns = Object.keys(section.rows[0]).slice(0, 6);
      doc.font(boldFont).fontSize(8).fillColor('#6f7182').text(columns.join(' | '));
      doc.moveDown(0.2);
      doc.font(regularFont).fontSize(8).fillColor('#242633');
      for (const row of section.rows.slice(0, 30)) {
        if (doc.y > 760) doc.addPage();
        doc.text(columns.map((column) => text(row[column])).join(' | '), { width: 520 });
      }
      doc.fillColor('#000').moveDown(0.8);
    }

    doc.end();
  });
}

function createXls(report: Report) {
  const metricsRows = report.metrics
    .map((metric) => `<tr><td>${escapeHtml(metric.label)}</td><td>${escapeHtml(metric.value)}</td><td>${escapeHtml(metric.note)}</td></tr>`)
    .join('');
  const sectionsHtml = report.sections.map((section) => {
    const columns = section.rows[0] ? Object.keys(section.rows[0]) : [];
    const header = columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('');
    const rows = section.rows
      .map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(row[column])}</td>`).join('')}</tr>`)
      .join('');
    return `<h2>${escapeHtml(section.title)}</h2><table><thead><tr>${header}</tr></thead><tbody>${rows || '<tr><td>Нет данных</td></tr>'}</tbody></table>`;
  }).join('');

  return Buffer.from(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { font-family: Arial, sans-serif; }
    h1 { font-size: 20px; }
    h2 { margin-top: 24px; font-size: 16px; }
    table { border-collapse: collapse; margin-bottom: 16px; }
    th, td { border: 1px solid #d9deea; padding: 6px 8px; vertical-align: top; }
    th { background: #eef1f7; font-weight: 700; }
  </style>
</head>
<body>
  <h1>${escapeHtml(report.title)}</h1>
  <p>${escapeHtml(report.subtitle)}</p>
  <h2>Ключевые показатели</h2>
  <table><thead><tr><th>Показатель</th><th>Значение</th><th>Примечание</th></tr></thead><tbody>${metricsRows}</tbody></table>
  ${sectionsHtml}
</body>
</html>`, 'utf8');
}

export function buildWholesaleAnalyticsReport(
  analytics: WholesaleAdminAnalytics | WholesaleManagerAnalytics,
  period: WholesaleAdminAnalyticsPeriod,
  scope: 'admin' | 'manager',
) {
  return scope === 'admin'
    ? adminReport(analytics as WholesaleAdminAnalytics, period)
    : managerReport(analytics as WholesaleManagerAnalytics, period);
}

export async function renderWholesaleAnalyticsExport(report: Report, format: WholesaleAnalyticsExportFormat) {
  if (format === 'pdf') {
    return {
      content: await createPdf(report),
      contentType: 'application/pdf',
      filename: `${safeFilename(report.filenameBase)}.pdf`,
    };
  }

  return {
    content: createXls(report),
    contentType: 'application/vnd.ms-excel; charset=utf-8',
    filename: `${safeFilename(report.filenameBase)}.xls`,
  };
}
