import {
  makeToken,
  mergeEditorItems,
  normalizePriceGroupStockSettings,
  type CatalogCategory,
  type ClientCompanyOption,
  type PriceEditor,
} from './AdminWholesaleModel';

type PriceListPayload = {
  id?: number;
  title?: string | null;
  clientCompanyId?: number | null;
  clientName?: string | null;
  token?: string | null;
  validUntil?: string | null;
  comment?: string | null;
  workflowStatus?: PriceEditor['workflowStatus'] | null;
  showRetailPrices?: boolean | null;
  showStock?: boolean | null;
  showStockText?: boolean | null;
  isActive?: boolean | null;
  managerId?: number | null;
  supportManagerId?: number | null;
  items?: PriceEditor['items'];
  priceGroupStockSettings?: PriceEditor['priceGroupStockSettings'];
};

export function normalizeClientCompanyOptions(data: unknown): ClientCompanyOption[] {
  const payload = data as { companies?: ClientCompanyOption[] };
  return Array.isArray(payload.companies)
    ? payload.companies
        .filter((company) => company && company.isActive !== false)
        .map((company) => ({
          id: Number(company.id),
          title: String(company.title ?? '').trim(),
          managerId: Number.isInteger(Number(company.managerId)) && Number(company.managerId) > 0 ? Number(company.managerId) : null,
          supportManagerId:
            Number.isInteger(Number(company.supportManagerId)) && Number(company.supportManagerId) > 0
              ? Number(company.supportManagerId)
              : null,
          isActive: company.isActive !== false,
        }))
        .filter((company) => Number.isInteger(company.id) && company.id > 0 && company.title)
        .sort((first, second) => first.title.localeCompare(second.title, 'ru'))
    : [];
}

export function buildPriceEditorFromPayload(
  priceList: PriceListPayload,
  catalog: CatalogCategory[],
  clientCompanies: ClientCompanyOption[],
): PriceEditor {
  const selectedClientCompany = clientCompanies.find((company) => company.id === priceList.clientCompanyId) ?? null;
  return {
    id: priceList.id,
    title: priceList.title ?? '',
    clientCompanyId: priceList.clientCompanyId ?? null,
    clientName: priceList.clientName ?? '',
    token: priceList.token ?? makeToken(),
    validUntil: priceList.validUntil ?? '',
    comment: priceList.comment ?? '',
    workflowStatus: priceList.workflowStatus ?? 'not_sent',
    showRetailPrices: Boolean(priceList.showRetailPrices),
    showStock: priceList.showStock !== false,
    showStockText: Boolean(priceList.showStockText),
    isActive: Boolean(priceList.isActive),
    managerId: selectedClientCompany ? selectedClientCompany.managerId : priceList.managerId ?? null,
    supportManagerId: selectedClientCompany ? selectedClientCompany.supportManagerId : priceList.supportManagerId ?? null,
    items: mergeEditorItems(catalog, Array.isArray(priceList.items) ? priceList.items : []),
    priceGroupStockSettings: normalizePriceGroupStockSettings(priceList.priceGroupStockSettings),
  };
}
