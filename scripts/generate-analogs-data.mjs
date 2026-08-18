import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import XLSX from 'xlsx';

XLSX.set_fs(fs);

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, 'src/shared/data/analogs.generated.json');

const SOURCE_FILES = {
  ankangTecumseh: 'Анканг_20Текумсе_2018.08.2026_20исправлено.xlsx',
  axial: 'Осевые Аналоги 16.07.26.xlsx',
  fans: 'Таблица аналогов вентиляторов (4).xlsx',
  piston: 'Аналоги сводная таблица с ссылками (1).xlsx',
  sanhua: 'CROSS SANHUA 20_02_2026 (1).xls',
  scroll: 'Cross-References_Scroll_v3.xlsx',
};

function argumentValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const sourceDirectoryArgument = argumentValue('--source-dir', process.env.ANALOGS_SOURCE_DIR ?? '');
if (!sourceDirectoryArgument) {
  throw new Error('Укажите папку с Excel-файлами: --source-dir <путь> или ANALOGS_SOURCE_DIR=<путь>');
}

const sourceDir = path.resolve(sourceDirectoryArgument);
const outputFile = path.resolve(argumentValue('--output', DEFAULT_OUTPUT));

function readWorkbook(fileName) {
  const filePath = path.join(sourceDir, fileName);
  if (!fs.existsSync(filePath)) throw new Error(`Не найден файл: ${filePath}`);
  return XLSX.readFile(filePath, {
    cellFormula: true,
    cellNF: true,
    cellStyles: true,
    cellText: true,
  });
}

function cellAt(sheet, row, column) {
  return sheet[XLSX.utils.encode_cell({ r: row - 1, c: column - 1 })];
}

function cellText(sheet, row, column) {
  const cell = cellAt(sheet, row, column);
  if (!cell || cell.v === null || cell.v === undefined) return '';
  return String(cell.w ?? cell.v).replace(/\s+/g, ' ').trim();
}

function cellRaw(sheet, row, column) {
  return cellAt(sheet, row, column)?.v ?? null;
}

function isSourceFlagged(sheet, row, column) {
  const cell = cellAt(sheet, row, column);
  const fill = String(cell?.s?.fgColor?.rgb ?? '').toUpperCase();
  const font = String(cell?.s?.color?.rgb ?? cell?.s?.font?.color?.rgb ?? '').toUpperCase();
  return fill === 'FFFFFF00' || fill === 'FFFFFFCC' || fill === 'FFFF00' || fill === 'FFFFCC' || font === 'FFFF0000';
}

function normalizeBrand(value) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  const key = normalized.toLocaleLowerCase('ru-RU').replace(/[^a-zа-яё0-9]+/g, '');
  const names = {
    ankang: 'Ankang',
    maer: 'MaEr',
    dunli: 'Dunli',
    weiguang: 'Weiguang',
    fanstech: 'Fans-Tech',
    tecumseh: 'Tecumseh',
    ebm: 'EBM',
  };
  return names[key] ?? normalized;
}

function cleanModel(value, brand = '') {
  let result = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!result || /^нет (?:данных|аналога)$/i.test(result) || /^[\s/.,—-]+$/.test(result)) return '';
  const prefixes = [brand, 'MaEr', 'Dunli', 'Weiguang', 'EBM', 'Fans-Tech'].filter(Boolean);
  for (const prefix of prefixes) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`^${escaped}\\s+`, 'i'), '');
  }
  result = result.replace(/\s+Вентилятор\s+осевой.*$/i, '').trim();
  result = result.replace(/\s+\(-?\d+(?:[.,]\d+)?%\)\s*$/i, '').trim();
  return result;
}

