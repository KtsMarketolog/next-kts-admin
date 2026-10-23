import assert from 'node:assert/strict';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { assertExcelArchiveResources } from '../src/entities/catalog/api/excelProcessing/resources';
import { assertLegacyOleResources } from '../src/entities/catalog/api/excelProcessing/legacyOleResources';
import { ExcelResourceLimitError } from '../src/entities/catalog/api/excelProcessing/errors';
import { parseCatalogExcel } from '../src/entities/catalog/api/catalogExcel';

const FREE = 0xffffffff;
const END = 0xfffffffe;

function basicWorkbook() {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Артикул', 'Наименование'], ['SYN-LEGACY', 'Synthetic']]), 'Synthetic');
  return Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'biff8' }));
}

// Test fixtures stay below 109 FAT sectors; production guard also validates
// larger DIFAT-based containers, without following a user-supplied offset here.
function directoryEntries(buffer: Buffer) {
  const sectorBytes = 2 ** buffer.readUInt16LE(30);
  const perFat = sectorBytes / 4;
  const at = (sector: number) => (sector + 1) * sectorBytes;
  const next = (sector: number) => {
    const fat = buffer.readUInt32LE(76 + Math.floor(sector / perFat) * 4);
    return buffer.readUInt32LE(at(fat) + (sector % perFat) * 4);
  };
  const result: Array<{ offset: number; name: string; type: number }> = [];
  for (let sector = buffer.readUInt32LE(48); sector !== END; sector = next(sector)) {
    for (let offset = at(sector), end = offset + sectorBytes; offset < end; offset += 128) {
      const nameLength = buffer.readUInt16LE(offset + 64);
      result.push({ offset, name: buffer.subarray(offset, offset + Math.max(0, nameLength - 2)).toString('utf16le'), type: buffer[offset + 66] });
    }
  }
  return result;
}

test('legacy OLE rejects many aliases to long native-buffer FAT tails before SheetJS materializes them', () => {
  const cfb = XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_add(cfb, 'Payload', Buffer.alloc(256 * 1024, 42));
  for (let index = 0; index < 128; index += 1) XLSX.CFB.utils.cfb_add(cfb, `Alias${String(index).padStart(3, '0')}`, Buffer.alloc(4));
  const bytes = Buffer.from(XLSX.CFB.write(cfb, { type: 'buffer' }));
  assert.ok(bytes.length < 300_000);
  assert.doesNotThrow(() => assertLegacyOleResources(bytes));
  const entries = directoryEntries(bytes);
  const payload = entries.find(entry => entry.name === 'Payload')!;
  assert.ok(payload);
  const payloadStart = bytes.readUInt32LE(payload.offset + 116);
  let index = 0;
  for (const alias of entries.filter(entry => entry.name.startsWith('Alias'))) {
    // The old parser concatenates each remaining 256-KiB chain, even though
    // the alias declares only 4 KiB. Do NOT feed this rejected fixture to it.
    bytes.writeUInt32LE(payloadStart + index++, alias.offset + 116);
    bytes.writeUInt32LE(4096, alias.offset + 120);
  }
  assert.equal(index, 128);
  assert.throws(() => assertLegacyOleResources(bytes), /Некорректная структура/);
  assert.throws(() => assertExcelArchiveResources(bytes), /Некорректная структура/);
});

test('legacy OLE copy budget and declared stream limits apply before reading cells', () => {
  const bytes = basicWorkbook();
  assert.throws(() => assertLegacyOleResources(bytes, { unpackedBytes: 512, entryBytes: 128 * 1024 * 1024 }), ExcelResourceLimitError);
  const workbook = directoryEntries(bytes).find(entry => entry.name === 'Workbook')!;
  bytes.writeUInt32LE(0x7fffffff, workbook.offset + 120);
  assert.throws(() => assertLegacyOleResources(bytes), ExcelResourceLimitError);
});

