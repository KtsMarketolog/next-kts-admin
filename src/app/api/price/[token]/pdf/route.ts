import { existsSync } from 'fs';
import PDFDocument from 'pdfkit';

import { getAdminSession, isManagerSessionRole } from '@/shared/lib/adminAuth';
import { getPublicWholesalePriceList, trackAnalyticsEvent } from '@/shared/lib/db';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { readPricePdfCache, writePricePdfCache } from '@/shared/lib/pricePdfCache';
import { PUBLIC_PRICE_SESSION_COOKIE, applySessionCookie, getOrCreateSessionCookie } from '@/shared/lib/publicSession';
import { checkDbRateLimit } from '@/shared/lib/rateLimit';

type Context = {
  params: Promise<{ token: string }>;
};

type PublicPriceList = NonNullable<Awaited<ReturnType<typeof getPublicWholesalePriceList>>>;
type PublicPriceProduct = PublicPriceList['categories'][number]['products'][number];
type PublicPriceVariant = PublicPriceProduct['variants'][number];
type PdfDocument = InstanceType<typeof PDFDocument>;

type PdfColumn = {
  key: 'group' | 'product' | 'sku' | 'description' | 'price' | 'stock';
  title: string;
  width: number;
  align?: 'left' | 'right';
};

type PdfRow = Record<PdfColumn['key'], string>;

const NO_PRICE_GROUP_TITLE = 'Без ценовой группы';
const TABLE_HEADER_COLOR = '#260b86';
const TABLE_BORDER_COLOR = '#dfe2ee';
const TABLE_TEXT_COLOR = '#242633';
const TABLE_MUTED_COLOR = '#6f7182';
const TABLE_ALT_ROW_COLOR = '#f8f9fd';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PDF_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const PDF_SESSION_LIMIT = 20;
const PDF_USER_LIMIT = 40;
const PDF_GLOBAL_LIMIT = 300;
const MAX_CONCURRENT_PDF_GENERATIONS = 3;
const MAX_PRICE_EXPORT_ROWS = 15_000;

let activePdfGenerations = 0;

function getHeaderIp(headersList: Headers) {
  const forwardedFor = headersList.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwardedFor || headersList.get('x-real-ip') || 'unknown';
}

function safeFilename(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-zа-я0-9]+/giu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

