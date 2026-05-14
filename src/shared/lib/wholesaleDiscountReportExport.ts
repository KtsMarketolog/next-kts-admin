import * as XLSX from 'xlsx';

import type { WholesaleDiscountReportRow } from '@/shared/lib/db';

type DiscountReportGroup = {
  priceGroup: string;
  rows: WholesaleDiscountReportRow[];
};

type OutlineWorksheet = XLSX.WorkSheet & {
  '!outline'?: {
    above?: boolean;
    left?: boolean;
  };
};

export type WholesaleDiscountReportFile = {
  content: Buffer;
  contentType: string;
  filename: string;
};

function groupRows(rows: WholesaleDiscountReportRow[]) {
  const groups = new Map<string, DiscountReportGroup>();
  for (const row of rows) {
    const group = groups.get(row.priceGroup);
    if (group) {
      group.rows.push(row);
    } else {
      groups.set(row.priceGroup, { priceGroup: row.priceGroup, rows: [row] });
    }
  }
  return Array.from(groups.values()).sort((a, b) => a.priceGroup.localeCompare(b.priceGroup, 'ru'));
}

function safeFilename(value: string) {
  return value.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').slice(0, 120);
}

function buildDiscountReportWorkbook(rows: WholesaleDiscountReportRow[]) {
  const data: string[][] = [
    ['Отчёт по скидкам', '', '', ''],
    ['', '', '', ''],
    ['Ценовая группа', 'Скидка', 'Компания', 'Менеджер'],
  ];
  const rowInfo: XLSX.RowInfo[] = [{ hpt: 32 }, { hpt: 8 }, { hpt: 24 }];

  for (const group of groupRows(rows)) {
    data.push([group.priceGroup, '', '', '']);
    rowInfo.push({ hpt: 22 });

    for (const row of group.rows) {
      data.push([row.priceGroup, row.discount, row.company, row.manager]);
      rowInfo.push({ hidden: true, level: 1, hpt: 20 });
    }
  }

  const worksheet = XLSX.utils.aoa_to_sheet(data) as OutlineWorksheet;
  worksheet['!cols'] = [{ wch: 32 }, { wch: 14 }, { wch: 26 }, { wch: 28 }];
  worksheet['!rows'] = rowInfo;
  worksheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];
  worksheet['!outline'] = { above: true };

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Отчёт по скидкам');
  workbook.Workbook = {
    ...(workbook.Workbook ?? {}),
    Views: [{ RTL: false }],
  };
  return workbook;
}

export function renderWholesaleDiscountReport(rows: WholesaleDiscountReportRow[]): WholesaleDiscountReportFile {
  const content = XLSX.write(buildDiscountReportWorkbook(rows), {
    type: 'buffer',
    bookType: 'xlsx',
    compression: true,
  });

  return {
    content,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename: `${safeFilename('отчёт-по-скидкам')}.xlsx`,
  };
}
