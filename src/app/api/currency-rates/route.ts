export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CBR_DAILY_XML_URL = 'https://www.cbr.ru/scripts/XML_daily.asp';
const SBEROMETER_CBR_URL = 'https://www.sberometer.ru/cbr/?currencyTable=CNY%2CUSD%2CEUR&currency=USD';
const RATE_CODES = ['USD', 'EUR', 'CNY'] as const;

type CurrencyCode = (typeof RATE_CODES)[number];

function parseDecimal(value: string | undefined) {
  if (!value) return null;
  const number = Number(value.replace(/\s+/g, '').replace(',', '.'));
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parseCurrencyRate(xml: string, code: CurrencyCode) {
  const blocks = xml.match(/<Valute[^>]*>[\s\S]*?<\/Valute>/g) ?? [];
  const block = blocks.find((value) => value.includes(`<CharCode>${code}</CharCode>`));
  if (!block) throw new Error(`Currency ${code} was not found in CBR response`);

  const nominal = parseDecimal(block.match(/<Nominal>([^<]+)<\/Nominal>/)?.[1]);
  const value = parseDecimal(block.match(/<Value>([^<]+)<\/Value>/)?.[1]);
  if (!nominal || !value) throw new Error(`Currency ${code} has invalid CBR values`);

  return value / nominal;
}

function parseCbrRates(xml: string) {
  return RATE_CODES.reduce(
    (rates, code) => {
      rates[code] = parseCurrencyRate(xml, code);
      return rates;
    },
    {} as Record<CurrencyCode, number>,
  );
}

export async function GET() {
  try {
    const response = await fetch(CBR_DAILY_XML_URL, {
      headers: {
        Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'kts-impex.ru price currency converter',
      },
      next: { revalidate: 60 * 60 },
    });

    if (!response.ok) {
      return Response.json({ ok: false, error: 'RATES_SOURCE_FAILED' }, { status: 502 });
    }

    const xml = await response.text();
    const date = xml.match(/<ValCurs[^>]*Date="([^"]+)"/)?.[1] ?? null;

    return Response.json({
      ok: true,
      base: 'RUB',
      date,
      rates: parseCbrRates(xml),
      sourceName: 'ЦБ РФ',
      sourceUrl: SBEROMETER_CBR_URL,
      cbrSourceUrl: CBR_DAILY_XML_URL,
    });
  } catch (error) {
    console.error('CURRENCY_RATES_FAILED', error);
    return Response.json({ ok: false, error: 'RATES_UNAVAILABLE' }, { status: 502 });
  }
}
