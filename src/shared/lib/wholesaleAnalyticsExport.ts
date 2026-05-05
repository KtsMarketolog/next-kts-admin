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

function compactText(value: CellValue, maxLength = 90) {
  const source = text(value).replace(/\s+/g, ' ').trim();
  return source.length > maxLength ? `${source.slice(0, maxLength - 1)}…` : source;
}

function ensurePdfSpace(doc: PDFKit.PDFDocument, height: number) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + height > bottom) doc.addPage();
}

function drawMetricCard(
  doc: PDFKit.PDFDocument,
  metric: Report['metrics'][number],
  fonts: { regularFont: string; boldFont: string },
  x: number,
  y: number,
  width: number,
) {
  doc.roundedRect(x, y, width, 58, 6).fill('#f8f9fc');
  doc.roundedRect(x, y, width, 58, 6).stroke('#dfe3ef');
  doc.font(fonts.boldFont).fontSize(8).fillColor('#6f7182').text(metric.label, x + 10, y + 9, { width: width - 20 });
  doc.font(fonts.boldFont).fontSize(19).fillColor('#242633').text(text(metric.value), x + 10, y + 25, { width: width - 20 });
  if (metric.note) {
    doc.font(fonts.regularFont).fontSize(7).fillColor('#77798a').text(metric.note, x + 10, y + 46, { width: width - 20 });
  }
  doc.fillColor('#000');
}

function drawPdfSection(
  doc: PDFKit.PDFDocument,
  section: ReportSection,
  sectionIndex: number,
  fonts: { regularFont: string; boldFont: string },
) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  ensurePdfSpace(doc, 46);
  doc.font(fonts.boldFont).fontSize(13).fillColor('#242633').text(`${sectionIndex + 1}. ${section.title}`);
  doc.moveDown(0.35);

  if (section.rows.length === 0) {
    doc.font(fonts.regularFont).fontSize(9).fillColor('#77798a').text('Нет данных');
    doc.fillColor('#000').moveDown(0.8);
    return;
  }

  section.rows.slice(0, 35).forEach((row, rowIndex) => {
    const entries = Object.entries(row);
    const [mainLabel, mainValue] = entries[0] ?? ['Запись', '—'];
    const details = entries.slice(1);
    const detailRows = Math.ceil(details.length / 2);
    const rowHeight = Math.max(48, 31 + detailRows * 16);
    ensurePdfSpace(doc, rowHeight + 8);

    const y = doc.y;
    doc.roundedRect(left, y, width, rowHeight, 6).fill('#fbfcff');
    doc.roundedRect(left, y, width, rowHeight, 6).stroke('#e3e5ef');
    doc.font(fonts.boldFont)
      .fontSize(9)
      .fillColor('#242633')
      .text(`${rowIndex + 1}. ${mainLabel}: ${compactText(mainValue, 120)}`, left + 10, y + 8, { width: width - 20 });

    const detailWidth = (width - 30) / 2;
    details.forEach(([label, value], detailIndex) => {
      const column = detailIndex % 2;
      const line = Math.floor(detailIndex / 2);
      const detailX = left + 10 + column * (detailWidth + 10);
      const detailY = y + 28 + line * 16;
      doc.font(fonts.regularFont)
        .fontSize(8)
        .fillColor('#4b4e61')
        .text(`${label}: ${compactText(value, 62)}`, detailX, detailY, { width: detailWidth });
    });

    doc.fillColor('#000');
    doc.y = y + rowHeight + 7;
  });

  if (section.rows.length > 35) {
    doc.font(fonts.regularFont)
      .fontSize(8)
      .fillColor('#77798a')
      .text(`Показаны первые 35 записей из ${section.rows.length}. Полный список доступен в Excel-отчёте.`);
    doc.fillColor('#000').moveDown(0.5);
  }
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

    const left = doc.page.margins.left;
    const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.rect(0, 0, doc.page.width, 86).fill('#260b86');
    doc.fillColor('#fff').font(boldFont).fontSize(18).text(report.title, left, 24, { width: contentWidth });
    doc.font(regularFont).fontSize(10).text(report.subtitle, left, 51, { width: contentWidth });
    doc.fillColor('#000');
    doc.y = 106;

    doc.font(boldFont).fontSize(14).fillColor('#242633').text('Ключевые показатели');
    doc.moveDown(0.5);

    const metricGap = 10;
    const metricWidth = (contentWidth - metricGap) / 2;
    for (let index = 0; index < report.metrics.length; index += 2) {
      ensurePdfSpace(doc, 68);
      const rowY = doc.y;
      drawMetricCard(doc, report.metrics[index], { regularFont, boldFont }, left, rowY, metricWidth);
      if (report.metrics[index + 1]) {
        drawMetricCard(doc, report.metrics[index + 1], { regularFont, boldFont }, left + metricWidth + metricGap, rowY, metricWidth);
      }
      doc.y = rowY + 68;
    }
    doc.moveDown(1);

    report.sections.forEach((section, sectionIndex) => drawPdfSection(doc, section, sectionIndex, { regularFont, boldFont }));

    doc.end();
  });
}

function escapeXml(value: CellValue) {
  return text(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function safeSheetName(value: string, index: number) {
  const cleaned = value.replace(/[\\/?*:[\]]/g, ' ').replace(/\s+/g, ' ').trim() || `Лист ${index + 1}`;
  return cleaned.slice(0, 28);
}

function excelCell(value: CellValue, style = 'Body') {
  const isNumber = typeof value === 'number' && Number.isFinite(value);
  return `<Cell ss:StyleID="${style}"><Data ss:Type="${isNumber ? 'Number' : 'String'}">${escapeXml(value)}</Data></Cell>`;
}

function worksheet(name: string, rows: Array<Record<string, CellValue>>, index: number) {
  const columns = rows[0] ? Object.keys(rows[0]) : ['Данные'];
  const header = `<Row>${columns.map((column) => excelCell(column, 'Header')).join('')}</Row>`;
  const body = rows.length > 0
    ? rows.map((row) => `<Row>${columns.map((column) => excelCell(row[column])).join('')}</Row>`).join('')
    : `<Row>${excelCell('Нет данных')}</Row>`;
  const columnWidths = columns.map((column) => {
    const width = Math.max(85, Math.min(210, column.length * 10 + 65));
    return `<Column ss:AutoFitWidth="0" ss:Width="${width}"/>`;
  }).join('');

  return `<Worksheet ss:Name="${escapeXml(safeSheetName(name, index))}"><Table>${columnWidths}${header}${body}</Table></Worksheet>`;
}

function createXls(report: Report) {
  const metricsRows = [
    { Показатель: 'Отчёт', Значение: report.title, Примечание: report.subtitle },
    ...report.metrics.map((metric) => ({
      Показатель: metric.label,
      Значение: metric.value,
      Примечание: metric.note ?? '',
    })),
  ];
  const sheets = [
    worksheet('Показатели', metricsRows, 0),
    ...report.sections.map((section, index) => worksheet(section.title, section.rows, index + 1)),
  ].join('');

  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="Header">
   <Font ss:Bold="1" ss:Color="#242633"/>
   <Interior ss:Color="#EEF1F7" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D9DEEA"/>
   </Borders>
  </Style>
  <Style ss:ID="Body">
   <Alignment ss:Vertical="Top" ss:WrapText="1"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#EDF0F6"/>
   </Borders>
  </Style>
 </Styles>
 ${sheets}
</Workbook>`, 'utf8');
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
