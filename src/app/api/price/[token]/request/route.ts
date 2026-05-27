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

type CurrencyCode = 'EUR' | 'CNY';

type RubConversionInput = {
  date: string | null;
  rates: Record<CurrencyCode, number>;
  itemIds: Set<number>;
};

type RequestPrice = {
  amount: number;
  currency: string;
  lineTotal: number;
  convertedRubAmount: number | null;
  convertedRubLineTotal: number | null;
};

type ConvertedCurrencyTotal = {
  currency: string;
  amount: number;
  rubAmount: number;
};

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 32 * 1024;
const MAX_ITEMS = 100;
const MAX_QUANTITY = 999;
const MAX_COMMENT_LENGTH = 1000;
const MAX_RATE_DATE_LENGTH = 40;
const REQUEST_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const REQUEST_SESSION_LIMIT = 3;
const REQUEST_GLOBAL_LIMIT = 100;
const DEFAULT_PRICE_REQUEST_RECIPIENT = 'ktsmarketolog@yandex.ru';

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

function normalizeComment(input: unknown) {
  if (typeof input !== 'string') return '';
  return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().slice(0, MAX_COMMENT_LENGTH);
}

function normalizeRate(input: unknown) {
  const rate = Number(input);
  return Number.isFinite(rate) && rate > 0 && rate < 1_000_000 ? rate : null;
}

function normalizeRubConversion(input: unknown, allowedItemIds: Set<number>): RubConversionInput | null {
  if (!input || typeof input !== 'object') return null;
  const payload = input as Record<string, unknown>;
  const rates = payload.rates as Record<string, unknown> | undefined;
  const eur = normalizeRate(rates?.EUR);
  const cny = normalizeRate(rates?.CNY);
  if (eur === null || cny === null || !Array.isArray(payload.itemIds)) return null;

  const itemIds = new Set<number>();
  for (const value of payload.itemIds.slice(0, MAX_ITEMS)) {
    const id = Number(value);
    if (Number.isInteger(id) && allowedItemIds.has(id)) {
      itemIds.add(id);
    }
  }
  if (itemIds.size === 0) return null;

  const date = typeof payload.date === 'string' ? payload.date.trim().slice(0, MAX_RATE_DATE_LENGTH) || null : null;
  return { date, rates: { EUR: eur, CNY: cny }, itemIds };
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

function rubMoney(value: number) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(value));
}

