import type { WholesaleDiscountReportRow } from '@/shared/lib/db';

type DiscountReportGroup = {
  priceGroup: string;
  rows: WholesaleDiscountReportRow[];
};

export type WholesaleDiscountReportFile = {
  content: Buffer;
  contentType: string;
  filename: string;
};

function escapeXml(value: string | number | null | undefined) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cell(value: string | number, style = 'Cell') {
  return `<Cell ss:StyleID="${style}"><Data ss:Type="String">${escapeXml(value)}</Data></Cell>`;
}

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

function buildDiscountReportXls(rows: WholesaleDiscountReportRow[]) {
  const groupedRows = groupRows(rows);
  const bodyRows: string[] = [];

  bodyRows.push(`<Row ss:Height="38"><Cell ss:MergeAcross="3" ss:StyleID="Title"><Data ss:Type="String">Отчёт по скидкам</Data></Cell></Row>`);
  bodyRows.push('<Row/>');
  bodyRows.push(
    `<Row ss:Height="28">${cell('Ценовая группа', 'Header')}${cell('Скидка', 'Header')}${cell('Компания', 'Header')}${cell('Менеджер', 'Header')}</Row>`,
  );

  for (const group of groupedRows) {
    bodyRows.push(
      `<Row ss:Height="24">${cell(group.priceGroup, 'Group')}${cell('', 'Group')}${cell('', 'Group')}${cell('', 'Group')}</Row>`,
    );

    for (const row of group.rows) {
      bodyRows.push(
        `<Row ss:OutlineLevel="1" ss:Hidden="1" ss:Height="22">${cell(row.priceGroup)}${cell(row.discount)}${cell(row.company)}${cell(row.manager)}</Row>`,
      );
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal">
   <Alignment ss:Vertical="Center"/>
   <Font ss:FontName="Arial" ss:Size="10"/>
  </Style>
  <Style ss:ID="Title">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Arial" ss:Size="18" ss:Bold="1"/>
  </Style>
  <Style ss:ID="Header">
   <Alignment ss:Vertical="Center" ss:WrapText="1"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#C8B86C"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#C8B86C"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#C8B86C"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#C8B86C"/>
   </Borders>
   <Interior ss:Color="#FFF2CC" ss:Pattern="Solid"/>
   <Font ss:FontName="Arial" ss:Size="10" ss:Bold="1"/>
  </Style>
  <Style ss:ID="Group">
   <Alignment ss:Vertical="Center"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D6C982"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D6C982"/>
   </Borders>
   <Interior ss:Color="#FFFBEA" ss:Pattern="Solid"/>
   <Font ss:FontName="Arial" ss:Size="10" ss:Bold="1"/>
  </Style>
  <Style ss:ID="Cell">
   <Alignment ss:Vertical="Center" ss:WrapText="1"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D6C982"/>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D6C982"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D6C982"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#D6C982"/>
   </Borders>
  </Style>
 </Styles>
 <Worksheet ss:Name="Отчёт по скидкам">
  <Table ss:ExpandedColumnCount="4" ss:ExpandedRowCount="${bodyRows.length}" x:FullColumns="1" x:FullRows="1">
   <Column ss:Width="210"/>
   <Column ss:Width="90"/>
   <Column ss:Width="170"/>
   <Column ss:Width="190"/>
   ${bodyRows.join('\n   ')}
  </Table>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
   <SummaryBelow>False</SummaryBelow>
   <ProtectObjects>False</ProtectObjects>
   <ProtectScenarios>False</ProtectScenarios>
  </WorksheetOptions>
 </Worksheet>
</Workbook>`;
}

export function renderWholesaleDiscountReport(rows: WholesaleDiscountReportRow[]): WholesaleDiscountReportFile {
  const content = Buffer.from(buildDiscountReportXls(rows), 'utf8');
  return {
    content,
    contentType: 'application/vnd.ms-excel; charset=utf-8',
    filename: `${safeFilename('отчёт-по-скидкам')}.xls`,
  };
}
