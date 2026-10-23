import { ExcelResourceLimitError } from './errors';

const SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const FREE = 0xffffffff;
const END = 0xfffffffe;
const FAT = 0xfffffffd;
const DIFAT = 0xfffffffc;
const MAX_DIRECTORY_ENTRIES = 2_048;
const invalid = () => new Error('Некорректная структура старого Excel-файла. Пересохраните файл в формате .xlsx или .xls.');

type Limits = { unpackedBytes: number; entryBytes: number };
type Entry = { type: number; start: number; size: number; links: number[] };

/** Acyclic, non-merging chains let us calculate all suffix sizes in linear time. */
function inspectChains(values: Uint32Array, system: ReadonlySet<number> = new Set()) {
  const incoming = new Uint8Array(values.length);
  const lengths = new Uint32Array(values.length);
  const colors = new Uint8Array(values.length);
  for (let index = 0; index < values.length; index++) {
    const next = values[index];
    if (next < values.length) {
      if (system.has(next) || values[next] === FREE || ++incoming[next] > 1) throw invalid();
    } else if (![FREE, END, FAT, DIFAT].includes(next)) throw invalid();
    if (!system.has(index) && (next === FAT || next === DIFAT)) throw invalid();
  }
  for (let index = 0; index < values.length; index++) {
    if (colors[index] === 2) continue;
    const pending: number[] = [];
    let current = index;
    while (current < values.length && colors[current] === 0) {
      colors[current] = 1;
      pending.push(current);
      current = values[current];
    }
    if (current < values.length && colors[current] === 1) throw invalid();
    let length = current < values.length ? lengths[current] : 0;
    while (pending.length) {
      const sector = pending.pop()!;
      lengths[sector] = ++length;
      colors[sector] = 2;
    }
  }
  return { incoming, lengths };
}

/**
 * CFB/OLE is not ZIP, but SheetJS materializes FAT chains into native Buffers.
 * Aliased or highly fragmented chains can expand a small .xls outside V8's heap
 * limit. Preflight all indices/chains and the reader's actual copy budget first.
 * No stream contents are copied here; only bounded sector/directory metadata.
 */
