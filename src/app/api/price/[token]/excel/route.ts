import { getAdminSession, isManagerSessionRole } from '@/shared/lib/adminAuth';
import { getPublicWholesalePriceList, trackAnalyticsEvent } from '@/shared/lib/db';
import { recordSecurityEvent } from '@/shared/lib/db/securityAuditRepo';
import { PUBLIC_PRICE_SESSION_COOKIE, applySessionCookie, getOrCreateSessionCookie } from '@/shared/lib/publicSession';
import { checkDbRateLimit } from '@/shared/lib/rateLimit';
import { formatWholesaleStockLabel, hasVisibleWholesaleStock } from '@/shared/lib/wholesaleStockDisplay';

type Context = {
  params: Promise<{ token: string }>;
};

type PublicPriceList = NonNullable<Awaited<ReturnType<typeof getPublicWholesalePriceList>>>;
type PublicPriceProduct = PublicPriceList['categories'][number]['products'][number];
type PublicPriceVariant = PublicPriceProduct['variants'][number];

const NO_PRICE_GROUP_TITLE = 'Без ценовой группы';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EXCEL_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const EXCEL_SESSION_LIMIT = 30;
const EXCEL_USER_LIMIT = 60;
const EXCEL_GLOBAL_LIMIT = 500;
const MAX_PRICE_EXPORT_ROWS = 15_000;

function getHeaderIp(headersList: Headers) {
  const forwardedFor = headersList.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwardedFor || headersList.get('x-real-ip') || 'unknown';
}

