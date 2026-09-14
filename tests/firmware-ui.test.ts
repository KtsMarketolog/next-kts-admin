import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as jsx from 'react/jsx-runtime';
import ts from 'typescript';

import * as contract from '../src/shared/lib/firmwareContract';

type Element = { type: unknown; props: Record<string, unknown> };
type Selection = { file: File; sha256: string | null; error: string | null };
type Pair = Record<contract.FirmwareKind, Selection | null>;
type API = {
  AdminFirmwareSection: (props: { showStatus: (message: string) => void }) => Element;
  validateFirmwareFileSelection: (file: Pick<File, 'name' | 'size'>, kind: contract.FirmwareKind) => string | null;
  firmwarePairReady: (pair: Pair) => boolean;
  firmwarePublishForm: (pair: Pair, revision: string) => FormData;
};
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const current: contract.FirmwareVersion = {
  id: '11111111-1111-4111-8111-111111111111', createdAt: '2026-09-15T00:00:00Z', versionLabel: '1.55',
  files: {
    c23: { ...contract.FIRMWARE_FILES.c23, size: 3, sha256: hash('old') },
    ver: { ...contract.FIRMWARE_FILES.ver, size: 13, sha256: hash('Version: 1.55') },
  },
};
const overview: contract.FirmwareOverview = {
  revision: '22222222-2222-4222-8222-222222222222', current,
  previous: { ...current, id: '33333333-3333-4333-8333-333333333333', versionLabel: '1.54' }, storageBytes: 32,
};
const updated: contract.FirmwareOverview = { ...overview, revision: '44444444-4444-4444-8444-444444444444', previous: current };
const c23 = new File([new Uint8Array([0, 255, 128, 13, 10])], 'new.c23');
const ver = new File(['Version: 1.56'], 'new.ver');

function elements(node: unknown): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== 'object' || !('props' in node)) return [];
  const item = node as Element;
  return [item, ...elements(item.props.children)];
}
function text(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (!node || typeof node !== 'object' || !('props' in node)) return '';
  return text((node as Element).props.children);
}

// Execute the actual component and event handlers with a tiny deterministic
// hook driver. Only browser IO/CSS is injected; no server module is loaded.
function ui(options: { post?: (init: RequestInit) => Promise<Response>; get?: () => Promise<Response>; confirm?: boolean } = {}) {
  const slots: unknown[] = [];
  const effects: Array<() => unknown> = [];
  let cursor = 0;
  const hooks = {
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useRef: (initial: unknown) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback: (callback: unknown) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = callback;
      return slots[index];
    },
    useEffect: (callback: () => unknown) => {
      const index = cursor++;
      if (!(index in slots)) { slots[index] = true; effects.push(callback); }
    },
  };
  const requests: RequestInit[] = [];
  const messages: string[] = [], confirmations: string[] = [];
  let getCount = 0;
  const fetch = async (url: string, init: RequestInit = {}) => {
    assert.equal(url, '/api/admin/firmware');
    requests.push(init);
    if (init.method === 'POST') return options.post ? options.post(init) : Response.json(updated);
    getCount++;
    return options.get && getCount > 1 ? options.get() : Response.json(overview);
  };
  const source = readFileSync(new URL('../src/features/admin/firmware/AdminFirmwareSection.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const modules: Record<string, unknown> = {
    react: hooks, 'react/jsx-runtime': jsx, '@/app/admin/admin.module.scss': { default: {} }, '@/shared/lib/firmwareContract': contract,
  };
  const testModule = { exports: {} as API };
  new Function('require', 'module', 'exports', 'fetch', 'window', 'crypto', code)((name: string) => {
    assert.ok(name in modules, `Unexpected dependency ${name}`); return modules[name];
  }, testModule, testModule.exports, fetch, { confirm: (message: string) => { confirmations.push(message); return options.confirm !== false; } }, webcrypto);
  let tree: Element;
  const render = () => { cursor = 0; tree = testModule.exports.AdminFirmwareSection({ showStatus: (message) => messages.push(message) }); return tree; };
  const find = (type: string, predicate: (props: Element['props']) => boolean = () => true) => {
    const item = elements(render()).find((node) => node.type === type && predicate(node.props));
    assert.ok(item, `Missing ${type}`); return item;
  };
  const settle = async (ready: () => boolean = () => true) => {
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      render();
      if (ready()) return;
    }
    assert.fail('UI did not settle');
  };
  const select = async () => {
    for (const [kind, file] of [['c23', c23], ['ver', ver]] as const) {
      const input = find('input', (props) => props['aria-label'] === `Файл .${kind}`);
      (input.props.onChange as (event: unknown) => void)({ target: { files: [file] } });
    }
    await settle(() => text(tree).includes(hash(new Uint8Array([0, 255, 128, 13, 10]))) && text(tree).includes(hash('Version: 1.56')));
  };
  const submit = () => (find('form').props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  const click = (label: string) => {
    const button = find('button', (props) => text(props.children) === label);
    (button.props.onClick as () => void)();
  };
  const publishDisabled = () => find('button', (props) => props.type === 'submit').props.disabled;
  render();
  for (const effect of effects) effect();
  return { api: testModule.exports, render, find, settle, select, submit, click, publishDisabled,
    requests, confirmations, messages, content: () => text(render()) };
}

