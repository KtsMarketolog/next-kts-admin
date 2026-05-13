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

const NO_PRICE_GROUP_TITLE = 'Без ценовой группы';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PDF_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const PDF_SESSION_LIMIT = 20;
const PDF_USER_LIMIT = 40;
const PDF_GLOBAL_LIMIT = 300;
const MAX_CONCURRENT_PDF_GENERATIONS = 3;

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
    { value: variant.priceEur, currency: 'EUR' },
    { value: variant.priceRub, currency: 'RUB' },
    { value: variant.priceCny, currency: 'CNY' },
  ].filter((price) => hasPriceValue(price.value));

  if (currencyPrices.length === 0) return formatPrice(variant.wholesalePrice);

  return currencyPrices.map((price) => `${formatPrice(price.value)} ${price.currency}`).join(' / ');
}

function stockLabel(product: PublicPriceProduct) {
  if (product.stock > 0) return `В наличии: ${product.stock} шт.`;
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

function createPdf(priceList: NonNullable<Awaited<ReturnType<typeof getPublicWholesalePriceList>>>) {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 42 });
    const chunks: Buffer[] = [];
    const fonts = fontPaths();
    const regularFont = fonts.regular ? 'Regular' : 'Helvetica';
    const boldFont = fonts.bold ? 'Bold' : regularFont;
    if (fonts.regular) doc.registerFont(regularFont, fonts.regular);
    if (fonts.bold) doc.registerFont(boldFont, fonts.bold);

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font(boldFont).fontSize(20).text(priceList.title || 'Индивидуальный прайс', { align: 'left' });
    doc.moveDown(0.4);
    if (priceList.clientName) doc.font(regularFont).fontSize(11).text(`Клиент: ${priceList.clientName}`);
    if (priceList.validUntil) doc.font(regularFont).fontSize(11).text(`Действует до: ${priceList.validUntil}`);
    if (priceList.managerName || priceList.managerPhone || priceList.managerEmail) {
      doc.moveDown(0.4);
      doc.font(boldFont).fontSize(11).text('Ваш менеджер по прайсу');
      if (priceList.managerName) doc.font(regularFont).fontSize(10).text(priceList.managerName);
      if (priceList.managerPhone) doc.font(regularFont).fontSize(10).text(priceList.managerPhone);
      if (priceList.managerEmail) doc.font(regularFont).fontSize(10).text(priceList.managerEmail);
    }
    doc.moveDown(1);

    if (priceList.categories.length === 0) {
      doc.font(regularFont).fontSize(12).text('В прайс пока не добавлены товары.');
      doc.end();
      return;
    }

    for (const group of groupProductsByPriceGroup(priceList)) {
      if (doc.y > 730) doc.addPage();
      doc.font(boldFont).fontSize(15).text(group.title, { underline: true });
      doc.moveDown(0.4);
      for (const product of group.products) {
        if (doc.y > 735) doc.addPage();
        doc.font(boldFont).fontSize(12).text(product.title, { continued: false });
        const productMeta = [
          product.sku ? `Артикул: ${product.sku}` : '',
          product.description,
          priceList.showStock ? stockLabel(product) : '',
        ].filter(Boolean);
        if (productMeta.length > 0) {
          doc.font(regularFont).fontSize(9).fillColor('#666').text(productMeta.join(' · ')).fillColor('#000');
        }
        for (const variant of product.variants) {
          doc.font(regularFont).fontSize(10).text(`• Индивидуальная цена: ${formatIndividualPrice(variant)}`);
        }
        doc.moveDown(0.5);
        if (doc.y > 760) doc.addPage();
      }
      doc.moveDown(0.4);
    }

    doc.end();
  });
}

export async function GET(request: Request, context: Context) {
  const { token } = await context.params;
  const priceList = await getPublicWholesalePriceList(token);
  if (!priceList) return Response.json({ error: 'Not found' }, { status: 404 });

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