function safeFilename(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/giu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function xmlEscape(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function cell(value: unknown, styleId = 'Body') {
  return `<Cell ss:StyleID="${styleId}"><Data ss:Type="String">${xmlEscape(value)}</Data></Cell>`;
}

function row(cells: string[], styleId?: string) {
  const attrs = styleId ? ` ss:StyleID="${styleId}"` : '';
  return `<Row${attrs}>${cells.join('')}</Row>`;
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
  return formatWholesaleStockLabel({
    stock: product.stock,
    unit: product.unit,
    isExpected: product.isExpected,
    mode: product.stockDisplayMode,
  });
}

function shouldShowStockColumn(priceList: PublicPriceList) {
  return priceList.categories.some((category) =>
    category.products.some((product) => hasVisibleWholesaleStock(product.stockDisplayMode)),
  );
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

function createExcelXml(priceList: PublicPriceList) {
  const showStock = shouldShowStockColumn(priceList);
  const columnCount = showStock ? 6 : 5;
  const rows: string[] = [
    row([`<Cell ss:MergeAcross="${columnCount - 1}" ss:StyleID="Title"><Data ss:Type="String">${xmlEscape(priceList.title || 'Индивидуальный прайс')}</Data></Cell>`]),
    row([`<Cell ss:MergeAcross="${columnCount - 1}" ss:StyleID="Subtitle"><Data ss:Type="String">Клиент: ${xmlEscape(priceList.clientName || 'Не указан')}</Data></Cell>`]),
    row([`<Cell ss:MergeAcross="${columnCount - 1}" ss:StyleID="Subtitle"><Data ss:Type="String">Действует до: ${xmlEscape(priceList.validUntil || 'Без срока')}</Data></Cell>`]),
  ];

  if (priceList.managerName || priceList.managerPhone || priceList.managerEmail) {
    rows.push(
      row([`<Cell ss:MergeAcross="${columnCount - 1}" ss:StyleID="Manager"><Data ss:Type="String">Ваш менеджер по прайсу: ${xmlEscape([priceList.managerName, priceList.managerPhone, priceList.managerEmail].filter(Boolean).join(' · '))}</Data></Cell>`]),
    );
  }

  rows.push(row(Array.from({ length: columnCount }, () => cell('', 'Body'))));

  const headers = ['Ценовая группа', 'Товар', 'Артикул', 'Описание', 'Индивидуальная цена'];
  if (showStock) headers.push('Остаток');
  rows.push(row(headers.map((title) => cell(title, 'Header'))));

  let hasItems = false;
  for (const group of groupProductsByPriceGroup(priceList)) {
    for (const product of group.products) {
      for (const variant of product.variants) {
        hasItems = true;
        const values = [
          group.title,
          product.title,
          product.sku || '—',
          product.description || '—',
          formatIndividualPrice(variant),
        ];
        if (showStock) values.push(hasVisibleWholesaleStock(product.stockDisplayMode) ? stockLabel(product) : '');
        rows.push(row(values.map((value) => cell(value))));
      }
    }
  }

  if (!hasItems) {
    rows.push(row([`<Cell ss:MergeAcross="${columnCount - 1}" ss:StyleID="Empty"><Data ss:Type="String">В прайс пока не добавлены товары.</Data></Cell>`]));
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal"><Font ss:FontName="Arial" ss:Size="10"/></Style>
  <Style ss:ID="Title"><Font ss:FontName="Arial" ss:Size="18" ss:Bold="1" ss:Color="#242633"/><Interior ss:Color="#F3F5FB" ss:Pattern="Solid"/><Alignment ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D9DCE8"/></Borders></Style>
  <Style ss:ID="Subtitle"><Font ss:FontName="Arial" ss:Size="10" ss:Color="#6F7182"/><Interior ss:Color="#F8F9FD" ss:Pattern="Solid"/></Style>
  <Style ss:ID="Manager"><Font ss:FontName="Arial" ss:Size="10" ss:Bold="1" ss:Color="#260B86"/><Interior ss:Color="#F8F9FD" ss:Pattern="Solid"/></Style>
  <Style ss:ID="Header"><Font ss:FontName="Arial" ss:Size="10" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#260B86" ss:Pattern="Solid"/><Alignment ss:Vertical="Center"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#260B86"/></Borders></Style>
  <Style ss:ID="Body"><Font ss:FontName="Arial" ss:Size="10" ss:Color="#242633"/><Alignment ss:Vertical="Top" ss:WrapText="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E1E3EF"/></Borders></Style>
  <Style ss:ID="Empty"><Font ss:FontName="Arial" ss:Size="11" ss:Color="#6F7182"/><Interior ss:Color="#F8F9FD" ss:Pattern="Solid"/></Style>
 </Styles>
 <Worksheet ss:Name="Прайс">
  <Table ss:DefaultRowHeight="22">
   <Column ss:Width="150"/>
   <Column ss:Width="260"/>
   <Column ss:Width="110"/>
   <Column ss:Width="220"/>
   <Column ss:Width="170"/>
   ${showStock ? '<Column ss:Width="130"/>' : ''}
   ${rows.join('\n   ')}
  </Table>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
   <FreezePanes/>
   <FrozenNoSplit/>
   <SplitHorizontal>5</SplitHorizontal>
   <TopRowBottomPane>5</TopRowBottomPane>
   <ActivePane>2</ActivePane>
  </WorksheetOptions>
 </Worksheet>
</Workbook>`;
}

function countPriceExportRows(priceList: PublicPriceList) {
  return priceList.categories.reduce(
    (sum, category) => sum + category.products.reduce((productSum, product) => productSum + product.variants.length, 0),
    0,
  );
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
      ? `excel:user:${actorUserId}`
      : `excel:price:${priceList.id}:session:${sessionId}`;
  const [mainLimit, globalLimit] = await Promise.all([
    checkDbRateLimit(limitKey, actorUserId ? EXCEL_USER_LIMIT : EXCEL_SESSION_LIMIT, EXCEL_LIMIT_WINDOW_MS),
    checkDbRateLimit('excel:global', EXCEL_GLOBAL_LIMIT, EXCEL_LIMIT_WINDOW_MS),
  ]);

  if (!mainLimit.allowed || !globalLimit.allowed) {
    const retryAfter = Math.max(mainLimit.retryAfter, globalLimit.retryAfter);
    const response = Response.json(
      { error: 'Too many Excel downloads' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    );
    applySessionCookie(response.headers, publicSession);
    return response;
  }

  const excel = new TextEncoder().encode(createExcelXml(priceList));

  await trackAnalyticsEvent({
    eventType: 'public_price_excel_downloaded',
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
      eventType: 'admin_excel_downloaded',
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
    'Content-Type': 'application/vnd.ms-excel; charset=utf-8',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${safeFilename(priceList.title) || `price-${priceList.id}`}.xls`)}`,
    'Cache-Control': 'private, no-store',
  });
  applySessionCookie(headers, publicSession);

  const body = new ArrayBuffer(excel.byteLength);
  new Uint8Array(body).set(excel);
  return new Response(body, { headers });
}
