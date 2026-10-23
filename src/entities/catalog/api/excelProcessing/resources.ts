import { inflateRawSync } from 'node:zlib';
import type { WorkBook, CellObject } from 'xlsx';
import { ExcelResourceLimitError } from './errors';
import { assertLegacyOleResources } from './legacyOleResources';

// File/row/sheet limits are deliberately unchanged. These additional budgets
// cover expansion and sparse dimensions that compressed byte limits cannot see.
export const EXCEL_RESOURCE_LIMITS = Object.freeze({
  zipEntries: 2_048,
  unpackedBytes: 192 * 1024 * 1024,
  entryBytes: 128 * 1024 * 1024,
  columns: 256,
  cells: 2_000_000,
  rectangularCells: 3_000_000,
  cellCharacters: 32_767,
  textCharacters: 32 * 1024 * 1024,
});

type ArchiveLimits = { zipEntries: number; unpackedBytes: number; entryBytes: number };
const invalidArchive = () => new Error('Некорректный или неподдерживаемый архив Excel. Пересохраните файл в формате .xlsx или .xls.');

function checkedRange(buffer: Buffer, start: number, length: number, end = buffer.length) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start > end - length) throw invalidArchive();
  return buffer.subarray(start, start + length);
}

function checkExtraFields(extra: Buffer) {
  let offset = 0;
  while (offset < extra.length) {
    checkedRange(extra, offset, 4);
    const tag = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    // ZIP64 overrides sizes even without sentinel fields in some readers.
    // It is unnecessary for an upload capped at 25 MiB and is not accepted.
    if (tag === 1) throw invalidArchive();
    checkedRange(extra, offset + 4, size);
    offset += 4 + size;
  }
}

/** Validate actual expansion before SheetJS can allocate using ZIP metadata.
 * Runs only inside the isolated parsing worker in application request paths.
 * Legacy OLE/BIFF .xls has a separate FAT-chain copy budget: it too can amplify
 * native Buffers, outside the worker's V8 heap limit.
 */
export function assertExcelArchiveResources(buffer: Buffer, limits: ArchiveLimits = EXCEL_RESOURCE_LIMITS): void {
  assertLegacyOleResources(buffer, limits);
  if (buffer.length < 2 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) return;
  if (buffer.length < 22) throw invalidArchive();
  let end = -1;
  for (let offset = buffer.length - 22, min = Math.max(0, buffer.length - 65_557); offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw invalidArchive();
  // SheetJS locates the last EOCD signature without checking the comment length.
  // Reject a second signature in a comment instead of letting the two parsers
  // disagree about which directory was preflighted.
  if (buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) !== end) throw invalidArchive();
  const count = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryStart = buffer.readUInt32LE(end + 16);
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0 || count !== buffer.readUInt16LE(end + 8)
    || count === 0xffff || directoryStart === 0xffffffff || directorySize === 0xffffffff
    || directoryStart + directorySize !== end) throw invalidArchive();
  if (count > limits.zipEntries) throw new ExcelResourceLimitError(`Excel-файл содержит слишком много частей архива (максимум ${limits.zipEntries}).`);

  let offset = directoryStart;
  let total = 0;
  const names = new Set<string>();
  const occupied: Array<[number, number]> = [];
  for (let index = 0; index < count; index += 1) {
    checkedRange(buffer, offset, 46, end);
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw invalidArchive();
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressed = buffer.readUInt32LE(offset + 20);
    const expanded = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = checkedRange(buffer, offset + 46, nameLength, end);
    checkedRange(buffer, offset + 46 + nameLength, extraLength + commentLength, end);
    checkExtraFields(buffer.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength));
    if (flags & 0x2041 || (method !== 0 && method !== 8) || buffer.readUInt16LE(offset + 34) !== 0
      || !nameLength || nameLength > 1_024 || name.includes(0)) throw invalidArchive();
    const key = name.toString('utf8').replaceAll('\\', '/').toLowerCase();
    if (names.has(key) || key.startsWith('/') || key.split('/').includes('..')) throw invalidArchive();
    names.add(key);
    if (expanded > limits.entryBytes || expanded > limits.unpackedBytes - total) {
      throw new ExcelResourceLimitError('Excel-файл слишком велик после распаковки.');
    }
    checkedRange(buffer, local, 30, directoryStart);
    if (buffer.readUInt32LE(local) !== 0x04034b50 || buffer.readUInt16LE(local + 6) !== flags || buffer.readUInt16LE(local + 8) !== method) throw invalidArchive();
    const localNameLength = buffer.readUInt16LE(local + 26);
    const localExtraLength = buffer.readUInt16LE(local + 28);
    if (!checkedRange(buffer, local + 30, localNameLength, directoryStart).equals(name)) throw invalidArchive();
    checkExtraFields(checkedRange(buffer, local + 30 + localNameLength, localExtraLength, directoryStart));
    const dataStart = local + 30 + localNameLength + localExtraLength;
    const payload = checkedRange(buffer, dataStart, compressed, directoryStart);
    const descriptor = Boolean(flags & 8);
    for (const [at, expected] of [[14, crc], [18, compressed], [22, expanded]]) {
      const localValue = buffer.readUInt32LE(local + at);
      if (localValue !== expected && !(descriptor && localValue === 0)) throw invalidArchive();
    }
    let dataEnd = dataStart + compressed;
    if (descriptor) {
      checkedRange(buffer, dataEnd, 12, directoryStart);
      if (buffer.readUInt32LE(dataEnd) === 0x08074b50) dataEnd += 4;
      checkedRange(buffer, dataEnd, 12, directoryStart);
      if (buffer.readUInt32LE(dataEnd) !== crc || buffer.readUInt32LE(dataEnd + 4) !== compressed || buffer.readUInt32LE(dataEnd + 8) !== expanded) throw invalidArchive();
      dataEnd += 12;
    }
    occupied.push([local, dataEnd]);
    let actual = compressed;
    if (method === 8) {
      try {
        // maxOutputLength limits real inflation, even when BOTH headers lie.
        // Including `expanded` rejects a forged tiny declaration before allocating
        // a large expansion; the aggregate allowance also bounds successive parts.
        const inflated = inflateRawSync(payload, {
          maxOutputLength: Math.max(1, Math.min(expanded, limits.entryBytes, limits.unpackedBytes - total)),
          info: true,
        }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
        actual = inflated.buffer.length;
        if (inflated.engine.bytesWritten !== compressed) throw invalidArchive();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new ExcelResourceLimitError('Excel-файл превышает безопасный объём распаковки.');
        throw invalidArchive();
      }
    }
    if (actual !== expanded) throw invalidArchive();
    total += actual;
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== end) throw invalidArchive();
  occupied.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < occupied.length; index += 1) {
    if (occupied[index][0] < occupied[index - 1][1]) throw invalidArchive();
  }
}

