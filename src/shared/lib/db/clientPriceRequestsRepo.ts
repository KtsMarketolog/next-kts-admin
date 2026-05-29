import type { AdminSession } from '../adminAuth';
import { query } from './client';
import { assertClientCompanyVisible } from './clientCompaniesRepo';
import { ensureSiteSchema } from './schema';

export type ClientPriceRequestItemPrice = {
  amount: number;
  currency: string;
  lineTotal: number;
  convertedRubAmount: number | null;
  convertedRubLineTotal: number | null;
};

export type ClientPriceRequestItem = {
  priceItemId: number;
  productTitle: string;
  sku: string;
  variantTitle: string;
  quantity: number;
  prices: ClientPriceRequestItemPrice[];
};

export type ClientPriceRequest = {
  id: number;
  companyId: number;
  priceListId: number | null;
  token: string;
  priceTitle: string;
  clientName: string;
  managerId: number | null;
  supportManagerId: number | null;
  comment: string;
  totalQuantity: number;
  totalPriceLabel: string;
  totalConvertedRub: number | null;
  rubConversionInfo: string;
  convertedBreakdownLabel: string;
  items: ClientPriceRequestItem[];
  createdAt: string;
};

export type ClientPriceRequestInput = {
  companyId: number;
  priceListId: number | null;
  token: string;
  priceTitle: string;
  clientName: string;
  managerId: number | null;
  supportManagerId: number | null;
  comment: string;
  totalQuantity: number;
  totalPriceLabel: string;
  totalConvertedRub: number | null;
  rubConversionInfo: string;
  convertedBreakdownLabel: string;
  items: ClientPriceRequestItem[];
};

type ClientPriceRequestRow = {
  id: string;
  company_id: string;
  price_list_id: string | null;
  token: string;
  price_title: string;
  client_name: string;
  manager_id: string | null;
  support_manager_id: string | null;
  comment: string;
  total_quantity: number;
  total_price_label: string;
  total_converted_rub: string | null;
  rub_conversion_info: string;
  converted_breakdown_label: string;
  items_json: unknown;
  created_at: string;
};

function parseItemsJson(value: unknown): ClientPriceRequestItem[] {
  if (Array.isArray(value)) return value as ClientPriceRequestItem[];
  if (typeof value !== 'string') return [];

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as ClientPriceRequestItem[]) : [];
  } catch {
    return [];
  }
}

function mapClientPriceRequest(row: ClientPriceRequestRow): ClientPriceRequest {
  return {
    id: Number(row.id),
    companyId: Number(row.company_id),
    priceListId: row.price_list_id ? Number(row.price_list_id) : null,
    token: row.token,
    priceTitle: row.price_title,
    clientName: row.client_name,
    managerId: row.manager_id ? Number(row.manager_id) : null,
    supportManagerId: row.support_manager_id ? Number(row.support_manager_id) : null,
    comment: row.comment,
    totalQuantity: Number(row.total_quantity ?? 0),
    totalPriceLabel: row.total_price_label,
    totalConvertedRub: row.total_converted_rub === null ? null : Number(row.total_converted_rub),
    rubConversionInfo: row.rub_conversion_info,
    convertedBreakdownLabel: row.converted_breakdown_label,
    items: parseItemsJson(row.items_json),
    createdAt: row.created_at,
  };
}

const REQUEST_SELECT = `
  id::text,
  company_id::text,
  price_list_id::text,
  token,
  price_title,
  client_name,
  manager_id::text,
  support_manager_id::text,
  comment,
  total_quantity,
  total_price_label,
  total_converted_rub::text,
  rub_conversion_info,
  converted_breakdown_label,
  items_json,
  created_at::text
`;

export async function createClientPriceRequest(input: ClientPriceRequestInput): Promise<ClientPriceRequest> {
  await ensureSiteSchema();

  const result = await query<ClientPriceRequestRow>(
    `insert into client_price_requests (
       company_id,
       price_list_id,
       token,
       price_title,
       client_name,
       manager_id,
       support_manager_id,
       comment,
       total_quantity,
       total_price_label,
       total_converted_rub,
       rub_conversion_info,
       converted_breakdown_label,
       items_json
     )
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
     returning ${REQUEST_SELECT}`,
    [
      input.companyId,
      input.priceListId,
      input.token,
      input.priceTitle,
      input.clientName,
      input.managerId,
      input.supportManagerId,
      input.comment,
      input.totalQuantity,
      input.totalPriceLabel,
      input.totalConvertedRub,
      input.rubConversionInfo,
      input.convertedBreakdownLabel,
      JSON.stringify(input.items),
    ],
  );

  return mapClientPriceRequest(result.rows[0]);
}

export async function getClientPriceRequestsForAdmin(
  companyId: number,
  session: AdminSession,
): Promise<ClientPriceRequest[]> {
  await ensureSiteSchema();
  await assertClientCompanyVisible(companyId, session);

  const result = await query<ClientPriceRequestRow>(
    `select ${REQUEST_SELECT}
     from client_price_requests
     where company_id = $1
     order by created_at desc, id desc`,
    [companyId],
  );

  return result.rows.map(mapClientPriceRequest);
}

export async function getClientPriceRequestsForClient(companyId: number): Promise<ClientPriceRequest[]> {
  await ensureSiteSchema();

  const result = await query<ClientPriceRequestRow>(
    `select ${REQUEST_SELECT}
     from client_price_requests
     where company_id = $1
     order by created_at desc, id desc`,
    [companyId],
  );

  return result.rows.map(mapClientPriceRequest);
}