async function createPdfWithSlot(priceList: NonNullable<Awaited<ReturnType<typeof getPublicWholesalePriceList>>>) {
  if (activePdfGenerations >= MAX_CONCURRENT_PDF_GENERATIONS) return null;
  activePdfGenerations += 1;
  try {
    return await createPdf(priceList);
  } finally {
    activePdfGenerations -= 1;
  }
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

function formatPrice(value: string | null) {
  if (!value) return '—';
  const number = Number(value.replace(/\s+/g, '').replace(',', '.'));
  if (!Number.isFinite(number)) return value;
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(number);
}

function hasPriceValue(value: string | null) {
  if (!value) return false;
  const number = Number(value.replace(/\s+/g, '').replace(',', '.'));
  return Number.isFinite(number) ? number > 0 : value.trim().length > 0;
}

function formatIndividualPrice(variant: PublicPriceVariant) {
  const currencyPrices = [
    { value: variant.priceUsd, currency: 'USD' },
    { value: variant.priceEur, currency: 'EUR' },
    { value: variant.priceRub, currency: 'RUB' },
    { value: variant.priceCny, currency: 'CNY' },
  ].filter((price) => hasPriceValue(price.value));

  if (currencyPrices.length === 0) return formatPrice(variant.wholesalePrice);

  return currencyPrices.map((price) => `${formatPrice(price.value)} ${price.currency}`).join(' / ');
}

function stockLabel(product: PublicPriceProduct) {
  const unit = product.unit?.trim() || 'шт.';
  if (product.stock > 0) return `В наличии: ${product.stock} ${unit}`;
  return product.isExpected ? 'Скоро поступление' : 'Под заказ';
}

function groupProductsByPriceGroup(priceList: PublicPriceList) {
  const groups = new Map<string, { title: string; products: PublicPriceProduct[] }>();

  for (const category of priceList.categories) {
    for (const product of category.products) {
      const groupTitle = product.priceGroup || NO_PRICE_GROUP_TITLE;
      const groupKey = groupTitle.toLowerCase();
      let group = groups.get(groupKey);
      if (!group) {
        group = { title: groupTitle, products: [] };
        groups.set(groupKey, group);
      }
      group.products.push(product);
    }
  }

  return Array.from(groups.values());
}

function getPdfColumns(showStock: boolean): PdfColumn[] {
  const columns: PdfColumn[] = [
    { key: 'group', title: 'Ценовая группа', width: showStock ? 92 : 110 },
    { key: 'product', title: 'Товар', width: showStock ? 216 : 250 },
    { key: 'sku', title: 'Артикул', width: showStock ? 76 : 90 },
    { key: 'description', title: 'Описание', width: showStock ? 168 : 190 },
    { key: 'price', title: 'Индивидуальная цена', width: showStock ? 132 : 138 },
  ];
  if (showStock) columns.push({ key: 'stock', title: 'Остаток', width: 94 });
  return columns;
}

function createPdfRows(priceList: PublicPriceList): PdfRow[] {
  const rows: PdfRow[] = [];
  for (const group of groupProductsByPriceGroup(priceList)) {
    for (const product of group.products) {
      for (const variant of product.variants) {
        rows.push({
          group: group.title,
          product: product.title,
          sku: product.sku || '—',
          description: product.description || '—',
          price: formatIndividualPrice(variant),
          stock: priceList.showStock ? stockLabel(product) : '',
        });
      }
    }
  }
  return rows;
}

function countPriceExportRows(priceList: PublicPriceList) {
  return priceList.categories.reduce(
    (sum, category) => sum + category.products.reduce((productSum, product) => productSum + product.variants.length, 0),
    0,
  );
}

function ensureSpace(doc: PdfDocument, requiredHeight: number) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + requiredHeight <= bottom) return false;
  doc.addPage();
  return true;
}

function measureCellHeight(doc: PdfDocument, text: string, width: number, fontName: string, fontSize: number) {
  doc.font(fontName).fontSize(fontSize);
  return doc.heightOfString(text || '—', { width: width - 12, lineGap: 1 }) + 12;
}

function drawCell(
  doc: PdfDocument,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  options: {
    fontName: string;
    fontSize: number;
    color?: string;
    background?: string;
    borderColor?: string;
    align?: 'left' | 'right' | 'center';
  },
) {
  const background = options.background ?? '#ffffff';
  const borderColor = options.borderColor ?? TABLE_BORDER_COLOR;

  doc.save();
  doc.rect(x, y, width, height).fill(background);
  doc.restore();

  doc.save();
  doc.lineWidth(0.5).strokeColor(borderColor).rect(x, y, width, height).stroke();
  doc.restore();

  doc
    .font(options.fontName)
    .fontSize(options.fontSize)
    .fillColor(options.color ?? TABLE_TEXT_COLOR)
    .text(text || '—', x + 6, y + 6, {
      width: width - 12,
      height: height - 10,
      align: options.align ?? 'left',
      lineGap: 1,
      ellipsis: true,
    });
}

function drawTableHeader(doc: PdfDocument, columns: PdfColumn[], boldFont: string) {
  const height = 24;
  let x = doc.page.margins.left;
  const y = doc.y;

  for (const column of columns) {
    drawCell(doc, column.title, x, y, column.width, height, {
      fontName: boldFont,
      fontSize: 8,
      color: '#ffffff',
      background: TABLE_HEADER_COLOR,
      borderColor: TABLE_HEADER_COLOR,
      align: column.align,
    });
    x += column.width;
  }
  doc.y = y + height;
}