function parseCellAddress(value: string): { row: number; column: number } | null {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(value.replaceAll('$', ''));
  if (!match) return null;
  let column = 0;
  for (const char of match[1]) column = column * 26 + char.charCodeAt(0) - 64;
  return { row: Number(match[2]), column };
}

/** Run before any sheet_to_json/rectangular array construction. */
export function assertExcelWorkbookResources(workbook: WorkBook): void {
  let cells = 0;
  let characters = 0;
  let scannedCells = 0;
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const range = sheet['!ref'];
    if (range) {
      const parts = range.split(':');
      const first = parseCellAddress(parts[0]);
      const last = parseCellAddress(parts.at(-1)!);
      if (!first || !last || first.column > last.column || first.row > last.row) throw new Error('Некорректный диапазон ячеек Excel.');
      if (last.column > EXCEL_RESOURCE_LIMITS.columns) throw new ExcelResourceLimitError(`В Excel-файле слишком много столбцов (максимум ${EXCEL_RESOURCE_LIMITS.columns}).`);
      scannedCells += (last.column - first.column + 1) * (last.row - first.row + 1);
      if (scannedCells > EXCEL_RESOURCE_LIMITS.rectangularCells) throw new ExcelResourceLimitError('Диапазон ячеек Excel слишком велик. Удалите лишние пустые строки и столбцы.');
    }
    for (const key of Object.keys(sheet)) {
      if (key.startsWith('!')) continue;
      if (++cells > EXCEL_RESOURCE_LIMITS.cells) throw new ExcelResourceLimitError(`Excel-файл содержит слишком много ячеек (максимум ${EXCEL_RESOURCE_LIMITS.cells}).`);
      const address = parseCellAddress(key);
      if (!address || address.column > EXCEL_RESOURCE_LIMITS.columns) throw new ExcelResourceLimitError('Excel-файл содержит недопустимый диапазон столбцов.');
      const cell = sheet[key] as CellObject;
      for (const value of [cell.v, cell.f]) {
        if (typeof value !== 'string') continue;
        if (value.length > EXCEL_RESOURCE_LIMITS.cellCharacters) throw new ExcelResourceLimitError(`Ячейка ${key} на листе «${sheetName}» содержит более ${EXCEL_RESOURCE_LIMITS.cellCharacters} символов.`);
        characters += value.length;
        if (characters > EXCEL_RESOURCE_LIMITS.textCharacters) throw new ExcelResourceLimitError('Excel-файл содержит слишком большой общий объём текста.');
      }
    }
  }
}
