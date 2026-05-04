import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import PDFDocument from 'pdfkit';

import { getAdminSession } from '@/shared/lib/adminAuth';
import { getPublicWholesalePriceList, trackAnalyticsEvent } from '@/shared/lib/db';

type Context = {
  params: Promise<{ token: string }>;
};

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SESSION_COOKIE = 'kts_price_analytics_sid';
const SESSION_MAX_AGE = 60 * 60 * 24 * 365;

function getHeaderIp(headersList: Headers) {
  const forwardedFor = headersList.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwardedFor || headersList.get('x-real-ip') || 'unknown';
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get('cookie') || '';
  return cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function sessionCookie(value: string) {
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${SESSION_MAX_AGE}; SameSite=Lax; Secure; HttpOnly`;
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
    doc.moveDown(1);

    if (priceList.categories.length === 0) {
      doc.font(regularFont).fontSize(12).text('В прайс пока не добавлены товары.');
      doc.end();
      return;
    }

    for (const category of priceList.categories) {
      doc.font(boldFont).fontSize(15).text(category.title, { underline: true });
      doc.moveDown(0.4);
      for (const product of category.products) {
        doc.font(boldFont).fontSize(12).text(product.title, { continued: false });
        if (product.sku) doc.font(regularFont).fontSize(9).fillColor('#666').text(`Артикул: ${product.sku}`).fillColor('#000');
        for (const variant of product.variants) {
          const parts = [
            variant.title,
            priceList.showRetailPrices ? `розница: ${variant.retailPrice ?? '—'}` : '',
            `опт: ${variant.wholesalePrice ?? '—'}`,
          ].filter(Boolean);
          doc.font(regularFont).fontSize(10).text(`• ${parts.join(' | ')}`);
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

  const existingSessionId = cookieValue(request, SESSION_COOKIE);
  const sessionId = existingSessionId || randomUUID();
  const adminSession = await getAdminSession();
  const actorType = adminSession?.role === 'manager' ? 'manager' : adminSession ? 'admin' : 'client';
  const actorUserId = adminSession?.role === 'manager' ? adminSession.managerId : null;

  const pdf = await createPdf(priceList);

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

  const headers = new Headers({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${safeFilename(priceList.title) || `price-${priceList.id}`}.pdf`)}`,
    'Cache-Control': 'private, no-store',
  });
  if (!existingSessionId) headers.set('Set-Cookie', sessionCookie(sessionId));

  return new Response(new Uint8Array(pdf), { headers });
}
