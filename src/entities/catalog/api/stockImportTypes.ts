export type RawRow = Record<string, unknown>;
export type StockLocationKey = 'volzhsk' | 'moscow';
export type ParsedStockRow = {
  rowNumber: number;
  row: RawRow;
  location: StockLocationKey | null;
};

export type StockImportError = {
  row: number;
  name: string;
  error: string;
};

export type StockImportResult = {
  logId: number | null;
  fileName: string;
  emailFrom: string;
  emailSubject: string;
  status: 'success' | 'partial_success' | 'failed';
  totalRows: number;
  updatedRows: number;
  notFoundRows: number;
  failedRows: number;
  errors: StockImportError[];
};

export type StockImportLog = Omit<StockImportResult, 'errors'> & {
  createdAt: string;
  errors: StockImportError[];
};

export type StockEmailSkipReason = 'sender' | 'subject' | 'attachment';

export type StockEmailSkipSample = {
  reason: StockEmailSkipReason;
  from: string;
  subject: string;
  attachments: string[];
};

export type StockEmailImportResult = {
  processed: number;
  result: StockImportResult | null;
  checkedMessages: number;
  skipped: {
    sender: number;
    subject: number;
    attachment: number;
    samples: StockEmailSkipSample[];
  };
  settings: {
    allowedFrom: string;
    subjectPart: string;
    filePrefix: string;
    scanLimit: number;
  };
};