test('UI file validation keeps exact binary/version boundaries and requires both completed hashes', async () => {
  const view = ui();
  const validate = view.api.validateFirmwareFileSelection;
  for (const kind of ['c23', 'ver'] as const) {
    const max = contract.FIRMWARE_FILES[kind].maxBytes;
    assert.equal(validate({ name: `firmware.${kind.toUpperCase()}`, size: max }, kind), null);
    assert.ok(validate({ name: `firmware.${kind}`, size: max + 1 }, kind));
    assert.ok(validate({ name: `firmware.${kind}`, size: 0 }, kind));
    assert.ok(validate({ name: `firmware.${kind}.exe`, size: 1 }, kind));
  }
  const pair: Pair = { c23: { file: c23, sha256: 'a'.repeat(64), error: null }, ver: null };
  assert.equal(view.api.firmwarePairReady(pair), false);
  assert.throws(() => view.api.firmwarePublishForm(pair, overview.revision));
  pair.ver = { file: ver, sha256: null, error: null };
  assert.equal(view.api.firmwarePairReady(pair), false);
  pair.ver.sha256 = 'b'.repeat(64);
  assert.equal(view.api.firmwarePairReady(pair), true);
  const form = view.api.firmwarePublishForm(pair, overview.revision);
  assert.deepEqual([...form.keys()].sort(), ['action', 'c23', 'c23Sha256', 'expectedRevision', 'ver', 'verSha256'].sort());
  assert.equal(form.get('expectedRevision'), overview.revision);
  assert.equal(form.get('action'), 'publish');
  await view.settle();
});

test('UI hashes original binary bytes, confirms one pair and prevents duplicate submit while publishing', async () => {
  let finish!: (response: Response) => void;
  const view = ui({ post: () => new Promise((resolve) => { finish = resolve; }) });
  await view.settle();
  assert.equal(view.publishDisabled(), true);
  await view.select();
  assert.equal(view.requests.filter((request) => request.method === 'POST').length, 0);
  assert.equal(view.publishDisabled(), false);
  view.submit(); view.submit();
  assert.equal(view.requests.filter((request) => request.method === 'POST').length, 1);
  assert.equal(view.publishDisabled(), true);
  assert.equal(view.find('input').props.disabled, true);
  assert.match(view.confirmations[0], /new\.c23.*\nSHA256:/);
  const form = view.requests.find((request) => request.method === 'POST')!.body as FormData;
  assert.equal(form.get('c23Sha256'), hash(new Uint8Array([0, 255, 128, 13, 10])));
  finish(Response.json(updated));
  await view.settle(() => view.messages.length === 1);
  assert.equal(view.messages[0], 'Пара файлов прошивки опубликована');
  assert.doesNotMatch(view.content(), /new\.c23|new\.ver/);
});

test('UI cancelled confirmation never publishes or clears the selected pair', async () => {
  const view = ui({ confirm: false });
  await view.settle(); await view.select(); view.submit();
  assert.equal(view.requests.filter((request) => request.method === 'POST').length, 0);
  assert.equal(view.publishDisabled(), false);
  assert.match(view.content(), /new\.c23/);
});

test('UI network uncertainty releases busy, preserves files and requires GET before another POST', async () => {
  const view = ui({ post: async () => { throw new Error('Synthetic network failure'); }, get: async () => Response.json(updated) });
  await view.settle(); await view.select(); view.submit();
  await view.settle(() => view.content().includes('Не удалось подтвердить результат'));
  assert.equal(view.find('input').props.disabled, false);
  assert.equal(view.publishDisabled(), true);
  assert.match(view.content(), /new\.c23/);
  view.submit();
  assert.equal(view.requests.filter((request) => request.method === 'POST').length, 1);
  view.click('Обновить состояние');
  await view.settle(() => view.publishDisabled() === false);
  assert.match(view.content(), /new\.ver/);
});

test('UI 409 refreshes revision, retains files and requires a new explicit confirmation', async () => {
  const view = ui({ post: async () => Response.json({ error: 'Конфликт ревизии' }, { status: 409 }), get: async () => Response.json(updated) });
  await view.settle(); await view.select(); view.submit();
  await view.settle(() => view.content().includes('Выбранные файлы сохранены'));
  assert.equal(view.requests.filter((request) => request.method === 'POST').length, 1);
  assert.equal(view.publishDisabled(), false);
  assert.match(view.content(), /new\.c23/);
  view.submit();
  const forms = view.requests.filter((request) => request.method === 'POST').map((request) => request.body as FormData);
  assert.equal(forms[1].get('expectedRevision'), updated.revision);
  assert.equal(view.confirmations.length, 2);
  await view.settle();
});

test('UI rollback confirms and sends both selected previous ID and expected revision', async () => {
  const view = ui();
  await view.settle();
  view.click('Восстановить предыдущую пару');
  await view.settle(() => view.messages.length === 1);
  assert.deepEqual(JSON.parse(view.requests.find((request) => request.method === 'POST')!.body as string), {
    action: 'rollback', expectedRevision: overview.revision, previousId: overview.previous!.id,
  });
  assert.match(view.confirmations[0], /1\.54/);
  assert.equal(view.messages[0], 'Предыдущая пара прошивки восстановлена');
});

test('UI malformed success response is not treated as confirmed publication', async () => {
  const view = ui({ post: async () => Response.json({ ok: true }) });
  await view.settle(); await view.select(); view.submit();
  await view.settle(() => view.content().includes('Не удалось подтвердить результат'));
  assert.equal(view.messages.length, 0);
  assert.equal(view.publishDisabled(), true);
  assert.match(view.content(), /new\.c23/);
});