function drawTableRow(doc: PdfDocument, columns: PdfColumn[], row: PdfRow, y: number, height: number, regularFont: string, background: string) {
  let x = doc.page.margins.left;
  for (const column of columns) {
    drawCell(doc, row[column.key], x, y, column.width, height, {
      fontName: regularFont,
      fontSize: 8,
      background,
      align: column.align,
    });
    x += column.width;
  }
  doc.y = y + height;
}

function drawInfoLine(doc: PdfDocument, label: string, value: string, x: number, y: number, width: number, boldFont: string, regularFont: string) {
  doc.font(boldFont).fontSize(8).fillColor(TABLE_MUTED_COLOR).text(label, x, y, { width });
  doc.font(regularFont).fontSize(9).fillColor(TABLE_TEXT_COLOR).text(value || '—', x, y + 12, { width });
}

function drawPdfHeader(doc: PdfDocument, priceList: PublicPriceList, boldFont: string, regularFont: string) {
  const left = doc.page.margins.left;
  const top = doc.page.margins.top;
  const right = doc.page.width - doc.page.margins.right;
  const headerBottom = 118;

  doc.font(boldFont).fontSize(19).fillColor(TABLE_TEXT_COLOR).text(priceList.title || 'Индивидуальный прайс', left, top, {
    width: 410,
  });
  doc.font(regularFont).fontSize(10).fillColor(TABLE_MUTED_COLOR).text(`Клиент: ${priceList.clientName || 'Не указан'}`, left, top + 30, {
    width: 360,
  });
  doc.font(regularFont).fontSize(10).fillColor(TABLE_MUTED_COLOR).text(`Действует до: ${priceList.validUntil || 'Без срока'}`, left, top + 46, {
    width: 360,
  });

  const managerText = [priceList.managerName, priceList.managerPhone, priceList.managerEmail].filter(Boolean).join(' · ');
  const supportText = [priceList.supportManagerName, priceList.supportManagerPhone, priceList.supportManagerEmail].filter(Boolean).join(' · ');
  drawInfoLine(doc, 'Ваш менеджер по развитию', managerText, right - 310, top, 310, boldFont, regularFont);
  if (supportText) {
    drawInfoLine(doc, 'Ваш менеджер по сопровождению', supportText, right - 310, top + 40, 310, boldFont, regularFont);
  }

  doc.save();
  doc.moveTo(left, headerBottom).lineTo(right, headerBottom).lineWidth(1).strokeColor(TABLE_BORDER_COLOR).stroke();
  doc.restore();
  doc.y = headerBottom + 14;
}

function createPdf(priceList: NonNullable<Awaited<ReturnType<typeof getPublicWholesalePriceList>>>) {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32, info: { Title: priceList.title || 'Индивидуальный прайс' } });
    const chunks: Buffer[] = [];
    const fonts = fontPaths();
    const regularFont = fonts.regular ? 'Regular' : 'Helvetica';
    const boldFont = fonts.bold ? 'Bold' : regularFont;
    if (fonts.regular) doc.registerFont(regularFont, fonts.regular);
    if (fonts.bold) doc.registerFont(boldFont, fonts.bold);

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    drawPdfHeader(doc, priceList, boldFont, regularFont);

    const columns = getPdfColumns(priceList.showStock);
    const rows = createPdfRows(priceList);
    if (rows.length === 0) {
      doc.font(regularFont).fontSize(12).fillColor(TABLE_MUTED_COLOR).text('В прайс пока не добавлены товары.');
      doc.end();
      return;
    }

    drawTableHeader(doc, columns, boldFont);
    rows.forEach((row, index) => {
      const rowHeight = Math.min(
        96,
        Math.max(
          24,
          ...columns.map((column) => measureCellHeight(doc, row[column.key], column.width, regularFont, 8)),
        ),
      );
      if (ensureSpace(doc, rowHeight + 24)) {
        drawTableHeader(doc, columns, boldFont);
      }
      drawTableRow(doc, columns, row, doc.y, rowHeight, regularFont, index % 2 === 0 ? '#ffffff' : TABLE_ALT_ROW_COLOR);
    });

    doc.end();
  });
}

