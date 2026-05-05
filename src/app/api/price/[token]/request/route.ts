import nodemailer from 'nodemailer';

import { getPublicWholesalePriceList, getPublicWholesaleRequestItems, trackAnalyticsEvent } from '@/shared/lib/db';
import { PUBLIC_PRICE_SESSION_COOKIE, applySessionCookie, getOrCreateSessionCookie } from '@/shared/lib/publicSession';
import { checkDbRateLimit } from '@/shared/lib/rateLimit';

type Context = {
  params: Promise<{ token: string }>;
};

type RequestItemInput = {
  id: number;
  quantity: number;
};

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 32 * 1024;
const MAX_ITEMS = 100;
const MAX_QUANTITY = 999;
const REQUEST_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const REQUEST_SESSION_LIMIT = 3;
const REQUEST_GLOBAL_LIMIT = 100;

function getHeaderIp(headersList: Headers) {
  const forwardedFor = headersList.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwardedFor || headersList.get('x-real-ip') || 'unknown';
}

function jsonWithSession(body: unknown, init: ResponseInit, session: ReturnType<typeof getOrCreateSessionCookie>) {
  const response = Response.json(body, init);
  applySessionCookie(response.headers, session);
  return response;
}

function normalizeItems(input: unknown): RequestItemInput[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_ITEMS) return null;
  const items: RequestItemInput[] = [];
  const seen = new Set<number>();

  for (const item of input) {
    if (!item || typeof item !== 'object') return null;
    const source = item as Record<string, unknown>;
    const id = Number(source.id);
    const quantity = Number(source.quantity);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
      return null;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, quantity });
  }

  return items.length ? items : null;
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function money(value: number) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export async function POST(request: Request, context: Context) {
  const publicSession = getOrCreateSessionCookie(request, PUBLIC_PRICE_SESSION_COOKIE);
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return jsonWithSession({ ok: false, error: 'BODY_TOO_LARGE' }, { status: 413 }, publicSession);
  }

  const { token } = await context.params;
  const priceList = await getPublicWholesalePriceList(token);
  if (!priceList) return jsonWithSession({ ok: false, error: 'NOT_FOUND' }, { status: 404 }, publicSession);

  const [sessionLimit, globalLimit] = await Promise.all([
    checkDbRateLimit(
      `public_price_request:token:${priceList.token}:session:${publicSession.sessionId}`,
      REQUEST_SESSION_LIMIT,
      REQUEST_LIMIT_WINDOW_MS,
    ),
    checkDbRateLimit('public_price_request:global', REQUEST_GLOBAL_LIMIT, REQUEST_LIMIT_WINDOW_MS),
  ]);

  if (!sessionLimit.allowed || !globalLimit.allowed) {
    const retryAfter = Math.max(sessionLimit.retryAfter, globalLimit.retryAfter);
    return jsonWithSession(
      { ok: false, error: 'TOO_MANY_REQUESTS' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
      publicSession,
    );
  }

  const body = await request.json().catch(() => null);
  const requestedItems = normalizeItems(body && typeof body === 'object' ? (body as Record<string, unknown>).items : null);
  if (!requestedItems) {
    return jsonWithSession({ ok: false, error: 'INVALID_ITEMS' }, { status: 400 }, publicSession);
  }

  const itemIds = requestedItems.map((item) => item.id);
  const dbItems = await getPublicWholesaleRequestItems(priceList.token, itemIds);
  if (dbItems.length !== itemIds.length) {
    return jsonWithSession({ ok: false, error: 'INVALID_ITEMS' }, { status: 400 }, publicSession);
  }

  const dbItemsById = new Map(dbItems.map((item) => [item.id, item]));
  const rows = requestedItems.map((item) => {
    const dbItem = dbItemsById.get(item.id);
    if (!dbItem) throw new Error('Validated item disappeared');
    const price = Number(dbItem.wholesalePrice ?? 0);
    const safePrice = Number.isFinite(price) && price > 0 ? price : 0;
    return {
      ...dbItem,
      quantity: item.quantity,
      lineTotal: safePrice * item.quantity,
    };
  });

  const totalQuantity = rows.reduce((sum, item) => sum + item.quantity, 0);
  const totalPrice = rows.reduce((sum, item) => sum + item.lineTotal, 0);
  const priceUrl = new URL(`/price/${encodeURIComponent(priceList.token)}`, request.url).toString();

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT || 465),
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : true,
      auth: {
        user: requireEnv('SMTP_USER'),
        pass: requireEnv('SMTP_PASSWORD'),
      },
    });
    const mailFrom = process.env.SMTP_FROM || `"KTS" <${requireEnv('SMTP_USER')}>`;
    const mailTo = process.env.SMTP_TO || 'ktsmarketolog@yandex.ru';
    const subject = `Заявка из индивидуального прайса: ${priceList.title || 'Без названия'}`;
    const itemRows = rows
      .map(
        (item) => `
          <tr>
            <td>${escapeHtml(item.productTitle)}</td>
            <td>${escapeHtml(item.sku)}</td>
            <td>${escapeHtml(item.variantTitle)}</td>
            <td>${item.quantity}</td>
            <td>${escapeHtml(item.wholesalePrice ?? '0')}</td>
            <td>${money(item.lineTotal)}</td>
          </tr>
        `,
      )
      .join('');

    await transporter.sendMail({
      from: mailFrom,
      to: mailTo,
      subject,
      html: `
        <h2>${escapeHtml(subject)}</h2>
        <p><b>Источник:</b> публичный прайс</p>
        <p><b>Прайс:</b> <a href="${escapeHtml(priceUrl)}">${escapeHtml(priceList.title || 'Без названия')}</a></p>
        <p><b>Клиент:</b> ${escapeHtml(priceList.clientName || 'Не указан')}</p>
        <table border="1" cellpadding="6" cellspacing="0">
          <thead>
            <tr><th>Товар</th><th>Артикул</th><th>Размер</th><th>Кол-во</th><th>Цена</th><th>Сумма</th></tr>
          </thead>
          <tbody>${itemRows}</tbody>
        </table>
        <p><b>Итого позиций:</b> ${totalQuantity}</p>
        <p><b>Итого сумма:</b> ${money(totalPrice)}</p>
      `,
      text:
        `${subject}\n` +
        `Источник: публичный прайс\n` +
        `Прайс: ${priceList.title || 'Без названия'}\n` +
        `Ссылка: ${priceUrl}\n` +
        `Клиент: ${priceList.clientName || 'Не указан'}\n\n` +
        rows
          .map(
            (item) =>
              `${item.productTitle}; ${item.sku}; ${item.variantTitle}; ${item.quantity} шт.; цена ${item.wholesalePrice ?? '0'}; сумма ${money(item.lineTotal)}`,
          )
          .join('\n') +
        `\n\nИтого позиций: ${totalQuantity}\nИтого сумма: ${money(totalPrice)}\n`,
    });

    await trackAnalyticsEvent({
      eventType: 'public_price_request_sent',
      actorType: 'client',
      managerId: priceList.managerId,
      clientId: priceList.clientName ? priceList.clientName.trim().toLowerCase() : null,
      priceListId: priceList.id,
      token: priceList.token,
      sessionId: publicSession.sessionId,
      ip: getHeaderIp(request.headers),
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      metadata: {
        totalQuantity,
        totalPrice,
        itemCount: rows.length,
        items: rows.slice(0, 40).map((item) => ({
          priceItemId: item.id,
          productTitle: item.productTitle,
          variantTitle: item.variantTitle,
          quantity: item.quantity,
          lineTotal: item.lineTotal,
        })),
      },
    });

    return jsonWithSession({ ok: true }, {}, publicSession);
  } catch (error) {
    console.error('PUBLIC_PRICE_REQUEST_FAILED', error);
    return jsonWithSession({ ok: false, error: 'MAIL_FAILED' }, { status: 500 }, publicSession);
  }
}