function makeDirectItem({ brand, value, aliases = [], row, flagged = false, metadata = {} }) {
  const normalizedBrand = normalizeBrand(brand);
  const model = cleanModel(value, normalizedBrand);
  if (!model) return null;
  const cleanedAliases = aliases.map((alias) => cleanModel(alias, normalizedBrand)).filter(Boolean);
  return {
    brand: normalizedBrand,
    model,
    displayName: [normalizedBrand, model].filter(Boolean).join(' '),
    aliases: Array.from(new Set([model, ...cleanedAliases])),
    sourceRow: row,
    sourceFlagged: flagged,
    metadata,
  };
}

function uniqueItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item) return false;
    const key = `${item.brand}:${item.model}`.toLocaleLowerCase('ru-RU');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseAxialGroups() {
  const workbook = readWorkbook(SOURCE_FILES.axial);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const groups = [];
  let block = [];

  const flush = () => {
    if (block.length === 0) return;
    const inferredOrder = ['MaEr', 'Dunli', 'Weiguang', 'Fans-Tech'];
    const items = uniqueItems(
      block.map((entry, index) => {
        if (!entry.value || entry.value.includes('====')) return null;
        const brand = entry.brand || inferredOrder[index] || 'Другое';
        return makeDirectItem({ brand, value: entry.value, row: entry.row, flagged: entry.flagged });
      }),
    );
    const knownBrands = new Set(items.map((item) => item.brand).filter((brand) => ['MaEr', 'Dunli', 'Weiguang', 'Fans-Tech'].includes(brand)));
    if (block.length <= 8 && items.length >= 2 && knownBrands.size >= 2) {
      groups.push({
        id: `axial-${groups.length + 1}`,
        kind: 'axial_fans',
        sourceId: 'axial',
        category: 'Осевые вентиляторы',
        items,
      });
    }
    block = [];
  };

  for (let row = 1; row <= range.e.r + 1; row += 1) {
    const brand = cellText(sheet, row, 1);
    const value = cellText(sheet, row, 2);
    if (brand === 'ТМ' && value === 'Наименование') continue;
    if (normalizeBrand(brand) === 'MaEr' && block.length > 0) flush();
    if (!brand && !value) {
      flush();
      continue;
    }
    block.push({ brand, value, row, flagged: isSourceFlagged(sheet, row, 2) });
  }
  flush();
  return groups;
}

function parseAnkangTecumsehGroups() {
  const workbook = readWorkbook(SOURCE_FILES.ankangTecumseh);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const maxRow = XLSX.utils.decode_range(sheet['!ref']).e.r + 1;
  const groups = [];

  for (let row = 2; row <= maxRow; row += 1) {
    const ankangModel = cellText(sheet, row, 1);
    const tecumsehModel = cellText(sheet, row, 3);
    const ankangCapacityW = parseNumber(cellRaw(sheet, row, 2) ?? cellText(sheet, row, 2));
    const tecumsehCapacityW = parseNumber(cellRaw(sheet, row, 4) ?? cellText(sheet, row, 4));
    const items = uniqueItems([
      makeDirectItem({
        brand: 'Ankang',
        value: ankangModel,
        row,
        flagged: isSourceFlagged(sheet, row, 1),
        metadata: { coolingCapacityW: ankangCapacityW },
      }),
      makeDirectItem({
        brand: 'Tecumseh',
        value: tecumsehModel,
        row,
        flagged: isSourceFlagged(sheet, row, 3),
        metadata: { coolingCapacityW: tecumsehCapacityW },
      }),
    ]);
    if (items.length < 2) continue;

    groups.push({
      id: `ankang-tecumseh-${row}`,
      kind: 'ankang_tecumseh',
      sourceId: 'ankang_tecumseh',
      category: 'Поршневые компрессоры',
      items,
    });
  }

  return groups;
}