export async function GET(request: Request, context: Context) {
  const { token } = await context.params;
  const priceList = await getPublicWholesalePriceList(token);
  if (!priceList) return Response.json({ error: 'Not found' }, { status: 404 });
  if (countPriceExportRows(priceList) > MAX_PRICE_EXPORT_ROWS) {
    return Response.json({ error: 'Price export is too large' }, { status: 413 });
  }

  const publicSession = getOrCreateSessionCookie(request, PUBLIC_PRICE_SESSION_COOKIE);
  const sessionId = publicSession.sessionId;
  const adminSession = await getAdminSession();
  const actorType = isManagerSessionRole(adminSession?.role) ? 'manager' : adminSession ? 'admin' : 'client';
  const actorUserId = isManagerSessionRole(adminSession?.role) ? adminSession?.managerId : null;

  const limitKey =
    actorUserId && actorType !== 'client'
      ? `pdf:user:${actorUserId}`
      : `pdf:price:${priceList.id}:session:${sessionId}`;
  const [mainLimit, globalLimit] = await Promise.all([
    checkDbRateLimit(limitKey, actorUserId ? PDF_USER_LIMIT : PDF_SESSION_LIMIT, PDF_LIMIT_WINDOW_MS),
    checkDbRateLimit('pdf:global', PDF_GLOBAL_LIMIT, PDF_LIMIT_WINDOW_MS),
  ]);

  if (!mainLimit.allowed || !globalLimit.allowed) {
    const retryAfter = Math.max(mainLimit.retryAfter, globalLimit.retryAfter);
    const response = Response.json(
      { error: 'Too many PDF downloads' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    );
    applySessionCookie(response.headers, publicSession);
    return response;
  }

  const cachedPdf = await readPricePdfCache(priceList);
  let pdf: Uint8Array | null = cachedPdf ? new Uint8Array(cachedPdf) : null;
  if (!pdf) {
    const generatedPdf = await createPdfWithSlot(priceList);
    if (!generatedPdf) {
      const response = Response.json(
        { error: 'PDF generation is busy' },
        { status: 429, headers: { 'Retry-After': '15' } },
      );
      applySessionCookie(response.headers, publicSession);
      return response;
    }
    pdf = new Uint8Array(generatedPdf);
    await writePricePdfCache(priceList, generatedPdf);
  }

  await trackAnalyticsEvent({
    eventType: 'public_price_pdf_downloaded',
    actorType,
    actorUserId,
    managerId: priceList.managerId,
    clientId: priceList.clientName ? priceList.clientName.trim().toLowerCase() : null,
    priceListId: priceList.id,
    token: priceList.token,
    sessionId,
    ip: getHeaderIp(request.headers),
    userAgent: request.headers.get('user-agent'),
    referer: request.headers.get('referer'),
    metadata: {
      title: priceList.title,
      clientName: priceList.clientName,
    },
  });
  if (actorType !== 'client') {
    await recordSecurityEvent({
      eventType: 'admin_pdf_downloaded',
      actorType: actorType === 'manager' ? 'manager' : adminSession?.role === 'wholesale_admin' ? 'wholesale_admin' : 'admin',
      adminUserId: adminSession?.adminUserId,
      managerId: actorType === 'manager' ? adminSession?.managerId : priceList.managerId,
      sessionId: adminSession?.sessionId,
      entityType: 'wholesale_price_list',
      entityId: priceList.id,
      ip: getHeaderIp(request.headers),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: {
        title: priceList.title,
        clientName: priceList.clientName,
      },
    });
  }

  const headers = new Headers({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${safeFilename(priceList.title) || `price-${priceList.id}`}.pdf`)}`,
    'Cache-Control': 'private, no-store',
  });
  applySessionCookie(headers, publicSession);

  const body = new ArrayBuffer(pdf.byteLength);
  new Uint8Array(body).set(pdf);
  return new Response(body, { headers });
}
