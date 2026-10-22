import assert from 'node:assert/strict';
import test from 'node:test';
import data from '../src/shared/data/analogs.generated.json';
import { searchAnalogs } from '../src/shared/lib/analogs';
import { operatingPointKey } from '../scripts/import-client-analogs.mjs';

test('new source provenance is versioned and all five supplied comparison sources are retained', () => {
  const newer = data.sources.filter((source) => 'importedBatch' in source);
  assert.deepEqual(newer.map((source) => source.id), ['ankang_tecumseh_202608', 'axial_202608', 'sanhua_202608', 'scroll_v6', 'refcomp_202608']);
  assert.ok(newer.every((source) => 'priority' in source && source.priority === 100));
  assert.ok(newer.filter((source) => source.id !== 'refcomp_202608').every((source) => 'sha256' in source && /^[a-f0-9]{64}$/.test(String(source.sha256))));
});

test('Ankang new column layout does not turn wattage into a model or restore missing capacity', () => {
  const groups = data.directGroups.filter((group) => group.sourceId === 'ankang_tecumseh_202608');
  assert.equal(groups.length, 39);
  const first = groups.find((group) => group.items.some((item) => item.model === 'QR-26A'))!;
  assert.ok(first.items.some((item) => item.model === 'CAJ4517Z-TU'));
  assert.ok(JSON.stringify(first).includes('3647'));
  const missing = groups.flatMap((group) => group.items).find((item) => item.model === 'QL3-112')!;
  assert.equal((missing.metadata as Record<string, unknown>).coolingCapacityW, null);
  assert.equal(missing.sourceFlagged, true);
});

test('new Sanhua columns preserve owned article aliases and merged connection notes', () => {
  const source = data.directGroups.find((group) => group.sourceId === 'sanhua_202608' && group.items.some((item) => item.model === 'YCVS2H01'))!;
  const sanhua = source.items.find((item) => item.model === 'YCVS2H01')!;
  assert.ok(sanhua.aliases.includes('10162001602'));
  assert.ok(sanhua.aliases.includes('ЦБ-Ц0049878'));
  assert.ok(!sanhua.aliases.includes('020B1010'));
  assert.ok(JSON.stringify(sanhua.metadata).includes('Пайка'));
  assert.ok(source.items.some((item) => item.brand === 'Danfoss' && item.aliases.includes('020B1010')));
});

test('identical old and new Sanhua designations never appear as their own alternatives', () => {
  const response = searchAnalogs('SYJ10L11', null, 'Sanhua');
  assert.ok(response.matches.length > 0);
  assert.ok(response.results.length > 0);
  assert.ok(!response.results.some((row) => row.model === 'SYJ10L11' && row.brand.startsWith('Sanhua')));
});

test('contradictory Sanhua print names do not supply catalog identifiers', () => {
  const row = data.directGroups.find((group) => group.sourceId === 'sanhua_202608' && group.items.some((item) => item.model === 'YCVSH3H02'))!;
  const entry = row.items.find((item) => item.model === 'YCVSH3H02')!;
  assert.equal(entry.sourceFlagged, true);
  assert.deepEqual((entry.metadata as Record<string, unknown>).catalogAliases, []);
  assert.ok(!entry.aliases.includes('10162000502'));
});

test('variable scroll ranges are preserved as references and never parsed as their first number', () => {
  const reference = data.directGroups.find((group) => group.sourceId === 'scroll_v6' && group.items.some((item) => item.model === 'YIH38C1G-100'))!;
  assert.equal(reference.items.length, 1);
  assert.ok(JSON.stringify(reference).includes('6,05…18,88'));
  assert.equal(reference.items[0].sourceFlagged, true);
  assert.ok(!data.compressorSeries.some((series) => series.products.some((product) => product.model === 'YIH38C1G-100')));
});

test('latest fixed scroll capacity replaces the previous version and keeps calculation conditions', () => {
  const values = data.compressorSeries.flatMap((series) => series.products.filter((product) => product.model === 'YH95C1-100').map((product) => ({ sourceId: series.sourceId, product })));
  assert.equal(values.length, 1);
  assert.equal(values[0].sourceId, 'scroll_v6');
  assert.equal(values[0].product.coolingCapacityKw, 9.43);
  assert.ok(JSON.stringify(values[0].product).includes('То=+5С'));
});

test('repeated capacity models retain distinct source-row identifiers in results', () => {
  const response = searchAnalogs('YH150C1-100', 'R410A', 'Invotech');
  assert.ok(response.results.length > 0);
  assert.equal(new Set(response.results.map((row) => row.id)).size, response.results.length);
});

test('capacity comparison never combines different or incomplete operating points', () => {
  assert.equal(operatingPointKey('То=+5С, Тк=50С, SН=11,1К, SC=8,3K (программа)'), '5|50|11.1|8.3');
  assert.equal(operatingPointKey('То=+5С, Тк=50С, SH=11К, SC=8,0K'), '5|50|11|8');
  assert.equal(operatingPointKey('То=+5С, Тк=50С, SC=8,0K'), null);
  assert.equal(operatingPointKey(''), null);
  assert.equal(operatingPointKey('То=+5С, Тк=50С, SH=11К, SC=8,0K; SH=10K'), null);
  const invotech = data.compressorSeries.find((series) => series.sourceId === 'scroll_v6' && series.products.some((product) => product.model === 'YH95C1-100'))!;
  assert.ok(invotech.products.every((product) => product.brand !== 'Copeland'));
  const response = searchAnalogs('YH95C1-100');
  assert.ok(response.results.every((result) => result.brand !== 'Copeland'));
});

test('EVI header is row 222 and row 221 supplies explicit operating conditions', () => {
  const evi = data.compressorSeries.find((series) => series.sourceId === 'scroll_v6' && series.application.includes('EVI'))!;
  assert.ok(evi.products.some((product) => product.brand === 'Invotech' && product.model === 'YF13E1G-V100'));
  assert.ok(evi.products.every((product) => !product.brand.includes('То=')));
  assert.ok(JSON.stringify(evi).includes('-35|45|10|2'));
});

test('unaffected legacy EBM links survive but overwritten model pairs use only new rows', () => {
  const legacy = searchAnalogs('S4E350AN1943');
  assert.ok(legacy.results.some((result) => result.model === 'YWF.A4S-350S-5DIA00'));
  assert.ok(legacy.notices.some((notice) => notice.includes('не являются абсолютно взамозаменяемыми')));
  const newest = searchAnalogs('YWF.A2S-200S-5DIA00');
  assert.ok(newest.results.every((result) => result.sourceId === 'axial_202608'));
});

test('contradictory fan voltage does not silently fall back to a superseded old mapping', () => {
  const response = searchAnalogs('YDWF102L45P4-522N-450B');
  assert.equal(response.results.length, 0);
  assert.ok(response.matches.some((match) => match.note?.includes('различными напряжениями')));
});

test('Refcomp image transcription preserves all 36 rows and does not invent the missing Bitzer', () => {
  const rows = data.directGroups.filter((group) => group.sourceId === 'refcomp_202608');
  assert.equal(rows.length, 36);
  const incomplete = rows.find((group) => group.items.some((item) => item.model === 'SP8L600E'))!;
  assert.equal(incomplete.items.length, 2);
  assert.ok(incomplete.items.every((item) => item.brand !== 'Bitzer'));
  assert.ok(JSON.stringify(incomplete).includes('Объёмная производительность'));
  assert.ok(!JSON.stringify(incomplete).includes('coolingCapacityKw'));
});