function parseFanCrossGroups() {
  const workbook = readWorkbook(SOURCE_FILES.fans);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const brands = ['EBM', 'Dunli', 'MaEr', 'Fans-Tech', 'Weiguang', 'Дополнительный аналог'];
  const note = [35, 36, 37].map((row) => cellText(sheet, row, 1)).filter(Boolean).join(' ');
  const groups = [];

  const rowItems = (row) =>
    uniqueItems(
      brands.map((brand, index) =>
        makeDirectItem({
          brand,
          value: cellText(sheet, row, index + 1),
          row,
          flagged: isSourceFlagged(sheet, row, index + 1),
        }),
      ),
    );

  let current = null;
  for (let row = 4; row <= 32; row += 1) {
    const items = rowItems(row);
    if (items.length === 0) continue;
    if (cellText(sheet, row, 1)) {
      if (current?.items.length >= 2) groups.push(current);
      current = {
        id: `fan-cross-${groups.length + 1}`,
        kind: 'fan_cross',
        sourceId: 'fans',
        category: 'Вентиляторы',
        note,
        items,
      };
    } else if (current) {
      current.items = uniqueItems([...current.items, ...items]);
    }
  }
  if (current?.items.length >= 2) groups.push(current);

  for (let row = 38; row <= 45; row += 1) {
    const items = rowItems(row);
    if (items.length < 2) continue;
    groups.push({
      id: `fan-cross-${groups.length + 1}`,
      kind: 'fan_cross',
      sourceId: 'fans',
      category: 'Вентиляторы',
      note,
      items,
    });
  }
  return groups;
}

function parseSanhuaGroups() {
  const workbook = readWorkbook(SOURCE_FILES.sanhua);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const categoryRows = new Map();
  for (const merge of sheet['!merges'] ?? []) {
    if (merge.s.c === 1 && merge.e.c >= 14 && merge.s.r === merge.e.r) {
      const row = merge.s.r + 1;
      const category = cellText(sheet, row, 2);
      if (category) categoryRows.set(row, category);
    }
  }

  const groups = [];
  let category = 'Оборудование Sanhua';
  const maxRow = Math.min(400, XLSX.utils.decode_range(sheet['!ref']).e.r + 1);

  for (let row = 1; row <= maxRow; row += 1) {
    if (row <= 2) continue;
    if (categoryRows.has(row)) {
      category = categoryRows.get(row);
      continue;
    }

    const danfossName = cellText(sheet, row, 2);
    const danfossCode = cellText(sheet, row, 3);
    const sizes = [cellText(sheet, row, 6), cellText(sheet, row, 7)].filter(Boolean);
    const entries = [
      { brand: 'Danfoss', value: danfossName, aliases: danfossCode ? [danfossCode] : [], column: 2 },
      { brand: 'Sanhua (новая)', value: cellText(sheet, row, 4), aliases: [], column: 4 },
      { brand: 'Sanhua (старая)', value: cellText(sheet, row, 5), aliases: [], column: 5 },
      { brand: 'Ридан', value: cellText(sheet, row, 9), aliases: [], column: 9 },
      { brand: 'Фригопоинт', value: cellText(sheet, row, 11), aliases: [], column: 11 },
      { brand: 'СПС Becool', value: cellText(sheet, row, 13), aliases: [], column: 13 },
      { brand: 'HONGSEN', value: cellText(sheet, row, 15), aliases: [], column: 15 },
    ];
    const headerValues = entries.map((entry) => entry.value).filter(Boolean);
    const normalizedHeaderValues = new Set(headerValues.map((value) => value.toLocaleLowerCase('ru-RU').replace(/[^a-zа-яё0-9]+/g, '')));
    if (headerValues.length >= 2 && normalizedHeaderValues.size === 1 && !/\d/.test(headerValues[0])) {
      category = headerValues[0];
      continue;
    }
    const items = uniqueItems(
      entries.map((entry) =>
        makeDirectItem({
          ...entry,
          row,
          flagged: isSourceFlagged(sheet, row, entry.column),
          metadata: sizes.length ? { sizes } : {},
        }),
      ),
    ).filter((item) => !/^модель(?:\s|$)/i.test(item.model) && !/^(аналог|ридан|фригопоинт|спс becool|hongsen)$/i.test(item.model));
    if (items.length < 2) continue;
    groups.push({
      id: `sanhua-${groups.length + 1}`,
      kind: 'sanhua',
      sourceId: 'sanhua',
      category,
      items,
    });
  }
  return groups;
}

function parseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const match = String(value ?? '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function refrigerantFromPistonSheet(sheetName) {
  if (/404/.test(sheetName)) return 'R404A';
  if (/290/.test(sheetName)) return 'R290';
  if (/134/.test(sheetName)) return 'R134a';
  if (/22/.test(sheetName)) return 'R22';
  return '';
}

function parsePistonSeries() {
  const workbook = readWorkbook(SOURCE_FILES.piston);
  const series = [];
  for (const sheetName of workbook.SheetNames) {
    if (/оглавление|лист2/i.test(sheetName)) continue;
    const sheet = workbook.Sheets[sheetName];
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const refrigerant = refrigerantFromPistonSheet(sheetName);
    const application = /LBP/i.test(sheetName) ? 'Низкотемпературный режим' : 'Среднетемпературный режим';
    const products = [];

    for (const startColumn of [1, 7, 13, 19, 25]) {
      const brand = cellText(sheet, 1, startColumn);
      if (!brand) continue;
      for (let row = 2; row <= range.e.r + 1; row += 1) {
        const model = cleanModel(cellText(sheet, row, startColumn));
        if (!model || /^(220|380)\s*В/i.test(model)) continue;
        const rawCapacity = cellRaw(sheet, row, startColumn + 2);
        const coolingCapacityKw = parseNumber(rawCapacity);
        if (coolingCapacityKw === null || coolingCapacityKw <= 0) continue;
        products.push({
          brand,
          model,
          aliases: [model],
          coolingCapacityKw: coolingCapacityKw / 1000,
          rawCoolingCapacity: cellText(sheet, row, startColumn + 2),
          sourceRow: row,
          sourceFlagged: false,
        });
      }
    }

    series.push({
      id: `piston-${series.length + 1}`,
      kind: 'piston_compressors',
      sourceId: 'piston',
      sourceSheet: sheetName,
      category: 'Поршневые компрессоры',
      refrigerant,
      application,
      tolerancePercent: 10,
      products,
    });
  }
  return series;
}

function normalizeRefrigerant(value, fallback = '') {
  const compact = String(value || fallback).replace(/\s+/g, '').toUpperCase();
  if (compact.includes('410')) return 'R410A';
  if (compact.includes('407')) return 'R407C';
  if (compact.includes('404')) return 'R404A';
  return fallback;
}