export function assertLegacyOleResources(buffer: Buffer, limits: Limits = {
  unpackedBytes: 192 * 1024 * 1024, entryBytes: 128 * 1024 * 1024,
}): void {
  if (buffer.length < SIGNATURE.length || !buffer.subarray(0, 8).equals(SIGNATURE)) return;
  if (buffer.length < 512) throw invalid();
  const version = buffer.readUInt16LE(26);
  const shift = buffer.readUInt16LE(30);
  if (!((version === 3 && shift === 9) || (version === 4 && shift === 12)) || buffer.readUInt16LE(32) !== 6) throw invalid();
  const sectorBytes = 2 ** shift;
  if (buffer.length % sectorBytes || buffer.length < sectorBytes * 2) throw invalid();
  const sectorCount = buffer.length / sectorBytes - 1;
  const entriesPerSector = sectorBytes / 4;
  const fatCount = buffer.readUInt32LE(44);
  const directoryStart = buffer.readUInt32LE(48);
  const miniFatStart = buffer.readUInt32LE(60);
  const miniFatCount = buffer.readUInt32LE(64);
  const difatStart = buffer.readUInt32LE(68);
  const difatCount = buffer.readUInt32LE(72);
  if (!fatCount || fatCount > sectorCount || difatCount > sectorCount || miniFatCount > sectorCount
    || directoryStart >= sectorCount || buffer.readUInt32LE(56) !== 4096) throw invalid();
  const sectorOffset = (index: number) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= sectorCount) throw invalid();
    return (index + 1) * sectorBytes;
  };

  const fatSectors: number[] = [];
  const system = new Set<number>();
  const difatSectors = new Set<number>();
  let fatGap = false;
  function addFat(index: number) {
    if (index === FREE) { fatGap = true; return; }
    sectorOffset(index);
    if (fatGap || system.has(index) || fatSectors.length >= fatCount) throw invalid();
    system.add(index); fatSectors.push(index);
  }
  for (let index = 0; index < 109; index++) addFat(buffer.readUInt32LE(76 + index * 4));
  let difat = difatStart;
  for (let index = 0; index < difatCount; index++) {
    const at = sectorOffset(difat);
    if (system.has(difat)) throw invalid();
    system.add(difat); difatSectors.add(difat);
    for (let item = 0; item < entriesPerSector - 1; item++) addFat(buffer.readUInt32LE(at + item * 4));
    difat = buffer.readUInt32LE(at + sectorBytes - 4);
  }
  if ((difatCount ? difat !== END : difatStart !== END && difatStart !== FREE)
    || fatSectors.length !== fatCount || fatCount * entriesPerSector < sectorCount) throw invalid();
  const fat = new Uint32Array(sectorCount);
  for (let index = 0; index < sectorCount; index++) {
    fat[index] = buffer.readUInt32LE(sectorOffset(fatSectors[Math.floor(index / entriesPerSector)]) + (index % entriesPerSector) * 4);
  }
  for (const index of fatSectors) if (fat[index] !== FAT) throw invalid();
  for (const index of difatSectors) if (fat[index] !== DIFAT) throw invalid();
  const { incoming, lengths } = inspectChains(fat, system);

  // Match CFB.make_sector_list's rotation and unchecked-start behavior. Its
  // inner traversal copies already-seen tails, so valid reverse fragmentation
  // also needs a budget, even when stream ownership itself is disjoint.
  const seen = new Uint8Array(sectorCount);
  let copiedBytes = 0;
  for (let index = 0; index < sectorCount; index++) {
    let current = (index + directoryStart) % sectorCount;
    if (seen[current]) continue;
    copiedBytes += lengths[current] * sectorBytes;
    if (copiedBytes > limits.unpackedBytes) {
      throw new ExcelResourceLimitError('Старый Excel-файл слишком фрагментирован для безопасного чтения. Пересохраните его в формате .xlsx.');
    }
    while (current < sectorCount && !seen[current]) {
      seen[current] = 1;
      current = fat[current];
    }
  }

  const owners = new Set<number>(system);
  function claimChain(start: number, size?: number) {
    sectorOffset(start);
    if (incoming[start] || fat[start] === FREE) throw invalid();
    const chain: number[] = [];
    let current = start;
    while (current < sectorCount) {
      if (owners.has(current)) throw invalid();
      owners.add(current); chain.push(current);
      current = fat[current];
    }
    if (current !== END || (size !== undefined && chain.length * sectorBytes < size)) throw invalid();
    return chain;
  }
  const directory = claimChain(directoryStart);
  if (directory.length * sectorBytes / 128 > MAX_DIRECTORY_ENTRIES) {
    throw new ExcelResourceLimitError(`Старый Excel-файл содержит слишком много служебных записей (максимум ${MAX_DIRECTORY_ENTRIES}).`);
  }
  const miniFat = miniFatCount ? claimChain(miniFatStart) : [];
  if (miniFat.length !== miniFatCount || (!miniFatCount && miniFatStart !== END && miniFatStart !== FREE)) throw invalid();
  const entries: Entry[] = [];
  for (const sector of directory) {
    for (let offset = sectorOffset(sector), end = offset + sectorBytes; offset < end; offset += 128) {
      const type = buffer[offset + 66];
      const size = buffer.readUInt32LE(offset + 120) + buffer.readUInt32LE(offset + 124) * 2 ** 32;
      if (![0, 1, 2, 5].includes(type) || !Number.isSafeInteger(size) || (type !== 2 && type !== 5 && size)) throw invalid();
      if (size > limits.entryBytes || size > buffer.length) throw new ExcelResourceLimitError('Поток старого Excel-файла превышает безопасный размер.');
      entries.push({ type, size, start: buffer.readUInt32LE(offset + 116),
        links: [68, 72, 76].map(position => buffer.readUInt32LE(offset + position)) });
    }
  }
  if (entries[0]?.type !== 5 || entries.slice(1).some(entry => entry.type === 5)) throw invalid();
  if (entries[0].links[0] !== FREE || entries[0].links[1] !== FREE) throw invalid();
  // CFB.build_full_paths follows these links. Reject cycles/shared children
  // before it can grow a queue or repeatedly concatenate directory names.
  const directoryIncoming = new Uint8Array(entries.length);
  for (const entry of entries) {
    if (!entry.type) {
      // Some writers zero unused directory slots instead of using NOSTREAM.
      // SheetJS still visits their links: permit only zero/the root or FREE,
      // never an active child or a cycle hidden in otherwise unused entries.
      // The root's sibling links are required to be FREE above, so revisiting
      // it cannot enqueue another branch from these zero-filled entries.
      if (entry.links.some(index => index !== FREE && index !== 0)) throw invalid();
      continue;
    }
    for (const index of entry.links) {
      if (index === FREE) continue;
      if (index >= entries.length || !entries[index].type || ++directoryIncoming[index] > 1) throw invalid();
    }
  }
  const reached = new Set<number>();
  const pending = [0];
  while (pending.length) {
    const index = pending.pop()!;
    if (reached.has(index)) throw invalid();
    reached.add(index);
    for (const next of entries[index].links) if (next !== FREE) pending.push(next);
  }
  if (entries.some((entry, index) => entry.type && !reached.has(index))) throw invalid();

  const root = entries[0];
  if (root.size) claimChain(root.start, root.size);
  const miniCount = Math.ceil(root.size / 64);
  if (miniCount > miniFatCount * entriesPerSector) throw invalid();
  const miniLinks = new Uint32Array(miniCount);
  for (let index = 0; index < miniCount; index++) {
    miniLinks[index] = buffer.readUInt32LE(sectorOffset(miniFat[Math.floor(index / entriesPerSector)]) + (index % entriesPerSector) * 4);
  }
  const miniInspection = inspectChains(miniLinks);
  const miniOwners = new Set<number>();
  for (const entry of entries.slice(1)) {
    if (!entry.size) continue;
    if (entry.size >= 4096) { claimChain(entry.start, entry.size); continue; }
    if (entry.start >= miniCount || miniInspection.incoming[entry.start] || miniLinks[entry.start] === FREE) throw invalid();
    let current = entry.start;
    let count = 0;
    while (current < miniCount) {
      if (miniOwners.has(current)) throw invalid();
      miniOwners.add(current); count++;
      current = miniLinks[current];
    }
    if (current !== END || count * 64 < entry.size) throw invalid();
    copiedBytes += Math.ceil(entry.size / 64) * 64;
    if (copiedBytes > limits.unpackedBytes) throw new ExcelResourceLimitError('Старый Excel-файл превышает безопасный объём обработки.');
  }
}
