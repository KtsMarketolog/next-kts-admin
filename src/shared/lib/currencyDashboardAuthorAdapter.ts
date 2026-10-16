import { readFileSync } from 'node:fs';
import path from 'node:path';
// Next ships its reviewed JavaScript parser without public TypeScript declarations.
// @ts-expect-error The bundled Acorn parser has no .d.ts entrypoint.
import { parse } from 'next/dist/compiled/acorn';
import { isCurrencyManualSnapshotKey } from './currencyDashboardModel';

type Node = { type: string; start: number; end: number; [key: string]: unknown };
type Parsed = { code: string; body: Node[]; named: Map<string, Node> };
type Edit = { start: number; end: number; text: string };

export class CurrencyAuthorCompatibilityError extends Error {
  readonly code = 'CURRENCY_HTML_INCOMPATIBLE';
  constructor(detail: string) { super(`HTML курсов пока несовместим с серверным подключением: ${detail}`); this.name = 'CurrencyAuthorCompatibilityError'; }
}

function fail(message: string): never { throw new CurrencyAuthorCompatibilityError(message); }
function node(value: unknown): value is Node { return !!value && typeof value === 'object' && typeof (value as Node).type === 'string'; }
function walk(value: unknown, visit: (entry: Node) => void): void {
  if (Array.isArray(value)) { value.forEach((item) => walk(item, visit)); return; }
  if (!node(value)) return;
  visit(value);
  Object.values(value).forEach((child) => { if (typeof child === 'object') walk(child, visit); });
}
function parsed(code: string): Parsed {
  let body: Node[];
  try { body = parse(code, { ecmaVersion: 'latest', sourceType: 'script' }).body as Node[]; }
  catch { fail('ошибка синтаксиса JavaScript'); }
  const named = new Map<string, Node>();
  for (const statement of body!) {
    const ids = statement.type === 'FunctionDeclaration' ? [statement.id] : statement.type === 'VariableDeclaration'
      ? (statement.declarations as Node[]).map((declaration) => declaration.id) : [];
    for (const id of ids) {
      if (node(id) && id.type === 'Identifier' && typeof id.name === 'string') {
        if (named.has(id.name)) fail(`повторное объявление ${id.name}`);
        named.set(id.name, statement);
      }
    }
  }
  return { code, body: body!, named };
}
function source(script: Parsed, name: string) {
  const entry = script.named.get(name);
  if (!entry) fail(`не найдено подключение ${name}`);
  return script.code.slice(entry.start, entry.end);
}
function requiredRange(script: Parsed, first: string, last: string): Edit {
  const a = script.named.get(first), b = script.named.get(last);
  if (!a || !b || b.start <= a.start) fail(`не найдены границы ${first} / ${last}`);
  return { start: a!.start, end: b!.start, text: '' };
}
function applyEdits(code: string, edits: Edit[]) {
  const sorted = edits.sort((a, b) => b.start - a.start);
  let previous = code.length;
  for (const edit of sorted) {
    if (edit.end > previous) fail('пересекающиеся точки подключения');
    code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
    previous = edit.start;
  }
  return code;
}
function idsIn(statement: Node): Set<string> {
  const ids = new Set<string>();
  walk(statement, (entry) => {
    if (entry.type === 'CallExpression' && node(entry.callee) && entry.callee.type === 'MemberExpression' &&
      node(entry.callee.property) && entry.callee.property.name === 'getElementById') {
      const arg = (entry.arguments as Node[])[0];
      if (arg?.type === 'Literal' && typeof arg.value === 'string') ids.add(arg.value);
    }
  });
  return ids;
}
function hasIdentifier(statement: Node, name: string) {
  let found = false;
  walk(statement, (entry) => { if (entry.type === 'Identifier' && entry.name === name) found = true; });
  return found;
}
function inlineScript(html: string, author: boolean) {
  if (author && /__KTS_CURRENCY_BOOTSTRAP__|\bKTS_CURRENCY_BOOTSTRAP\b/.test(html)) fail('вместо исходного авторского файла загружена серверная обёртка');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  const inline: RegExpMatchArray[] = [];
  const removed: Edit[] = [];
  for (const match of scripts) {
    const src = match[1].match(/\bsrc\s*=\s*(["'])(.*?)\1/i);
    if (src) {
      if (!author || !/^(?:\.\/)?(?:copper_data|kts_snapshot)\.js$/.test(src[2])) fail('внешние JavaScript-зависимости требуют отдельного подключения');
      removed.push({ start: match.index!, end: match.index! + match[0].length, text: '' });
    } else {
      if (/\bsrc\s*=|\btype\s*=\s*["']module/i.test(match[1])) fail('неподдерживаемый тип скрипта');
      if (match[2].trim()) inline.push(match);
    }
  }
  if (inline.length !== 1) fail('ожидается один встроенный авторский JavaScript');
  const match = inline[0];
  return { match, removed, parsed: parsed(match[2]) };
}

const REQUIRED_FUNCTIONS = [
  'loadToday', 'loadHistory', 'loadMoex', 'loadWorld', 'loadFutures', 'loadCopper', 'loadCandles',
  'getJSON', 'cuData', 'makeSnapshot', 'renderAll', 'renderCps', 'renderAn', 'renderCu', 'renderLog',
  'renderTiles', 'renderChart', 'renderSum', 'renderWeek', 'showTab', 'checkCbrChange',
  'checkMoexChange', 'checkFutChange', 'setStatus', 'forecast', 'holt',
];
const REQUIRED_IDS = ['cpsForm', 'anForm', 'cuForm', 'tSnap', 'tOpen', 'snapFile', 'snapHint', 'errBox', 'clock', 'pgSum', 'pgWeek'];

export function inspectCurrencyAuthorHtml(rawHtml: string): { sourceVersion: string } {
  if (typeof rawHtml !== 'string' || Buffer.byteLength(rawHtml) > 16 * 1024 * 1024 || !/<html\b/i.test(rawHtml)) fail('ожидается HTML-файл до 16 МБ');
  const title = rawHtml.match(/<title\b[^>]*>([^<]+)<\/title>/i)?.[1] ?? '';
  const version = title.match(/\bV([1-9]\d{0,3})\b/i);
  if (!/Курсы валют/i.test(title) || !version) fail('не удалось определить дашборд курсов и номер версии в заголовке');
  const document = inlineScript(rawHtml, true);
  for (const name of REQUIRED_FUNCTIONS) if (document.parsed.named.get(name)?.type !== 'FunctionDeclaration') fail(`нет функции ${name}`);
  for (const name of ['store', 'MANUAL_KEYS', 'CODES', 'state', 'prefs', 'tabs']) if (!document.parsed.named.has(name)) fail(`нет данных ${name}`);
  for (const id of REQUIRED_IDS) {
    const matches = [...rawHtml.matchAll(new RegExp(`\\bid\\s*=\\s*["']${id}["']`, 'g'))];
    if (matches.length !== 1) fail(`элемент ${id} отсутствует или повторяется`);
  }
  const markup = rawHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  if (/<(?:iframe|object|embed|base)\b/i.test(markup) || /<[a-z][^>]*\son[a-z]+\s*=/i.test(markup) ||
    /<(?:link|img|video|audio|source)\b[^>]*\b(?:src|href)\s*=\s*["'](?:https?:|\/\/)/i.test(markup) || /@import\b|url\(\s*["']?https?:/i.test(markup)) {
    fail('обнаружены внешние ресурсы или встроенные обработчики, которые не работают в защищённом просмотре');
  }
  return { sourceVersion: `V${version[1]}` };
}

let trustedDocument: { html: string; script: Parsed } | undefined;
function trusted() {
  if (!trustedDocument) {
    const html = readFileSync(path.join(process.cwd(), 'assets/currency-dashboard/kursy_valyut_v21.html'), 'utf8');
    trustedDocument = { html, script: inlineScript(html, false).parsed };
  }
  return trustedDocument;
}

/** Adapt data/permission boundaries, never execute an uploaded script on the server. */
export function adaptCurrencyAuthorHtml(rawHtml: string, sourceVersion: string): string {
  const info = inspectCurrencyAuthorHtml(rawHtml);
  if (sourceVersion !== info.sourceVersion) fail('версия файла изменилась после проверки');
  const document = inlineScript(rawHtml, true), author = document.parsed, legacy = trusted().script;
  const edits: Edit[] = [];
  const replace = (name: string, text: string, optional = false) => {
    const entry = author.named.get(name);
    if (!entry) { if (optional) return; fail(`не найдена функция ${name}`); }
    edits.push({ start: entry!.start, end: entry!.end, text });
  };
  const replaceLegacy = (name: string, optional = false) => replace(name, source(legacy, name), optional);
  const within = (entry: Node) => edits.some((edit) => entry.start >= edit.start && entry.end <= edit.end);
  const addRange = (first: string, last: string, text: string) => {
    const range = requiredRange(author, first, last); edits.push({ ...range, text });
  };
  const common = (first: string, last: string) => { const range = requiredRange(legacy, first, last); return legacy.code.slice(range.start, range.end); };

  const manualKeys = new Set(['kts_cpsRates', 'kts_an', 'kts_cu', 'kts_log']);
  for (const entry of author.body) if (entry === author.named.get('MANUAL_KEYS') || (entry.type === 'ExpressionStatement' && hasIdentifier(entry, 'MANUAL_KEYS'))) {
    walk(entry, (item) => { if (item.type === 'Literal' && typeof item.value === 'string' && isCurrencyManualSnapshotKey(item.value)) manualKeys.add(item.value); });
  }
  for (const key of ['kts_weights', 'kts_f27']) if (rawHtml.includes(key)) manualKeys.add(key);
  let storePrelude = common('MANUAL_KEYS', 'cls').replace(source(legacy, 'MANUAL_KEYS'), `const MANUAL_KEYS=${JSON.stringify([...manualKeys])};`);
  storePrelude = storePrelude.replace("'cbr-history':'ЦБ: история'", "'cbr-history':'ЦБ: история','cbr-base-history':'ЦБ: архив с 2022 года'");
  replace('MANUAL_KEYS', storePrelude);
  replace('store', '');
  replaceLegacy('iso');
  for (const name of ['getJSON', 'loadToday', 'loadHistory', 'loadMoex', 'loadWorld', 'loadFutures', 'baseOf', 'liveBlock',
    'loadCopper', 'refreshCopper', 'cuData', 'loadCandles', 'weekDays', 'refreshFutures', 'refreshCbr', 'refreshMoex', 'refreshWorld', 'setStatus', 'dl']) replaceLegacy(name);
  for (const name of ['CBR_URL', 'ARCH', 'saveHist', 'fetchArch', 'PROXIES', 'getText', 'parseWestmetall', 'setBaseline']) replace(name, '', true);

  // Reviewed opt-in audio and notification bridge; preserve author's overlay rendering.
  let audio = common('prefs', 'checkCbrChange');
  for (const name of ['showStrip', 'showBig', 'applyMini']) audio = audio.replace(source(legacy, name), source(author, name));
  addRange('prefs', 'checkCbrChange', audio);
  let checkCbr = source(author, 'checkCbrChange');
  const checkNode = parsed(checkCbr).body[0];
  const body = (checkNode.body as Node).body as Node[];
  checkCbr = applyEdits(checkCbr, body.filter((entry) => hasIdentifier(entry, 'gsPush') || hasIdentifier(entry, 'gsCfg')).map((entry) => ({ start: entry.start, end: entry.end, text: '' })));
  replace('checkCbrChange', checkCbr.replace('{', "{\nif(sourceStates['cbr-daily']?.stale)return;").replace('if(seen.cbrDate===T.Date)return;', 'if(T.Date.slice(0,10)<=seen.cbrDate.slice(0,10))return;'));
  replace('checkMoexChange', source(author, 'checkMoexChange').replace('{', "{\nif(sourceStates['moex-currency']?.stale)return;"));
  replaceLegacy('checkFutChange');

  // Preserve render/formula bodies. Protect only draft input values from periodic refreshes.
  const wrappers: string[] = [];
  for (const [name, form] of [['renderCps', 'cpsForm'], ['renderAn', 'anForm'], ['renderCu', 'cuForm'], ['renderBase', 'wForm'], ['renderF27', 'f27Form']]) {
    if (!author.named.has(name)) continue;
    let renamed = source(author, name).replace(new RegExp(`function\\s+${name}\\b`), `function author_${name}`);
    if (name === 'renderAn') renamed = renamed.replace('r.split("|").map(x=>x.trim())', 'r.split("|").map(x=>escapeHtml(x.trim()))');
    if (name === 'renderF27') renamed = renamed.replaceAll('${r.src}', '${escapeHtml(r.src)}').replaceAll('${r.dt}', '${escapeHtml(r.dt)}');
    replace(name, renamed);
    wrappers.push(`function ${name}(){return preserveAuthorDraft(${JSON.stringify(form)},()=>{${name === 'renderBase' ? "if(!dirtyForms.has('wForm')){const t=document.getElementById('wTable');if(t)t.dataset.force='1';}" : ''}return author_${name}();});}`);
  }
  const calendarRows = source(legacy, 'sumRows').replace('function sumRows(){', "function serverCalendarRows(){const selectedMonth=sumMonth();");
  replace('sumRows', source(author, 'sumRows').replace('function sumRows()', 'function author_sumRows()'));
  wrappers.push(calendarRows, "function sumRows(){return sumMonth()>='2026-01'?serverCalendarRows():author_sumRows();}");
  // Week tables retain author markup but receive the server's immutable asset-specific baseline.
  for (const name of ['renderWeek', 'weekTable']) {
    replace(name, source(author, name).replace(/weekDays\(rows\)/g, 'weekDays(rows,k)').replace(/weekDays\(state\.candles\?\.\[k\]\|\|\[\]\)/g, 'weekDays(state.candles?.[k]||[],k)'));
  }
  const sharedRange = requiredRange(legacy, 'sharedEnvelope', 'tabs');
  let shared = legacy.code.slice(sharedRange.start, sharedRange.end);
  shared = shared.replace("['cpsForm','anForm','cuForm']", "['cpsForm','anForm','cuForm','wForm','f27Form']").replace("document.getElementById(id).addEventListener('input'", "document.getElementById(id)?.addEventListener('input'");
  shared = shared.replace(source(legacy, 'manualSnapshotData'), MANUAL_DATA);
  shared = shared.replace(source(legacy, 'makeSnapshot'), `function makeSnapshot(){const data={...sharedEnvelope.current?.data};MANUAL_KEYS.forEach(k=>{const v=k==='kts_log'?sharedEnvelope.current?.data?.kts_log:store.get(k);if(v!=null)data[k]=v;});return {at:new Date().toISOString(),version:${JSON.stringify(sourceVersion)},data:manualSnapshotData(data)};}`);
  shared = shared.replace("version:'V21'", 'version:current.version');
  shared = shared.replace("const forms={kts_cpsRates:'cpsForm',kts_an:'anForm',kts_cu:'cuForm'}", "const forms={kts_cpsRates:'cpsForm',kts_an:'anForm',kts_cu:'cuForm',kts_weights:'wForm',kts_f27:'f27Form'}");
  shared = shared.replace("#cuForm button,#tOpen", "#cuForm button,#wForm input,#wForm button,#f27Form textarea,#f27Form button,#tOpen");
  shared = shared.replace('renderAn();renderAll();renderLog();updateHistoryStatus();', 'renderAn();renderAll();renderLog();renderAuthorExtras();updateHistoryStatus();');
  // Install every retained safe extension, not only the keys known when this adapter was written.
  shared = shared.replace('MANUAL_KEYS.forEach(k=>{if(k===\'kts_log\')', "[...new Set([...MANUAL_KEYS,...Object.keys(data),...memoryStore.keys()].filter(isManualKey))].forEach(k=>{if(k==='kts_log')");
  const snapshotStart = author.named.get('SNAP_KEYS') ?? author.named.get('makeSnapshot');
  const tabsStart = author.named.get('tabs');
  if (!snapshotStart || !tabsStart) fail('не найдены границы сохранения снимков');
  // The independent month-range initializer belongs to the author's new visual section.
  const rangeInitializers = author.body.filter((entry) => entry.start >= snapshotStart!.start && entry.end <= tabsStart!.start && entry.type === 'ExpressionStatement' && idsIn(entry).has('baseFrom'));
  edits.push({ start: snapshotStart!.start, end: tabsStart!.start, text: shared + '\n' + rangeInitializers.map((entry) => author.code.slice(entry.start, entry.end)).join('\n') });

  const init = author.body.find((entry) => entry.type === 'ExpressionStatement' && hasIdentifier(entry, 'init'));
  if (!init) fail('не найдена инициализация отчёта');
  const schedulerStart = legacy.named.get('runningJobs')!;
  let scheduler = legacy.code.slice(schedulerStart.start);
  scheduler = scheduler.replace('renderAll();void runJob(refreshCandles);refreshMonthHistory();', 'renderAll();renderAuthorExtras();void runJob(refreshCandles);refreshMonthHistory();');
  edits.push({ start: init!.start, end: init!.end, text: scheduler });

  const formIds = new Set(['cpsForm', 'anForm', 'cuForm', 'wForm', 'f27Form']);
  const formKeys: Record<string, string> = { cpsForm: 'kts_cpsRates', anForm: 'kts_an', cuForm: 'kts_cu', wForm: 'kts_weights', f27Form: 'kts_f27' };
  const formFields: Record<string, string[]> = { cpsForm: ['eur', 'cny', 'usd', 'from', 'to'], anForm: ['rows'], cuForm: ['date', 'price', 'lmci', 'prem'], wForm: [], f27Form: ['rows'] };
  const adaptedForms = new Set<string>();
  for (const entry of author.body) {
    if (within(entry) || entry.type !== 'ExpressionStatement') continue;
    const ids = idsIn(entry);
    if ([...ids].some((id) => formIds.has(id)) && /addEventListener\(["']submit["']/.test(author.code.slice(entry.start, entry.end))) {
      const id = [...ids].find((value) => formIds.has(value))!;
      if (adaptedForms.has(id)) fail(`несколько обработчиков сохранения ${id}`);
      walk(entry, (call) => {
        if (call.type !== 'CallExpression' || !node(call.callee) || call.callee.type !== 'MemberExpression' || !node(call.callee.object) || call.callee.object.name !== 'store' || !node(call.callee.property) || (call.callee.property.name !== 'set' && call.callee.property.value !== 'set')) return;
        const key = (call.arguments as Node[])[0];
        if (key?.type !== 'Literal' || key.value !== formKeys[id]) fail(`изменился формат сохранения ${id}`);
      });
      adaptedForms.add(id);
      const reviewed = legacy.body.find((item) => item.type === 'ExpressionStatement' && idsIn(item).has(id) && /addEventListener\(["']submit["']/.test(legacy.code.slice(item.start, item.end)));
      edits.push({ start: entry.start, end: entry.end, text: reviewed ? legacy.code.slice(reviewed.start, reviewed.end) : NEW_FORM_HANDLERS[id] ?? fail(`не поддерживается сохранение ${id}`) });
    }
  }
  for (const match of rawHtml.matchAll(/<form\b[^>]*\bid\s*=\s*["']([^"']+)["']/gi)) {
    if (match[1] !== 'gsForm' && !adaptedForms.has(match[1])) fail(`сохранение формы ${match[1]} требует серверного подключения`);
  }
  for (const match of rawHtml.matchAll(/<form\b[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/form\s*>/gi)) {
    const fields = formFields[match[1]];
    if (!fields) continue;
    for (const control of match[2].matchAll(/<(?:input|textarea|select)\b[^>]*\bname\s*=\s*["']([^"']+)["']/gi)) {
      if (!fields.includes(control[1])) fail(`новое поле ${control[1]} формы ${match[1]} требует серверного подключения`);
    }
  }
  if (author.named.has('loadBaseHist')) replace('loadBaseHist', BASE_HISTORY);
  const helper = [DRAFT_HELPER, ...wrappers, source(legacy, 'manualCopper'), source(legacy, 'fetchCandles'), source(legacy, 'refreshBaselines'), MONTH_HISTORY.replace('month=selectedMonth', "month=typeof sumMonth==='function'?sumMonth():selectedMonth")].join('\n');
  const script = common('KTS_CURRENCY_BOOTSTRAP', 'CODES') + '\n' + applyEdits(author.code, edits) + '\n' + helper;
  const finalAst = parsed(script);
  for (const forbidden of ['localStorage', 'sessionStorage', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Worker', 'Notification', 'gsCfg', 'gsPush', 'gsPull', 'eval', 'Function']) {
    if (finalAst.body.some((entry) => hasIdentifier(entry, forbidden))) fail(`осталось неподдерживаемое обращение ${forbidden}`);
  }
  const temporaryKeys = new Set(['kts_seen', 'kts_prefs', 'kts_log', 'kts_moexHist', 'kts_baseHist']);
  for (const statement of finalAst.body) walk(statement, (entry) => {
    if (entry.type !== 'CallExpression' || !node(entry.callee) || entry.callee.type !== 'MemberExpression') return;
    const callee = entry.callee;
    if (!node(callee.object) || callee.object.name !== 'store' || !node(callee.property) ||
      (callee.property.name !== 'set' && callee.property.value !== 'set')) return;
    const key = (entry.arguments as Node[])[0];
    if (statement === finalAst.named.get('installEnvelope')) return;
    if (key?.type !== 'Literal' || typeof key.value !== 'string' || !temporaryKeys.has(key.value)) {
      fail(`ручное сохранение ${typeof key?.value === 'string' ? key.value : 'store.set'} не подключено к серверу`);
    }
  });
  const scriptStart = document.match.index! + document.match[0].indexOf('>') + 1;
  const htmlEdits = [...document.removed, { start: scriptStart, end: scriptStart + document.match[2].length, text: script }];
  let html = applyEdits(rawHtml, htmlEdits);
  html = html.replace(/<details>\s*<summary>Источник снимков<\/summary>[\s\S]*?<\/details>/i, '');
  const management = trusted().html.match(/<section class="card"[^>]*aria-label="Состояние источников">[\s\S]*?<\/section>/)?.[0];
  if (!management) fail('недоступен встроенный блок сохранения');
  html = html.replace(/<footer\b/i, `<p class="hint" id="readOnlyStatus" role="status" hidden>Только просмотр. Изменение общих данных недоступно.</p><p class="hint" id="deviceStatus" role="status" hidden></p>${management}\n<footer`);
  if (html.split('__KTS_CURRENCY_BOOTSTRAP__').length !== 2) fail('не удалось сформировать защищённый канал');
  return html;
}

const MANUAL_DATA = String.raw`
function isManualKey(key){return /^kts_[A-Za-z0-9_]{1,80}$/.test(key)&&!/^kts_(?:base(?:Hist)?|moexHist|cbrHist(?:_.*)?|prefs|seen|meta|gs|device.*|auth.*|session.*)$/i.test(key);}
function manualSnapshotData(source){const data={};Object.keys(source||{}).filter(isManualKey).forEach(k=>{if(source[k]!=null)data[k]=k==='kts_cu'?manualCopper(source[k]):source[k];});return data;}`;
const DRAFT_HELPER = String.raw`
function preserveAuthorDraft(id,render){const form=document.getElementById(id);const keep=form&&(dirtyForms.has(id)||form.contains(document.activeElement));const values=keep?[...form.querySelectorAll('input,textarea,select')].map(el=>({name:el.name,value:el.value,checked:el.checked})):null;const result=render();if(values){for(const draft of values){const input=[...form.querySelectorAll('input,textarea,select')].find(el=>el.name===draft.name);if(input){input.value=draft.value;if(typeof draft.checked==='boolean')input.checked=draft.checked;}}}setSharedBusy(savingShared);return result;}
function renderAuthorExtras(){if(typeof renderBase==='function')renderBase();if(typeof renderF27==='function')renderF27();if(typeof renderCorr==='function')renderCorr();}`;
const BASE_HISTORY = String.raw`
async function loadBaseHist(){state.baseLoading=true;try{const result=await getJSON('cbr-base-history');store.set('kts_baseHist',{data:result.data||{},miss:result.miss||[]});state.baseDone=Object.keys(result.data||{}).length;state.baseTotal=state.baseDone;state.baseErr=result._currencySource?.stale?1:0;}catch(error){state.baseErr=1;}finally{state.baseLoading=false;renderAuthorExtras();renderSum();}}`;
const NEW_FORM_HANDLERS: Record<string, string> = {
  wForm: String.raw`document.getElementById('wForm').addEventListener('submit',async e=>{e.preventDefault();try{requireManage();const f=e.target,d=wData();baseYears().forEach(y=>{BASE_CODES.forEach(c=>{d[y][c]=parseNumber(f[y+'_'+c].value,{optional:true,zero:true})??0;});d[y].rev=parseNumber(f[y+'_rev'].value,{optional:true,zero:true});});await saveSharedPatch({kts_weights:d},'Обновлена структура закупок по валютам для расчёта к 2022 году');document.getElementById('wTable').dataset.force='1';renderBase();window.__ktsDashboardUsage?.record('calculation_completed');}catch(error){showSaveError(error);}});`,
  f27Form: String.raw`document.getElementById('f27Form').addEventListener('submit',async e=>{e.preventDefault();try{requireManage();const rows=e.target.rows.value.split('\n').map(x=>x.trim()).filter(Boolean);await saveSharedPatch({kts_f27:{upd:ruDate(iso(new Date())),rows}},'Обновлён прогноз на 2027 год');e.target.closest('details').open=false;renderF27();}catch(error){showSaveError(error);}});`,
};
const MONTH_HISTORY = String.raw`
let monthRequest=0;
document.getElementById('sumMonth')?.addEventListener('change',()=>{void refreshMonthHistory();window.__ktsDashboardUsage?.record('calculation_completed');});
async function refreshMonthHistory(){const request=++monthRequest,month=selectedMonth,from=month+'-01';if(month<'2026-01')return;const [year,mon]=month.split('-').map(Number),last=iso(new Date(Date.UTC(year,mon,0,12))),till=last<iso(new Date())?last:iso(new Date());const history=store.get('kts_moexHist')||{},items=[{asset:'CNY',secid:'CNYRUB_TOM'}];for(const asset of ['COPPER','BR']){const ids=new Set(Object.entries(state.baselines||{}).filter(([date])=>date.startsWith(month+'-')).map(([,day])=>day[asset]?.secid).filter(Boolean));if(month===iso(new Date()).slice(0,7)&&state.fut?.[asset])ids.add(state.fut[asset].secid);for(const secid of ids)items.push({asset,secid});}let failed=false;for(const {asset,secid} of items){try{const rows=await fetchCandles(secid,from,till);for(const r of rows){const date=r.t.slice(0,10);if(!date.startsWith(month+'-'))continue;const pinned=state.baselines?.[date]?.[asset]?.secid;if(pinned&&pinned!==secid)continue;history[date]=history[date]||{};history[date][asset==='COPPER'?'CUF':asset]=r.c;}}catch(error){failed=true;}}const live=store.get('kts_moexHist')||{};Object.keys(live).forEach(date=>{if(date===iso(new Date()))history[date]={...history[date],...live[date]};});store.set('kts_moexHist',history);if(request===monthRequest){state.monthError=failed?'часть котировок недоступна; сохранены последние полученные значения':'';renderSum();}}`;