function parseScrollSeries() {
  const workbook = readWorkbook(SOURCE_FILES.scroll);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const sections = [
    { titleRow: 2, headerRow: 5, endRow: 47, refrigerant: 'R410A' },
    { titleRow: 48, headerRow: 51, endRow: 76, refrigerant: 'R407C' },
    { titleRow: 77, headerRow: 79, endRow: 119, refrigerant: 'R404A' },
    { titleRow: 120, headerRow: 122, endRow: 141, refrigerant: 'R404A' },
    { titleRow: 139, headerRow: 142, endRow: 157, refrigerant: 'R404A' },
  ];
  const blocks = [1, 8, 15, 22, 29].map((zeroBased) => zeroBased + 1);

  return sections.map((section, index) => {
    const application = cellText(sheet, section.titleRow, 2) || (index === 4 ? 'Низкотемпературный режим с впрыском пара (EVI)' : 'Спиральные компрессоры');
    const products = [];

    for (const startColumn of blocks) {
      const brand = cellText(sheet, section.headerRow, startColumn);
      if (!brand || /Фреон/i.test(brand)) continue;
      let carriedRefrigerant = section.refrigerant;
      for (let row = section.headerRow + 1; row <= section.endRow; row += 1) {
        const rawModel = cellText(sheet, row, startColumn);
        const rawRefrigerant = cellText(sheet, row, startColumn + 1);
        if (rawRefrigerant) carriedRefrigerant = normalizeRefrigerant(rawRefrigerant, carriedRefrigerant);
        const model = cleanModel(rawModel);
        const rawCapacity = cellRaw(sheet, row, startColumn + 2);
        const coolingCapacityKw = parseNumber(rawCapacity);
        if (!model || coolingCapacityKw === null || coolingCapacityKw <= 0) continue;
        const knownFlaggedModel = /^(YIH38C1G-100|YIH42C1G-100|YIH50C1G-100|YIH60C1G-100|YIH72C1G-100|YIH130C1G-100|WR235KP-TWD-GN1|WF25KE-TFD-GL1)$/i.test(model);
        products.push({
          brand,
          model,
          aliases: [model],
          coolingCapacityKw,
          rawCoolingCapacity: cellText(sheet, row, startColumn + 2),
          sourceRow: row,
          sourceFlagged: knownFlaggedModel || isSourceFlagged(sheet, row, startColumn),
          refrigerant: carriedRefrigerant,
        });
      }
    }

    return {
      id: `scroll-${index + 1}`,
      kind: 'scroll_compressors',
      sourceId: 'scroll',
      sourceSheet: application,
      category: 'Спиральные компрессоры',
      refrigerant: section.refrigerant,
      application,
      tolerancePercent: 5,
      products,
    };
  });
}

const directGroups = [
  ...parseAnkangTecumsehGroups(),
  ...parseAxialGroups(),
  ...parseFanCrossGroups(),
  ...parseSanhuaGroups(),
];
const compressorSeries = [...parsePistonSeries(), ...parseScrollSeries()];
const sources = [
  {
    id: 'ankang_tecumseh',
    fileName: SOURCE_FILES.ankangTecumseh,
    label: 'Анканг / Tecumseh',
    kind: 'direct',
  },
  { id: 'axial', fileName: SOURCE_FILES.axial, label: 'Осевые аналоги', kind: 'direct' },
  {
    id: 'fans',
    fileName: SOURCE_FILES.fans,
    label: 'Таблица аналогов вентиляторов',
    kind: 'direct',
    note: directGroups.find((group) => group.sourceId === 'fans')?.note ?? '',
  },
  {
    id: 'piston',
    fileName: SOURCE_FILES.piston,
    label: 'Сводная таблица поршневых компрессоров',
    kind: 'capacity',
    tolerancePercent: 10,
    note:
      'Подбор выполнен по исходной таблице с допуском ±10%. Перед применением подтвердите рабочую точку, электропитание и datasheet производителя.',
  },
  { id: 'sanhua', fileName: SOURCE_FILES.sanhua, label: 'Cross Sanhua', kind: 'direct' },
  {
    id: 'scroll',
    fileName: SOURCE_FILES.scroll,
    label: 'Cross References Scroll',
    kind: 'capacity',
    tolerancePercent: 5,
    note:
      'Подбор выполнен по исходной таблице с допуском ±5%. Перед применением подтвердите хладагент, рабочую точку, электропитание и datasheet производителя.',
  },
];

const data = {
  version: 1,
  generatedAt: new Date().toISOString(),
  sources,
  directGroups,
  compressorSeries,
  stats: {
    directGroups: directGroups.length,
    directItems: directGroups.reduce((sum, group) => sum + group.items.length, 0),
    compressorSeries: compressorSeries.length,
    compressorItems: compressorSeries.reduce((sum, item) => sum + item.products.length, 0),
    sourceFlaggedItems:
      directGroups.flatMap((group) => group.items).filter((item) => item.sourceFlagged).length +
      compressorSeries.flatMap((item) => item.products).filter((product) => product.sourceFlagged).length,
  },
};

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, `${JSON.stringify(data)}\n`, 'utf8');
console.log(JSON.stringify({ outputFile, ...data.stats }, null, 2));