function parseMoneyValue(value: string | null) {
  if (!value) return null;
  const number = Number(value.replace(/\s+/g, '').replace(',', '.'));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function formatAmount(value: number, currency?: string) {
  return `${money(value)}${currency ? ` ${currency}` : ''}`;
}

function formatAmountList(values: Array<{ amount: number; currency: string }>) {
  if (values.length === 0) return '0';
  return values.map((value) => formatAmount(value.amount, value.currency)).join(' / ');
}

function formatConvertedRubAmount(value: number) {
  return `≈ ${rubMoney(value)} RUB`;
}

function formatRubValues(prices: RequestPrice[], mode: 'price' | 'total') {
  return prices
    .map((price) => (mode === 'price' ? price.convertedRubAmount : price.convertedRubLineTotal))
    .filter((value): value is number => value !== null)
    .map(formatConvertedRubAmount);
}

function formatRubValuesText(prices: RequestPrice[], mode: 'price' | 'total') {
  const rubValues = formatRubValues(prices, mode);
  return rubValues.length > 0 ? rubValues.join(' / ') : '';
}

function formatRubValuesHtml(prices: RequestPrice[], mode: 'price' | 'total') {
  return escapeHtml(formatRubValuesText(prices, mode));
}

function getConvertedRubAmount(price: { amount: number; currency: string }, rubConversion: RubConversionInput | null) {
  if (!rubConversion) return null;
  if (price.currency === 'RUB') return price.amount;
  if (price.currency !== 'EUR' && price.currency !== 'CNY') return null;
  return Math.round(price.amount * rubConversion.rates[price.currency]);
}

function formatRubConversionInfo(rubConversion: RubConversionInput) {
  const date = rubConversion.date || 'сегодня';
  return `Курс ЦБ на ${date}: EUR ${money(rubConversion.rates.EUR)}, CNY ${money(rubConversion.rates.CNY)}`;
}

function formatConvertedBreakdown(values: ConvertedCurrencyTotal[]) {
  if (values.length === 0) return '';
  return values.map((value) => `${formatAmount(value.amount, value.currency)} → ${formatConvertedRubAmount(value.rubAmount)}`).join('; ');
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function splitRecipients(value: string) {
  return value
    .split(/[;,]/)
    .map((recipient) => recipient.trim())
    .filter(Boolean);
}

function priceRequestRecipients(managerEmails: string[]) {
  const recipients = [
    ...splitRecipients(process.env.SMTP_TO || DEFAULT_PRICE_REQUEST_RECIPIENT),
    DEFAULT_PRICE_REQUEST_RECIPIENT,
    ...managerEmails.map((email) => email.trim()),
  ].filter(Boolean);
  const seen = new Set<string>();

  return recipients.filter((recipient) => {
    const key = recipient.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const bodyRecord = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  const requestedItems = normalizeItems(bodyRecord?.items);
  const comment = normalizeComment(bodyRecord?.comment);
  if (!requestedItems) {
    return jsonWithSession({ ok: false, error: 'INVALID_ITEMS' }, { status: 400 }, publicSession);
  }
  const requestedItemIds = new Set(requestedItems.map((item) => item.id));
  const rubConversion = normalizeRubConversion(bodyRecord?.rubConversion, requestedItemIds);

  const itemIds = requestedItems.map((item) => item.id);
  const dbItems = await getPublicWholesaleRequestItems(priceList.token, itemIds);
  if (dbItems.length !== itemIds.length) {
    return jsonWithSession({ ok: false, error: 'INVALID_ITEMS' }, { status: 400 }, publicSession);
  }

  const dbItemsById = new Map(dbItems.map((item) => [item.id, item]));
  const rows = requestedItems.map((item) => {
    const dbItem = dbItemsById.get(item.id);
    if (!dbItem) throw new Error('Validated item disappeared');
    const shouldConvertToRub = rubConversion?.itemIds.has(item.id) === true;
    const currencyPrices = [
      { amount: parseMoneyValue(dbItem.priceEur), currency: 'EUR' },
      { amount: parseMoneyValue(dbItem.priceRub), currency: 'RUB' },
      { amount: parseMoneyValue(dbItem.priceCny), currency: 'CNY' },
    ]
      .filter((price): price is { amount: number; currency: string } => price.amount !== null)
      .map((price): RequestPrice => {
        const convertedRubAmount = shouldConvertToRub ? getConvertedRubAmount(price, rubConversion) : null;
        return {
          amount: price.amount,
          currency: price.currency,
          lineTotal: price.amount * item.quantity,
          convertedRubAmount,
          convertedRubLineTotal: convertedRubAmount !== null ? convertedRubAmount * item.quantity : null,
        };
      });
    const fallbackPrice = parseMoneyValue(dbItem.wholesalePrice);
    const prices =
      currencyPrices.length > 0
        ? currencyPrices
        : fallbackPrice
          ? [{ amount: fallbackPrice, currency: '', lineTotal: fallbackPrice * item.quantity, convertedRubAmount: null, convertedRubLineTotal: null }]
          : [];
    return {
      ...dbItem,
      quantity: item.quantity,
      prices,
    };
  });

  const totalQuantity = rows.reduce((sum, item) => sum + item.quantity, 0);
  const totalByCurrency = new Map<string, number>();
  for (const row of rows) {
    for (const price of row.prices) {
      totalByCurrency.set(price.currency, (totalByCurrency.get(price.currency) ?? 0) + price.lineTotal);
    }
  }
  const totalAmounts = Array.from(totalByCurrency.entries()).map(([currency, amount]) => ({ currency, amount }));
  const totalPriceLabel = formatAmountList(totalAmounts);
  const totalConvertedRub = rows.reduce(
    (sum, row) => sum + row.prices.reduce((rowSum, price) => rowSum + (price.convertedRubLineTotal ?? 0), 0),
    0,
  );
  const hasConvertedRubValues = totalConvertedRub > 0;
  const convertedByCurrency = new Map<string, ConvertedCurrencyTotal>();
  for (const row of rows) {
    for (const price of row.prices) {
      if (price.convertedRubLineTotal === null) continue;
      const key = price.currency || 'Сумма';
      const current = convertedByCurrency.get(key) ?? { currency: price.currency, amount: 0, rubAmount: 0 };
      current.amount += price.lineTotal;
      current.rubAmount += price.convertedRubLineTotal;
      convertedByCurrency.set(key, current);
    }
  }
  const convertedTotals = Array.from(convertedByCurrency.values());
  const convertedBreakdownLabel = formatConvertedBreakdown(convertedTotals);
  const rubConversionInfo = rubConversion && hasConvertedRubValues ? formatRubConversionInfo(rubConversion) : '';
  const priceUrl = new URL(`/price/${encodeURIComponent(priceList.token)}`, request.url).toString();
  const commentHtml = comment ? escapeHtml(comment).replaceAll('\n', '<br>') : '';

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
    const mailTo = priceRequestRecipients([priceList.managerEmail, priceList.supportManagerEmail]).join(', ');
    const subject = `Заявка из индивидуального прайса: ${priceList.title || 'Без названия'}`;
    const rubHeaders = hasConvertedRubValues ? '<th>Цена RUB</th><th>Сумма RUB</th>' : '';
    const itemRows = rows
      .map((item) => {
        const lineTotals = item.prices.map((price) => ({ amount: price.lineTotal, currency: price.currency }));
        const itemRubPriceText = formatRubValuesText(item.prices, 'price');
        const itemRubTotalText = formatRubValuesText(item.prices, 'total');
        const rubCells = hasConvertedRubValues
          ? `<td>${itemRubPriceText ? formatRubValuesHtml(item.prices, 'price') : ''}</td><td>${itemRubTotalText ? formatRubValuesHtml(item.prices, 'total') : ''}</td>`
          : '';

        return `
          <tr>
            <td>${escapeHtml(item.productTitle)}</td>
            <td>${escapeHtml(item.sku)}</td>
            <td>${escapeHtml(item.variantTitle)}</td>
            <td>${item.quantity}</td>
            <td>${escapeHtml(formatAmountList(item.prices))}</td>
            <td>${escapeHtml(formatAmountList(lineTotals))}</td>
            ${rubCells}
          </tr>
        `;
      })
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
        ${commentHtml ? `<p><b>Комментарий клиента:</b><br>${commentHtml}</p>` : ''}
        ${rubConversionInfo ? `<p><b>Пересчет в рубли:</b> ${escapeHtml(rubConversionInfo)}</p>` : ''}
        <table border="1" cellpadding="6" cellspacing="0">
          <thead>
            <tr><th>Товар</th><th>Артикул</th><th>Размер</th><th>Кол-во</th><th>Цена</th><th>Сумма</th>${rubHeaders}</tr>
          </thead>
          <tbody>${itemRows}</tbody>
        </table>
        <p><b>Итого позиций:</b> ${totalQuantity}</p>
        <p><b>Итого сумма:</b> ${escapeHtml(totalPriceLabel)}</p>
        ${hasConvertedRubValues ? `<p><b>Итого в рублях по пересчету:</b> ${escapeHtml(formatConvertedRubAmount(totalConvertedRub))}</p>` : ''}
        ${convertedBreakdownLabel ? `<p><b>В пересчет вошло:</b> ${escapeHtml(convertedBreakdownLabel)}</p>` : ''}
      `,
      text:
        `${subject}\n` +
        `Источник: публичный прайс\n` +
        `Прайс: ${priceList.title || 'Без названия'}\n` +
        `Ссылка: ${priceUrl}\n` +
        `Клиент: ${priceList.clientName || 'Не указан'}\n\n` +
        (comment ? `Комментарий клиента:\n${comment}\n\n` : '') +
        (rubConversionInfo ? `Пересчет в рубли: ${rubConversionInfo}\n\n` : '') +
        rows
          .map((item) => {
            const lineTotals = item.prices.map((price) => ({ amount: price.lineTotal, currency: price.currency }));
            const itemRubPriceText = formatRubValuesText(item.prices, 'price');
            const itemRubTotalText = formatRubValuesText(item.prices, 'total');
            const rubText = itemRubPriceText || itemRubTotalText
              ? `; цена RUB ${itemRubPriceText}; сумма RUB ${itemRubTotalText}`
              : '';
            return `${item.productTitle}; ${item.sku}; ${item.variantTitle}; ${item.quantity} шт.; цена ${formatAmountList(
              item.prices,
            )}; сумма ${formatAmountList(lineTotals)}${rubText}`;
          })
          .join('\n') +
        `\n\nИтого позиций: ${totalQuantity}\nИтого сумма: ${totalPriceLabel}\n` +
        (hasConvertedRubValues ? `Итого в рублях по пересчету: ${formatConvertedRubAmount(totalConvertedRub)}\n` : '') +
        (convertedBreakdownLabel ? `В пересчет вошло: ${convertedBreakdownLabel}\n` : ''),
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
        totalPrice: totalPriceLabel,
        totalByCurrency: Object.fromEntries(totalAmounts.map((item) => [item.currency || 'amount', item.amount])),
        rubConversion: hasConvertedRubValues
          ? {
              totalRub: Math.round(totalConvertedRub),
              date: rubConversion?.date ?? null,
              rates: rubConversion?.rates ?? null,
            }
          : null,
        hasComment: Boolean(comment),
        commentLength: comment.length,
        itemCount: rows.length,
        items: rows.slice(0, 40).map((item) => ({
          priceItemId: item.id,
          productTitle: item.productTitle,
          variantTitle: item.variantTitle,
          quantity: item.quantity,
          totals: item.prices.map((price) => ({ currency: price.currency, amount: price.lineTotal })),
          convertedRubTotals: item.prices
            .filter((price) => price.convertedRubLineTotal !== null)
            .map((price) => ({ sourceCurrency: price.currency, amount: Math.round(price.convertedRubLineTotal ?? 0) })),
        })),
      },
    });

    return jsonWithSession({ ok: true }, {}, publicSession);
  } catch (error) {
    console.error('PUBLIC_PRICE_REQUEST_FAILED', error);
    return jsonWithSession({ ok: false, error: 'MAIL_FAILED' }, { status: 500 }, publicSession);
  }
}
