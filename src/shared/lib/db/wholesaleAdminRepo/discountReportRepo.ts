import { query } from '../client';
import { ensureSiteSchema } from '../schema';
import type { WholesaleDiscountReportRow } from './types';

type WholesaleDiscountReportSourceRow = {
  price_list_id: string;
  price_title: string;
  price_group: string;
  company: string | null;
  manager: string | null;
  custom_wholesale_price: string | null;
  discount_percent: string | null;
  price_manually_changed: boolean;
  effective_wholesale_price: string | null;
  price_rub: string | null;
  retail_price: string | null;
  wholesale_price: string | null;
  price_eur: string | null;
  price_cny: string | null;
};

function parseDiscountReportAmount(value: string | null | undefined) {
  if (!value) return null;
  const normalized = String(value).replace(/\s+/g, '').replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatDiscountReportPercent(value: number) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace('.', ',');
}

function parseDiscountReportPercent(value: string | null | undefined) {
  if (!value) return null;
  const normalized = String(value).replace(/\s+/g, '').replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}

function resolveDiscountReportValue(rows: WholesaleDiscountReportSourceRow[]) {
  const discounts: number[] = [];

  for (const row of rows) {
    const basePrice =
      parseDiscountReportAmount(row.price_rub) ??
      parseDiscountReportAmount(row.price_eur) ??
      parseDiscountReportAmount(row.price_cny) ??
      parseDiscountReportAmount(row.retail_price) ??
      parseDiscountReportAmount(row.wholesale_price);

    const discountPercent = row.price_manually_changed ? null : parseDiscountReportPercent(row.discount_percent);
    const actualPrice = discountPercent !== null && basePrice
      ? basePrice * (1 - discountPercent / 100)
      : row.price_manually_changed
        ? parseDiscountReportAmount(row.custom_wholesale_price) ?? parseDiscountReportAmount(row.effective_wholesale_price)
        : basePrice;

    if (!basePrice || !actualPrice) continue;
    const discount = (1 - actualPrice / basePrice) * 100;
    if (discount <= 0.05) continue;
    if (discount > 100) return 'Разная';
    discounts.push(discount);
  }

  if (!discounts.length) return '0%';
  const first = discounts[0];
  const hasMixedDiscount = discounts.some((discount) => Math.abs(discount - first) > 0.15);
  return hasMixedDiscount ? 'Разная' : `${formatDiscountReportPercent(first)}%`;
}

export async function getWholesaleDiscountReportRows(): Promise<WholesaleDiscountReportRow[]> {
  await ensureSiteSchema();
  const result = await query<WholesaleDiscountReportSourceRow>(
    `select pl.id::text as price_list_id,
            pl.title as price_title,
            coalesce(nullif(trim(p.price_group), ''), 'Без ценовой группы') as price_group,
            nullif(trim(pl.client_name), '') as company,
            nullif(trim(m.name), '') as manager,
            i.custom_wholesale_price::text as custom_wholesale_price,
            i.discount_percent::text as discount_percent,
            i.price_manually_changed,
            coalesce(i.custom_wholesale_price, v.wholesale_price, p.wholesale_price)::text as effective_wholesale_price,
            p.price_rub::text as price_rub,
            coalesce(v.retail_price, p.retail_price)::text as retail_price,
            coalesce(v.wholesale_price, p.wholesale_price)::text as wholesale_price,
            p.price_eur::text as price_eur,
            p.price_cny::text as price_cny
     from wholesale_price_list_items i
     join wholesale_price_lists pl on pl.id = i.price_list_id
     join wholesale_products p on p.id = i.wholesale_product_id
     left join wholesale_product_variants v on v.id = i.wholesale_variant_id and v.product_id = p.id
     left join wholesale_managers m on m.id = pl.manager_id
     where i.visible = true
       and p.is_active = true
       and (v.id is null or v.is_active = true)
     order by price_group asc, pl.created_at desc, pl.id desc, i.sort_order asc, i.id asc`,
  );

  const grouped = new Map<string, WholesaleDiscountReportSourceRow[]>();
  for (const row of result.rows) {
    const key = `${row.price_group}\u0000${row.price_list_id}`;
    const groupRows = grouped.get(key);
    if (groupRows) {
      groupRows.push(row);
    } else {
      grouped.set(key, [row]);
    }
  }

  return Array.from(grouped.values()).map((rows) => {
    const first = rows[0];
    return {
      priceGroup: first.price_group,
      discount: resolveDiscountReportValue(rows),
      company: first.company || '—',
      manager: first.manager || '—',
      priceId: Number(first.price_list_id),
      priceTitle: first.price_title,
    };
  });
}
