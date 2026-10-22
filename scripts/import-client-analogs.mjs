import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

XLSX.set_fs(fs);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BATCH = 'client-2026-10';
const FILES = {
  ankang: 'Анканг_20Текумсе_2018.08.2026_20заполнено.xlsx',
  axial: 'ОСЕВЫЕ ВЕНТИЛЯТОРЫ 24.08.2026 (1).xlsx',
  sanhua: 'CROSS SANHUA 19_08_2026 (1).xls',
  scroll: 'Cross reference _v6_1.xlsx',
};
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const text = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const key = (value) => text(value).normalize('NFKC').toLowerCase().replace(/[\s.,()\-_/]+/g, '');
const brandKey = (value) => key(value).replace(/^sanhua.*/, 'sanhua').replace(/^сopeland$/, 'copeland').replace(/^ридан$/, 'ridan');
const itemKey = (item) => `${brandKey(item.brand)}:${key(item.model)}`;
const cleanModel = (value) => text(value).replace(/^\((.*)\)$/, '$1').replace(/\s+(?:Вентилятор осевой|Осевой вентилятор).*$/i, '').trim();
const containsDeclaredModel = (printName, model) => {
  const escaped = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(printName);
};
const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value : /^\d+(?:[.,]\d+)?$/.test(text(value)) ? Number(text(value).replace(',', '.')) : null;
const validModel = (value) => !!value && /[a-zа-я]/i.test(value) && /\d/.test(value) && !/нет (?:данных|аналога)|не выбирать|внимание|То=/i.test(value);
export function operatingPointKey(value) {
  const normalized = text(value).toLowerCase().replace(/[то ксн]/g, (letter) => ({ т: 't', о: 'o', к: 'k', с: 'c', н: 'h', ' ': '' }[letter])).replace(/\s/g, '');
  const values = ['to', 'tk', 'sh', 'sc'].map((label) => {
    const found = [...normalized.matchAll(new RegExp(`(?:^|[,;])${label}=?([+-]?\\d+(?:[.,]\\d+)?)`, 'g'))].map((match) => match[1].replace(',', '.').replace(/^\+/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
    return found.length && new Set(found).size === 1 ? found[0] : null;
  });
  return values.every((part) => part !== null) ? values.join('|') : null;
}
const specification = (label, value, unit) => {
  const normalized = text(value);
  return normalized && /[\p{L}\d]/u.test(normalized) && !/^[△Y\s]+$/.test(normalized)
    ? { label, value: normalized, ...(unit ? { unit } : {}) } : null;
};
const specs = (...values) => values.filter(Boolean);
function cell(sheet, row, column, merged = false) {
  let address = XLSX.utils.encode_cell({ r: row - 1, c: column - 1 });
  if (merged && !sheet[address]?.v) {
    const merge = (sheet['!merges'] ?? []).find((item) => row - 1 >= item.s.r && row - 1 <= item.e.r && column - 1 >= item.s.c && column - 1 <= item.e.c);
    if (merge) address = XLSX.utils.encode_cell(merge.s);
  }
  return sheet[address]?.v ?? null;
}
function maxRow(sheet) {
  // Legacy XLS may declare a million-row formatted range. Never iterate that range.
  return Math.max(0, ...Object.entries(sheet).filter(([address, value]) => !address.startsWith('!') && value.v != null).map(([address]) => XLSX.utils.decode_cell(address).r + 1));
}
function flagged(sheet, row, column) {
  const style = sheet[XLSX.utils.encode_cell({ r: row - 1, c: column - 1 })]?.s;
  return [style?.fgColor?.rgb, style?.font?.color?.rgb, style?.color?.rgb].some((value) => ['FFFF00', 'FFFFCC', 'FF0000', 'FF4000'].includes(String(value ?? '').slice(-6).toUpperCase()));
}
function item(brand, model, row, metadata = {}, aliases = []) {
  model = cleanModel(model);
  if (!validModel(model)) return null;
  return { brand, model, displayName: `${brand} ${model}`, aliases: [...new Set([model, ...aliases.map(text).filter(Boolean)])], sourceRow: row, sourceFlagged: !!metadata.warnings?.length || !!metadata.sourceMarked, metadata };
}
function group(sourceId, row, items, category, sourceSheet, note = '', suffix = '') {
  const kind = sourceId.startsWith('sanhua') ? 'sanhua' : sourceId.startsWith('axial') ? 'axial_fans' : sourceId.startsWith('ankang') ? 'ankang_tecumseh' : sourceId;
  return { id: `${sourceId}-${sourceSheet}-${row}${suffix}`, kind, sourceId, sourceSheet, category, ...(note ? { note } : {}), items: items.filter(Boolean) };
}

export function buildClientAnalogs({ baseline, sourceDir, refcomp, generatedAt = new Date().toISOString() }) {
  const sources = [];
  const directGroups = [];
  const compressorSeries = [];
  const issues = [];
  const books = {};
  const source = (id, fileKey, label, kind, note) => {
    const fileName = FILES[fileKey];
    const filePath = path.join(sourceDir, fileName);
    const buffer = fs.readFileSync(filePath);
    books[fileKey] = XLSX.read(buffer, { type: 'buffer', cellStyles: true, cellText: true });
    sources.push({ id, fileName, label, kind, note, priority: 100, importedBatch: BATCH, sha256: crypto.createHash('sha256').update(buffer).digest('hex') });
  };
  const provenance = (sheet, range) => ({ sourceSheet: sheet, sourceRange: range });

  source('ankang_tecumseh_202608', 'ankang', 'Ankang / Tecumseh — август 2026', 'direct', 'Условия оценки Ankang и Tecumseh не полностью идентичны. Сравнивайте значения с учётом указанной рабочей точки и стандарта.');
  {
    const sourceId = 'ankang_tecumseh_202608';
    const sheetName = books.ankang.SheetNames[0];
    const sheet = books.ankang.Sheets[sheetName];
    for (let row = 2; row <= maxRow(sheet); row++) {
      const description = text(cell(sheet, row, 2));
      const model = description.split(/\s|\(/)[0];
      const alternative = text(cell(sheet, row, 3));
      if (!validModel(model) || !validModel(alternative)) continue;
      const conditions = text(cell(sheet, row, 5));
      const items = [
        ['Ankang', model, 1, 7], ['Tecumseh', alternative, 4, 6],
      ].map(([brand, name, capacityColumn, originColumn]) => {
        const capacity = number(cell(sheet, row, capacityColumn));
        const origin = text(cell(sheet, row, originColumn));
        const warnings = capacity == null ? ['Холодопроизводительность в новом источнике отсутствует; не восстанавливается из старой версии.'] : [];
        if (warnings.length) issues.push({ sourceId, sheet: sheetName, row, model: name, issue: warnings[0] });
        return item(brand, name, row, { ...provenance(sheetName, `A${row}:G${row}`), sourceMarked: flagged(sheet, row, brand === 'Ankang' ? 2 : 3), coolingCapacityW: capacity, technicalSpecifications: specs(specification('Холодопроизводительность', capacity, 'Вт'), specification('Условия / стандарт', conditions), specification('Источник характеристики', origin)), ...(brand === 'Ankang' ? { printName: description, catalogAliases: [description] } : {}), warnings });
      });
      directGroups.push(group(sourceId, row, items, 'Поршневые компрессоры', sheetName, sources.at(-1).note));
    }
  }

  source('axial_202608', 'axial', 'Осевые вентиляторы — август 2026', 'direct', 'Таблица сопоставления клиента. Характеристики относятся к конкретной модели; монтажные размеры и рабочую точку необходимо проверить до замены.');
  {
    const sourceId = 'axial_202608';
    const sheetName = books.axial.SheetNames[0];
    const sheet = books.axial.Sheets[sheetName];
    const known = new Set();
    const make = (brand, description, row, individual, common, name, range) => item(brand, description, row, {
      ...provenance(name, range), printName: text(description), catalogAliases: [text(description)],
      technicalSpecifications: specs(specification('Потребляемая мощность', individual[0], 'Вт'), specification('Скорость вращения', individual[1], 'об/мин'), specification('Расход воздуха при 0 Па', individual[2], 'м³/ч'), specification('Число полюсов', common[0]), specification('Электропитание', common[1]), specification('Диаметр', common[2], 'мм'), specification('Направление потока (обозначение источника)', common[3])),
    });
    for (let row = 3; row <= maxRow(sheet); row++) {
      if (!text(cell(sheet, row, 1))) continue;
      const items = [['MaEr', 2], ['Dunli', 6], ['Weiguang', 10]].map(([brand, col]) => make(brand, cell(sheet, row, col), row, [1, 2, 3].map((offset) => cell(sheet, row, col + offset)), [15, 16, 17, 18].map((c) => cell(sheet, row, c)), sheetName, `A${row}:R${row}`)).filter(Boolean);
      if (!items.length) continue;
      for (const entry of items) known.add(itemKey(entry));
      directGroups.push(group(sourceId, row, items, 'Осевые вентиляторы', sheetName));
    }
    const extraName = books.axial.SheetNames[1];
    const extra = books.axial.Sheets[extraName];
    const identify = (model) => /^Y[DS]WF|^YSF|^P[MS]D?WF/i.test(model) ? 'MaEr' : /^YWF\.[AB]/i.test(model) ? 'Dunli' : /^YWF\d[EDT]/i.test(model) ? 'Weiguang' : null;
    // The vertical sheet contains additional explicit comparison blocks through row 513.
    // Its trailing one-column inventory is not evidence of equivalence.
    let block = [];
    const flush = () => {
      const entries = block.filter((entry) => !known.has(itemKey(entry)));
      if (entries.length) {
        const start = block[0].sourceRow;
        const common = new Set(block.map((entry) => JSON.stringify(entry.metadata.technicalSpecifications.filter((s) => ['Число полюсов', 'Электропитание', 'Диаметр', 'Направление потока (обозначение источника)'].includes(s.label)))));
        if (common.size > 1) {
          issues.push({ sourceId, sheet: extraName, row: start, issue: 'Внутри блока различаются общие характеристики; строки доступны как справочные, без автоматической связи.' });
          for (const entry of entries) directGroups.push(group(sourceId, entry.sourceRow, [entry], 'Осевые вентиляторы', extraName, 'Неполная или противоречивая группа. Соответствие другим моделям требует подтверждения.', '-reference'));
        } else {
          directGroups.push(group(sourceId, start, block, 'Осевые вентиляторы', extraName));
        }
        for (const entry of entries) known.add(itemKey(entry));
      }
      block = [];
    };
    for (let row = 9; row <= maxRow(extra); row++) {
      const raw = text(cell(extra, row, 1));
      const brand = identify(raw);
      if (row > 513 || !raw || /^\d[ST]-\d{3}[SB]$/.test(raw) || /Усиленная версия/.test(raw)) flush();
      if (!brand || !validModel(raw)) continue;
      const entry = make(brand, raw, row, [2, 3, 4].map((c) => cell(extra, row, c)), [5, 6, 7, 8].map((c) => cell(extra, row, c)), extraName, `A${row}:H${row}`);
      if (row <= 513) block.push(entry);
      else if (!known.has(itemKey(entry))) {
        directGroups.push(group(sourceId, row, [entry], 'Осевые вентиляторы', extraName, 'В исходном перечне указана только модель: подтверждённых аналогов и характеристик нет.', '-reference'));
        known.add(itemKey(entry));
      }
    }
    flush();
    issues.push({ sourceId, sheet: extraName, range: 'A515:A832', issue: 'Одноколоночный номенклатурный перечень не используется как таблица взаимозаменяемости. Неизвестные бренды, крыльчатки и явные пометки «НЕ ВЫБИРАТЬ» не добавляются автоматически.' });
  }

  source('sanhua_202608', 'sanhua', 'Cross Sanhua — август 2026', 'direct', 'Соответствия из таблицы клиента, с сохранением новых и прежних обозначений. Неполные и противоречивые строки требуют проверки техническим специалистом.');
  {
    const sourceId = 'sanhua_202608';
    const sheetName = books.sanhua.SheetNames[0];
    const sheet = books.sanhua.Sheets[sheetName];
    const categories = new Map((sheet['!merges'] ?? []).filter((m) => m.s.c === 1 && m.e.c >= 7 && m.s.r === m.e.r).map((m) => [m.s.r + 1, text(cell(sheet, m.s.r + 1, 2))]));
    let category = 'Оборудование Sanhua';
    for (let row = 3; row <= maxRow(sheet); row++) {
      if (categories.has(row)) { category = categories.get(row); continue; }
      const common = specs(specification('Размер (дюймы)', text(cell(sheet, row, 12)).replace(/\\/g, '/'), 'дюйм'), specification('Размер (метрика)', text(cell(sheet, row, 13)).replace(/\s*мм$/i, ''), 'мм'), specification('Соединение / исполнение', cell(sheet, row, 14, true)));
      const items = [];
      for (const [brand, modelCol, codeCol, articleCol, printCol] of [['Sanhua (новая)', 4, 5, 6, 7], ['Sanhua (старая)', 8, 9, 10, 11]]) {
        const printName = text(cell(sheet, row, printCol));
        const declared = cleanModel(cell(sheet, row, modelCol));
        const printedModel = printName.match(/^([A-Z][A-Z0-9()./-]*(?:\s+[A-Z]-[A-Z0-9-]+)?)/i)?.[1] ?? '';
        const model = declared || printedModel;
        if (!validModel(model)) continue;
        const conflict = declared && printedModel && key(declared) !== key(printedModel) && !containsDeclaredModel(printName, declared);
        const warnings = conflict ? ['Модель и наименование для печати в одной строке различаются. Привязка по коду и печатному имени отключена до уточнения.'] : [];
        if (conflict) issues.push({ sourceId, sheet: sheetName, row, model, printName, issue: warnings[0] });
        const codes = [codeCol, articleCol].map((c) => text(cell(sheet, row, c))).filter(Boolean);
        items.push(item(brand, model, row, { ...provenance(sheetName, `B${row}:V${row}`), sourceMarked: flagged(sheet, row, modelCol), printName, catalogCodes: conflict ? [] : codes, catalogAliases: conflict ? [] : [...codes, printName].filter(Boolean), technicalSpecifications: common, warnings }, conflict ? [] : codes));
      }
      for (const [brand, col, codeCol] of [['Danfoss', 2, 3], ['Ридан', 15, null], ['Фригопоинт', 17, null], ['СПС Becool', 19, null], ['HONGSEN', 21, null]]) {
        let model = text(cell(sheet, row, col));
        const code = codeCol ? text(cell(sheet, row, codeCol)) : '';
        // A series/family name alone is not a uniquely identified competitor model.
        if (/^Серия|^Соленоиды CSV|^Катушки для|^Переходник|^Клап\. узел|^накидная гайка/i.test(model)) model = code ? `${model} ${code}` : '';
        items.push(item(brand, model, row, { ...provenance(sheetName, `B${row}:V${row}`), sourceMarked: flagged(sheet, row, col), technicalSpecifications: common }, code ? [code] : []));
      }
      const selected = items.filter(Boolean);
      if (selected.length) directGroups.push(group(sourceId, row, selected, category, sheetName));
    }
  }

  source('scroll_v6', 'scroll', 'Cross reference v6.1', 'capacity', 'Автор исправил R410A; разделы R407C и R404A помечены как непроверенные и несортированные. Разные рабочие точки и диапазоны регулирования не означают взаимозаменяемость.');
  {
    const sourceId = 'scroll_v6';
    const sheetName = books.scroll.SheetNames[0];
    const sheet = books.scroll.Sheets[sheetName];
    const sections = [
      [2, 4, 39, 'R410A', false], [41, 43, 64, 'R410A', true],
      [67, 70, 109, 'R407C', false], [111, 113, 123, 'R407C', true],
      [125, 127, 165, 'R404A', false], [166, 168, 188, 'R404A', true],
      [189, 191, 218, 'R404A', false], [219, 222, 243, 'R404A', false],
      [245, 247, 262, 'R290', false],
    ];
    for (const [titleRow, headerRow, endRow, refrigerant, variable] of sections) {
      const application = text(cell(sheet, titleRow, 2) || cell(sheet, titleRow, 1));
      const products = [];
      for (const col of [2, 6, 10, 14, 18, 22, 26, 30, 34]) {
        let brand = text(cell(sheet, headerRow, col));
        if (!brand) continue;
        brand = brand.replace(/\s+впрыск.*$/i, '').replace(/^Сopeland/, 'Copeland').replace(/^Danfoss.*/, 'Danfoss').replace(/^Sonyo.*/, 'Sonyo Panasonic').replace(/^Ridan$/i, 'Ридан');
        let conditions = text(cell(sheet, headerRow - 1, col));
        for (let row = headerRow + 1; row <= endRow; row++) {
          const raw = text(cell(sheet, row, col));
          if (/^То=/i.test(raw)) { conditions = raw; continue; }
          if (!validModel(raw)) continue;
          const model = raw.replace(/\s+нет в программе.*$/i, '').trim();
          const capacityRaw = cell(sheet, row, col + 1);
          const capacity = number(capacityRaw);
          const operatingPoint = operatingPointKey(conditions);
          const displacement = cell(sheet, row, col + 2);
          const warnings = [
            ...(['R407C', 'R404A'].includes(refrigerant) ? ['Автор файла пометил этот раздел как непроверенный.'] : []),
            ...(/нет в программе/i.test(raw) ? ['В источнике: нет в программе производителя.'] : []),
          ];
          const technicalSpecifications = specs(specification('Хладагент', refrigerant), specification('Применение', application), specification('Холодопроизводительность', capacityRaw, 'кВт'), specification('Объёмная производительность', displacement, 'м³/ч'), specification('Условия расчёта', conditions));
          const metadata = { ...provenance(sheetName, `${XLSX.utils.encode_col(col - 1)}${row}:${XLSX.utils.encode_col(col + 1)}${row}`), technicalSpecifications, warnings, operatingPoint, sourceMarked: flagged(sheet, row, col) };
          if (variable || capacity == null || capacity <= 0 || !operatingPoint) {
            const note = 'Справочная модель: диапазон регулирования, неполная рабочая точка или отсутствующая производительность. Автоматические аналоги по одному числу не рассчитываются; требуется технический подбор.';
            directGroups.push(group(sourceId, row, [item(brand, model, row, { ...metadata, warnings: [...warnings, note] })], 'Спиральные компрессоры', sheetName, note, `-${col}-reference`));
          } else {
            products.push({ brand, model, aliases: [model], coolingCapacityKw: capacity, rawCoolingCapacity: text(capacityRaw), sourceRow: row, sourceFlagged: warnings.length > 0 || metadata.sourceMarked, refrigerant, technicalSpecifications, metadata });
          }
        }
      }
      const operatingPoints = [...new Set(products.map((product) => product.metadata.operatingPoint))];
      for (const operatingPoint of operatingPoints) compressorSeries.push({ id: `${sourceId}-${titleRow}-${operatingPoint}`, kind: 'scroll_compressors', sourceId, sourceSheet: sheetName, category: 'Спиральные компрессоры', refrigerant, application, operatingPoint, tolerancePercent: 5, products: products.filter((product) => product.metadata.operatingPoint === operatingPoint) });
    }
    issues.push({ sourceId, sheet: sheetName, range: 'B1:AJ262', issue: 'Диапазоны регулируемой производительности оставлены справочными. Встроенные изображения других листов — схемы обозначения моделей, не таблицы аналогов; характеристики из кодов автоматически не выводятся.' });
  }

  if (refcomp) {
    const sourceId = 'refcomp_202608';
    sources.push({ id: sourceId, fileName: refcomp.fileName, label: refcomp.label, note: refcomp.note, kind: 'direct', priority: 100, importedBatch: BATCH });
    for (const table of refcomp.tables) table.rows.forEach((values, index) => {
      const items = ['Refcomp', 'Bitzer', 'BOCK'].map((brand, position) => item(brand, values[position * 2], index + 1, { ...provenance(table.name, `Строка ${index + 1}`), technicalSpecifications: specs(specification('Объёмная производительность', values[position * 2 + 1], 'м³/ч')) }));
      directGroups.push(group(sourceId, index + 1, items, 'Полугерметичные поршневые компрессоры', table.name, refcomp.note));
    });
  }

  const priorSources = baseline.sources.filter((entry) => entry.importedBatch !== BATCH);
  const oldIds = new Set(priorSources.map((entry) => entry.id));
  const coverage = new Set();
  for (const entry of directGroups.filter((entry) => entry.sourceId !== 'scroll_v6')) {
    for (const anchor of entry.items) for (const alternative of entry.items) {
      if (itemKey(anchor) !== itemKey(alternative)) coverage.add(`${itemKey(anchor)}>${brandKey(alternative.brand)}`);
    }
  }
  const axialContext = new Map();
  for (const entry of directGroups.filter((entry) => entry.sourceId === 'axial_202608')) for (const product of entry.items) {
    const id = itemKey(product);
    const values = axialContext.get(id) ?? new Map();
    for (const detail of product.metadata.technicalSpecifications ?? []) {
      if (!['Электропитание', 'Диаметр', 'Направление потока (обозначение источника)'].includes(detail.label)) continue;
      const valueSet = values.get(detail.label) ?? new Set();
      valueSet.add(key(detail.value));
      values.set(detail.label, valueSet);
    }
    axialContext.set(id, values);
  }
  const conflictingKeys = new Set([...axialContext].filter(([, values]) => [...values.values()].some((set) => set.size > 1)).map(([id]) => id));
  const safeDirectGroups = directGroups.flatMap((entry) => {
    if (entry.sourceId !== 'axial_202608' || !entry.items.some((product) => conflictingKeys.has(itemKey(product)))) return [entry];
    const note = 'В новом источнике одна модель указана с различными напряжениями, диаметрами или направлениями потока. Автоматические аналоги отключены до уточнения техническим специалистом.';
    issues.push({ sourceId: entry.sourceId, sheet: entry.sourceSheet, row: entry.items[0].sourceRow, models: entry.items.filter((product) => conflictingKeys.has(itemKey(product))).map((product) => product.model), issue: note });
    return entry.items.map((product, index) => ({ ...entry, id: `${entry.id}-conflict-${index}`, note, items: [{ ...product, sourceFlagged: true, metadata: { ...product.metadata, warnings: [...(product.metadata.warnings ?? []), note] } }] }));
  });
  const oldDirect = baseline.directGroups.filter((entry) => oldIds.has(entry.sourceId));
  let supersededPairs = 0;
  let supersededDirectGroups = 0;
  const retainedDirect = oldDirect.flatMap((entry) => {
    const pairs = [];
    let removed = false;
    for (let first = 0; first < entry.items.length; first++) for (let second = first + 1; second < entry.items.length; second++) {
      const a = entry.items[first]; const b = entry.items[second];
      if (coverage.has(`${itemKey(a)}>${brandKey(b.brand)}`) || coverage.has(`${itemKey(b)}>${brandKey(a.brand)}`) || conflictingKeys.has(itemKey(a)) || conflictingKeys.has(itemKey(b))) {
        removed = true; supersededPairs++;
      } else pairs.push({ ...entry, id: `${entry.id}-retained-${first}-${second}`, items: [a, b] });
    }
    if (!removed) return [entry];
    supersededDirectGroups++;
    return pairs;
  });
  const newScrollKeys = new Set([
    ...compressorSeries.flatMap((series) => series.products.map((product) => `${itemKey(product)}:${series.refrigerant}`)),
    ...directGroups.filter((entry) => entry.sourceId === 'scroll_v6').flatMap((entry) => entry.items.map((product) => `${itemKey(product)}:${product.metadata.technicalSpecifications.find((s) => s.label === 'Хладагент')?.value}`)),
  ]);
  const retainedSeries = baseline.compressorSeries.filter((entry) => oldIds.has(entry.sourceId)).map((entry) => ({ ...entry, products: entry.products.filter((product) => entry.sourceId !== 'scroll' || !newScrollKeys.has(`${itemKey(product)}:${entry.refrigerant}`)) })).filter((entry) => entry.products.length);
  const combinedDirect = [...retainedDirect, ...safeDirectGroups].filter((entry) => entry.items.length);
  const combinedSeries = [...retainedSeries, ...compressorSeries];
  const report = {
    supersededDirectGroups,
    supersededPairs,
    retainedDirectGroups: retainedDirect.length,
    retainedCapacityProducts: retainedSeries.reduce((sum, entry) => sum + entry.products.length, 0),
    newDirectGroups: directGroups.length,
    newCapacityProducts: compressorSeries.reduce((sum, entry) => sum + entry.products.length, 0),
    issues,
  };
  return {
    ...baseline, version: 2, generatedAt, sources: [...priorSources, ...sources], directGroups: combinedDirect, compressorSeries: combinedSeries,
    importReport: report,
    stats: { directGroups: combinedDirect.length, directItems: combinedDirect.reduce((sum, entry) => sum + entry.items.length, 0), compressorSeries: combinedSeries.length, compressorItems: combinedSeries.reduce((sum, entry) => sum + entry.products.length, 0), sourceFlaggedItems: [...combinedDirect.flatMap((entry) => entry.items), ...combinedSeries.flatMap((entry) => entry.products)].filter((entry) => entry.sourceFlagged).length },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceDir = arg('--source-dir', process.env.ANALOGS_SOURCE_DIR);
  if (!sourceDir) throw new Error('Укажите --source-dir с исходными файлами клиента.');
  const target = arg('--output', path.join(ROOT, 'src/shared/data/analogs.generated.json'));
  const baseline = JSON.parse(fs.readFileSync(arg('--baseline', target), 'utf8'));
  const refcomp = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/shared/data/analogs.refcomp-source.json'), 'utf8'));
  const result = buildClientAnalogs({ baseline, sourceDir, refcomp });
  fs.writeFileSync(target, `${JSON.stringify(result)}\n`);
  console.log(JSON.stringify({ stats: result.stats, ...result.importReport }, null, 2));
}
