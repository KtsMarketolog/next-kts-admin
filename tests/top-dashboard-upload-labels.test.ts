import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';

import { detectTopDashboardUploadTargets, type TopDashboardUploadTarget } from '../src/shared/lib/topDashboardUploadTargets';
import { multiFileAdapterScript } from '../src/shared/lib/topDashboardContentSecurity/sandbox/multiFileAdapter';
import { getTopDashboardUploadLabel } from '../src/shared/lib/topDashboardUploadLabels';

type InputFixture = {
  attributes: Record<string, string>;
  label?: string;
};

const calendarInputs: InputFixture[] = [
  { attributes: { type: 'file', id: 'fi', accept: '.xlsx,.xls,.xlsm', multiple: '', hidden: '' } },
  { attributes: { type: 'file', id: 'fd', webkitdirectory: '', multiple: '', hidden: '' } },
  { attributes: { type: 'file', id: 'fs', accept: '.json', hidden: '' } },
];

function escapeAttribute(text: string) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function markup(inputs: InputFixture[]) {
  return inputs.map(({ attributes, label }) => `${label === undefined ? '' : `<label for="${escapeAttribute(attributes.id ?? '')}">${escapeAttribute(label)}</label>`}
    <input ${Object.entries(attributes).map(([key, value]) => `${key}="${escapeAttribute(value)}"`).join(' ')}>`).join('\n');
}

/** Run the real generated discovery, without executing uploaded HTML or opening a browser. */
function runtimeDiscovery(fixtures: InputFixture[], script = multiFileAdapterScript()) {
  class FileInput {
    constructor(readonly fixture: InputFixture) {}
    get type() { return this.fixture.attributes.type; }
    get id() { return this.fixture.attributes.id ?? ''; }
    get name() { return this.fixture.attributes.name ?? ''; }
    get accept() { return this.fixture.attributes.accept ?? ''; }
    get title() { return this.fixture.attributes.title ?? ''; }
    get multiple() { return this.hasAttribute('multiple'); }
    get disabled() { return this.hasAttribute('disabled'); }
    get labels() { return this.fixture.label === undefined ? [] : [{ textContent: this.fixture.label }]; }
    hasAttribute(name: string) { return Object.hasOwn(this.fixture.attributes, name); }
    getAttribute(name: string) { return this.fixture.attributes[name] ?? null; }
  }
  const inputs = fixtures.map(fixture => new FileInput(fixture));
  const messages: Array<{ targets: TopDashboardUploadTarget[] }> = [];
  const observed: MutationObserverInit[] = [];
  const context = {
    MULTI_FILE_MODE: true,
    READ_ONLY: false,
    MULTI_FILE_MARKER: 'synthetic-upload-discovery',
    HTMLInputElement: FileInput,
    TextEncoder,
    MutationObserver: class {
      observe(_root: unknown, options: MutationObserverInit) { observed.push(options); }
    },
    document: {
      documentElement: {},
      querySelectorAll: () => inputs,
      addEventListener() {},
    },
    window: {
      parent: { postMessage(message: { targets: TopDashboardUploadTarget[] }) { messages.push(message); } },
      setTimeout() { return 1; },
    },
  };
  runInNewContext(`${script}\nreportUploadTargets(true, 'synthetic-request');`, context);
  assert.equal(messages.length, 1);
  return {
    targets: JSON.parse(JSON.stringify(messages[0].targets)) as TopDashboardUploadTarget[],
    observed,
  };
}

function bothDiscoveries(fixtures: InputFixture[]) {
  const server = detectTopDashboardUploadTargets(markup(fixtures));
  const browser = runtimeDiscovery(fixtures);
  assert.deepEqual(browser.targets, server, 'Server metadata and live iframe discovery must show the same labels and target identities');
  return server;
}

test('calendar file, folder and JSON fields get readable labels without changing their destinations', () => {
  const targets = bothDiscoveries(calendarInputs);
  assert.match(targets[0].label, /Excel/);
  assert.match(targets[1].label, /Папка/);
  assert.match(targets[2].label, /JSON/);
  assert.deepEqual(targets.map(({ target, multiple, directory, accept }) => ({ target, multiple, directory, accept })), [
    { target: { id: 'fi', name: null, index: 0 }, multiple: true, directory: false, accept: '.xlsx,.xls,.xlsm' },
    { target: { id: 'fd', name: null, index: 1 }, multiple: true, directory: true, accept: '' },
    { target: { id: 'fs', name: null, index: 2 }, multiple: false, directory: false, accept: '.json' },
  ]);
  assert.equal(targets.some(target => ['fi', 'fd', 'fs'].includes(target.label)), false);
});

test('fallback labels are derived from file controls, never calendar-specific IDs or names', () => {
  const original = bothDiscoveries(calendarInputs);
  const renamed = bothDiscoveries(calendarInputs.map(({ attributes }, index) => ({
    attributes: { ...attributes, id: `another-${index}`, name: `source-${index}` },
  })));
  assert.deepEqual(renamed.map(target => target.label), original.map(target => target.label));
  assert.deepEqual(renamed.map(target => target.target.id), ['another-0', 'another-1', 'another-2']);
});

test('author-provided accessible labels and titles take precedence over inferred file labels', () => {
  const targets = bothDiscoveries([
    { attributes: { type: 'file', id: 'one', 'aria-label': '  Продажи\nза месяц  ', title: 'Fallback', accept: '.json' }, label: 'Other label' },
    { attributes: { type: 'file', id: 'two', 'aria-label': '  ', title: 'Fallback', accept: '.xlsx' }, label: 'Остатки на складах' },
    { attributes: { type: 'file', id: 'three', title: '  План\nзакупок  ', accept: '.json' } },
  ]);
  assert.deepEqual(targets.map(target => target.label), ['Продажи за месяц', 'Остатки на складах', 'План закупок']);
});

