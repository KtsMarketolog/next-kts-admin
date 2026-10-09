/** Dedicated opt-in invoice audit. Never add these fields to generic usage events. */
export const MAX_PROFITABILITY_AUDIT_BODY = 1024 * 1024;
export const MAX_PROFITABILITY_INVOICE_LINES = 1000;
export type ProfitabilityInvoice = {
  schemaVersion: 1;
  documentType: 'invoice' | 'quote';
  invoiceNumber: string | null;
  currency: string;
  dealAmount: number | null;
  amountSource: 'document' | 'lines' | 'unavailable';
  lines: Array<{ nomenclature: string; quantity: number }>;
};
export type ProfitabilityAuditRequest = {
  eventId: string; dashboardKey: string; versionId: number; preview: boolean;
  invoice: ProfitabilityInvoice;
};

function fail(): never { throw new Error('Некорректная детализация'); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) return fail();
  return record;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return fail();
  return value;
}
function number(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > max) return fail();
  return value;
}
export function parseProfitabilityInvoice(value: unknown): ProfitabilityInvoice {
  const invoice = object(value, ['schemaVersion', 'documentType', 'invoiceNumber', 'currency', 'dealAmount', 'amountSource', 'lines']);
  if (invoice.schemaVersion !== 1 || (invoice.documentType !== 'invoice' && invoice.documentType !== 'quote')) return fail();
  const invoiceNumber = invoice.invoiceNumber === null ? null : text(invoice.invoiceNumber, 200);
  if (typeof invoice.currency !== 'string' || !/^[A-Z]{3}$/.test(invoice.currency)) return fail();
  if (invoice.amountSource !== 'document' && invoice.amountSource !== 'lines' && invoice.amountSource !== 'unavailable') return fail();
  const dealAmount = invoice.dealAmount === null ? null : number(invoice.dealAmount, 1e15);
  if ((dealAmount === null) !== (invoice.amountSource === 'unavailable')) return fail();
  if (!Array.isArray(invoice.lines) || !invoice.lines.length || invoice.lines.length > MAX_PROFITABILITY_INVOICE_LINES) return fail();
  const lines = invoice.lines.map((value) => {
    const line = object(value, ['nomenclature', 'quantity']);
    return { nomenclature: text(line.nomenclature, 500), quantity: number(line.quantity, 1e12) };
  });
  return { schemaVersion: 1, documentType: invoice.documentType as ProfitabilityInvoice['documentType'], invoiceNumber,
    currency: invoice.currency, dealAmount, amountSource: invoice.amountSource as ProfitabilityInvoice['amountSource'], lines };
}
export function parseProfitabilityAuditRequest(value: unknown): ProfitabilityAuditRequest {
  const input = object(value, ['eventId', 'dashboardKey', 'versionId', 'preview', 'invoice']);
  if (typeof input.eventId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(input.eventId)) return fail();
  if (typeof input.dashboardKey !== 'string' || !/^top:[1-9][0-9]{0,14}$/.test(input.dashboardKey)) return fail();
  if (!Number.isSafeInteger(input.versionId) || Number(input.versionId) < 1 || typeof input.preview !== 'boolean') return fail();
  return { eventId: input.eventId, dashboardKey: input.dashboardKey, versionId: Number(input.versionId), preview: input.preview,
    invoice: parseProfitabilityInvoice(input.invoice) };
}
