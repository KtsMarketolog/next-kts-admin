type UploadLabelInput = {
  ariaLabel?: string | null;
  label?: string | null;
  title?: string | null;
  accept: string;
  multiple: boolean;
  directory: boolean;
  index: number;
};

/**
 * Presentation only: input IDs/names remain untouched for snapshot restoration.
 * Keep this function self-contained: its source also runs in the isolated HTML
 * adapter, so static and runtime discovery use exactly the same label rules.
 */
export function getTopDashboardUploadLabel(input: UploadLabelInput): string {
  for (const candidate of [input.ariaLabel, input.label, input.title]) {
    const text = (candidate ?? '').replace(/\s+/gu, ' ').trim().slice(0, 160);
    if (text) return text;
  }
  if (input.directory) return 'Папка с файлами';

  // Match the discovery protocol's bound without interpreting a cut-off prefix.
  const accept = input.accept.length <= 512 ? input.accept.trim().toLowerCase() : '';
  let excel = !!accept;
  let json = !!accept;
  // No guesses from technical IDs, file names, or arbitrary handler code.
  for (const type of accept.split(',')) {
    const token = type.trim();
    if (!['.xlsx', '.xls', '.xlsm', 'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel.sheet.macroenabled.12'].includes(token)) excel = false;
    if (!['.json', '.json.gz', 'application/json'].includes(token)) json = false;
  }
  if (excel) return input.multiple ? 'Excel-файлы' : 'Excel-файл';
  if (json) return input.multiple ? 'JSON-снимки' : 'JSON-снимок';
  return `${input.multiple ? 'Файлы данных' : 'Файл данных'} ${input.index + 1}`;
}