test('missing labels fall back safely for mixed or unknown file types', () => {
  const targets = bothDiscoveries([
    { attributes: { type: 'file', id: 'fs', accept: '.json,.xlsx', multiple: '' } },
    { attributes: { type: 'file', id: 'fi', accept: '.custom' } },
    { attributes: { type: 'file', name: 'opaque-field' } },
  ]);
  for (const target of targets) {
    assert.ok(target.label.length > 0 && target.label.length <= 160);
    assert.doesNotMatch(target.label, /Excel|JSON|opaque-field|^fi$|^fs$/);
  }
});

test('presentation changes retain duplicate and disabled field targeting rules', () => {
  const targets = bothDiscoveries([
    { attributes: { type: 'file', id: 'ignored', disabled: '' } },
    { attributes: { type: 'file', id: 'same', name: 'also-same', accept: '.xlsx', multiple: '' } },
    { attributes: { type: 'file', id: 'same', name: 'also-same', accept: '.json' } },
  ]);
  assert.deepEqual(targets.map(target => target.target), [
    { id: null, name: null, index: 1 },
    { id: null, name: null, index: 2 },
  ]);
});

test('author labels stay plain text, bounded and identical before and after preview discovery', () => {
  const text = '<img src=x onerror=alert(1)> ' + 'Данные '.repeat(50);
  const targets = bothDiscoveries([{ attributes: { type: 'file', id: 'x', 'aria-label': text } }]);
  assert.equal(targets[0].label, text.trim().slice(0, 160));
  assert.deepEqual(targets[0].target, { id: 'x', name: null, index: 0 });
});

test('runtime discovery observes changes to both accessible labels and title fallbacks', () => {
  const { observed } = runtimeDiscovery(calendarInputs);
  assert.equal(observed.length, 1);
  assert.ok(observed[0].attributeFilter?.includes('aria-label'));
  assert.ok(observed[0].attributeFilter?.includes('title'));
});

test('supported Excel and JSON accept tokens produce singular or plural labels without widening accepted files', () => {
  const excelTypes = [
    '.xlsx,.xls,.xlsm',
    ' .XLSX , .XLS ',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel.sheet.macroEnabled.12',
  ];
  const jsonTypes = ['.json', '.json.gz', '.json,.json.gz,application/json', ' APPLICATION/JSON '];
  for (const multiple of [false, true]) {
    for (const accept of excelTypes) {
      assert.equal(getTopDashboardUploadLabel({ accept, multiple, directory: false, index: 0 }), multiple ? 'Excel-файлы' : 'Excel-файл');
    }
    for (const accept of jsonTypes) {
      assert.equal(getTopDashboardUploadLabel({ accept, multiple, directory: false, index: 0 }), multiple ? 'JSON-снимки' : 'JSON-снимок');
    }
  }
});

test('ambiguous, generic and misleading accept tokens retain neutral numbered labels', () => {
  for (const accept of ['', '.json.exe', '.xlsx.backup', '.json,.csv', '.xlsx,.ods', 'application/gzip', '*/*', '.json,']) {
    assert.equal(getTopDashboardUploadLabel({ accept, multiple: false, directory: false, index: 4 }), 'Файл данных 5', accept);
    assert.equal(getTopDashboardUploadLabel({ accept, multiple: true, directory: false, index: 4 }), 'Файлы данных 5', accept);
  }
  assert.equal(getTopDashboardUploadLabel({ accept: '.json', multiple: true, directory: true, index: 4 }), 'Папка с файлами');
});

test('oversized raw accept attributes fall back before tokenization and do not infer from a truncated prefix', () => {
  for (const accept of ['.json,'.repeat(180_000) + '.json', ','.repeat(1024 * 1024), '.xlsx,'.repeat(180_000) + '.xlsx']) {
    assert.ok(accept.length >= 1024 * 1024);
    assert.equal(getTopDashboardUploadLabel({ accept, multiple: true, directory: false, index: 0 }), 'Файлы данных 1');
    const targets = bothDiscoveries([{ attributes: { type: 'file', id: 'long-accept', accept, multiple: '' } }]);
    assert.equal(targets[0].label, 'Файлы данных 1');
    assert.ok(targets[0].accept.length <= 512);
    assert.deepEqual(targets[0].target, { id: 'long-accept', name: null, index: 0 });
  }
  assert.equal(getTopDashboardUploadLabel({ accept: '.xlsx' + ' '.repeat(1024 * 1024), multiple: false, directory: false, index: 4 }), 'Файл данных 5');
});

test('serialized label helper remains self-contained after bundling and minification', () => {
  const bundle = buildSync({
    entryPoints: [new URL('../src/shared/lib/topDashboardContentSecurity/sandbox/multiFileAdapter.ts', import.meta.url).pathname],
    platform: 'node', format: 'cjs', bundle: true, minify: true, write: false,
  });
  const bundled = { exports: {} as { multiFileAdapterScript(): string } };
  runInNewContext(bundle.outputFiles[0].text, { module: bundled, exports: bundled.exports, require: createRequire(import.meta.url), TextEncoder, TextDecoder });
  assert.deepEqual(runtimeDiscovery(calendarInputs, bundled.exports.multiFileAdapterScript()).targets, detectTopDashboardUploadTargets(markup(calendarInputs)));
});