test('legacy OLE reverse fragmentation counts repeated suffix copies rather than only physical bytes', () => {
  const cfb = XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_add(cfb, 'Payload', Buffer.alloc(64 * 1024, 42));
  const bytes = Buffer.from(XLSX.CFB.write(cfb, { type: 'buffer' }));
  const limits = { unpackedBytes: 512 * 1024, entryBytes: 128 * 1024 * 1024 };
  assert.ok(bytes.length < 100_000);
  assert.doesNotThrow(() => assertLegacyOleResources(bytes, limits));
  const payload = directoryEntries(bytes).find(entry => entry.name === 'Payload')!;
  const fatEntry = (sector: number) => {
    const fatSector = bytes.readUInt32LE(76 + Math.floor(sector / 128) * 4);
    return (fatSector + 1) * 512 + (sector % 128) * 4;
  };
  const chain: number[] = [];
  for (let sector = bytes.readUInt32LE(payload.offset + 116); sector !== END; sector = bytes.readUInt32LE(fatEntry(sector))) chain.push(sector);
  assert.equal(chain.length, 128);
  for (let index = 0; index < chain.length; index += 1) bytes.writeUInt32LE(index ? chain[index - 1] : END, fatEntry(chain[index]));
  bytes.writeUInt32LE(chain.at(-1)!, payload.offset + 116);
  // Constant bytes make this a semantically unchanged stream. SheetJS's
  // ascending sector scan nonetheless materializes 1+2+...+128 sector suffixes.
  // Only run preflight here, never the amplifying parser on this fixture.
  assert.doesNotThrow(() => assertLegacyOleResources(bytes));
  assert.throws(() => assertLegacyOleResources(bytes, limits), (error: unknown) => error instanceof ExcelResourceLimitError && /фрагментирован/.test(error.message));
});

test('legacy OLE handles zero-filled unused directory slots without allowing active hidden links', () => {
  const original = basicWorkbook();
  const unused = directoryEntries(original).find(entry => entry.type === 0)!;
  assert.ok(unused);
  const zeroFilled = Buffer.from(original);
  for (const position of [68, 72, 76]) zeroFilled.writeUInt32LE(0, unused.offset + position);
  assert.doesNotThrow(() => assertLegacyOleResources(zeroFilled));
  assert.equal(parseCatalogExcel(zeroFilled)[0].article, 'SYN-LEGACY');
  const hidden = Buffer.from(original);
  hidden.writeUInt32LE(1, unused.offset + 76);
  assert.throws(() => assertLegacyOleResources(hidden), /Некорректная структура/);
  const rootSibling = Buffer.from(original);
  rootSibling.writeUInt32LE(1, directoryEntries(rootSibling)[0].offset + 68);
  assert.throws(() => assertLegacyOleResources(rootSibling), /Некорректная структура/);
});

test('legacy OLE rejects FAT loops, directory cycles, truncated sectors and invalid DIFAT pointers', () => {
  const source = basicWorkbook();
  const entries = directoryEntries(source);
  const root = entries[0].offset;
  const cyclicDirectory = Buffer.from(source); cyclicDirectory.writeUInt32LE(0, root + 76);
  assert.throws(() => assertLegacyOleResources(cyclicDirectory), /Некорректная структура/);
  const cyclicFat = Buffer.from(source);
  const directory = cyclicFat.readUInt32LE(48);
  const fat = cyclicFat.readUInt32LE(76 + Math.floor(directory / 128) * 4);
  cyclicFat.writeUInt32LE(directory, (fat + 1) * 512 + (directory % 128) * 4);
  assert.throws(() => assertLegacyOleResources(cyclicFat), /Некорректная структура/);
  assert.throws(() => assertLegacyOleResources(source.subarray(0, source.length - 1)), /Некорректная структура/);
  const invalidDifat = Buffer.from(source); invalidDifat.writeUInt32LE(FREE - 10, 68); invalidDifat.writeUInt32LE(1, 72);
  assert.throws(() => assertLegacyOleResources(invalidDifat), /Некорректная структура/);
});
