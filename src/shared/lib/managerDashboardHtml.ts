import { createHash } from 'node:crypto';
import type { PersonalDashboardAudience } from './managerDashboardAudience';

import { buildTopDashboardContentSecurityPolicy, buildTopDashboardFrameSecurityPolicy, getTopDashboardDataAdapterScript } from './topDashboardContentSecurity';
import { TOP_DASHBOARD_DOWNLOAD_MESSAGE_MARKER, TOP_DASHBOARD_DOWNLOAD_MAX_BYTES, TOP_DASHBOARD_DOWNLOAD_MAX_NAME_LENGTH, TOP_DASHBOARD_DOWNLOAD_NAME_PATTERN_SOURCE, TOP_DASHBOARD_DOWNLOAD_INVALID_NAME_PATTERN_SOURCE } from './topDashboardDownloadBridge';

const MARKER = 'kts-personal-dashboard-v1';

const EMPTY_STATE_MESSAGES = {
  missing_email: 'HTML дашборда доступен. Для автоматической привязки личного снимка администратору нужно указать email в вашей карточке.',
  ambiguous_email: 'HTML дашборда доступен. Этот email указан у нескольких менеджеров; администратору нужно уточнить привязку личных снимков.',
  no_snapshot: 'HTML дашборда доступен. Личный снимок ещё не загружен; данные появятся после его получения.',
  expired: 'HTML дашборда доступен. Срок действия выбранного снимка истёк; нужен актуальный личный снимок.',
} as const;

export type PersonalDashboardEmptyState = keyof typeof EMPTY_STATE_MESSAGES;

type DashboardScope = 'personal' | 'support_shared';
const SHARED_EMPTY_STATE_MESSAGES = {
  ...EMPTY_STATE_MESSAGES,
  no_snapshot: 'Общий HTML опубликован. Администратор ещё не загрузил общий снимок сопровождения.',
  expired: 'Срок действия общего снимка истёк. Администратору нужно загрузить актуальный файл.',
};

// v12 renders these handlers from template expressions, so hashing only the
// uploaded source cannot authorize their concrete runtime text. Keep this list
// finite: no arbitrary handler text, eval, or changes to the supplied calculations.
const PERSONAL_V12_RENDERED_HANDLERS = [
  ...['summary', 'yoy', 'clients', 'goods', 'kp', 'lost', 'disc'].map((tab) => `U.tab='${tab}';render()`),
  ...['tm', 'vid', 'grp', 'nom', 'cg'].map((dimension) => `U.goodsDim='${dimension}';render()`),
  ...['mk', 'partner', 'grp', 'vid', 'tm', 'cg'].map((dimension) => `U.kpDim='${dimension}';render()`),
  "U.years=[D.years[D.years.length-1]];U.qs=[];U.ms=[];Object.keys(U.gf).forEach(k=>U.gf[k]=[]);U.s='';render()",
  'GOODS_KEYS.forEach(k=>U.gf[k]=[]);render()',
] as const;

// This is a versioned integration contract, not a trust/safety test for scripts.
// All uploaded scripts still execute only inside the opaque-origin sandbox.
export function isPersonalDashboardHtml(html: string) {
  return html.length > 0 && /<html[\s>]/i.test(html)
    && /kts-personal/.test(html)
    && /\bfunction\s+gate\s*\(/.test(html)
    && /\bfunction\s+tryOpen\s*\(/.test(html)
    && /\bfunction\s+decryptFile\s*\(/.test(html)
    && /\b(?:let|var)\s+FILE\s*=/.test(html)
    && /\b(?:id\s*=\s*["']fileInp["']|["']#fileInp["'])/.test(html)
    && /\bemailHash\b/.test(html);
}

export function getPersonalDashboardAdapterScript(scope: DashboardScope = 'personal') {
  const shared = scope === 'support_shared';
  return `(() => {
  'use strict';
  const marker = '${MARKER}';
  const emptyMessages = ${JSON.stringify(shared ? SHARED_EMPTY_STATE_MESSAGES : EMPTY_STATE_MESSAGES)};
  let binding = null;
  let emptyReason = null;
  let loaded = false;
  let unlocked = false;
  const normalize = (email) => String(email || '').trim().toLowerCase();
  function updateGate() {
    if (!binding && !emptyReason) return;
    const email = document.getElementById('email');
    if (email) { email.value = binding ? binding.email : ''; email.readOnly = true; email.disabled = !!emptyReason; email.autocomplete = 'off'; }
    const pass = document.getElementById('pass');
    if (pass) { pass.autocomplete = 'off'; pass.placeholder = ${JSON.stringify(shared ? 'Пароль общего снимка (не от почты)' : 'Пароль личного снимка (не от почты)')}; pass.disabled = !!emptyReason; if (emptyReason) pass.value = ''; }
    const input = document.getElementById('fileInp');
    if (input) input.disabled = true;
    const drop = document.getElementById('drop');
    if (drop) { drop.onclick = null; drop.ondrop = (event) => event.preventDefault(); drop.ondragover = (event) => event.preventDefault(); }
    const note = document.querySelector('.gate .note');
    if (note) note.textContent = emptyReason ? emptyMessages[emptyReason] : ${JSON.stringify(shared ? 'Это общий снимок для всех менеджеров по сопровождению. Email выпуска уже подставлен. Введите пароль общего снимка; он не отправляется на сервер и не сохраняется в браузере.' : 'Снимок получен для вашего кабинета автоматически. Введите пароль снимка; пароль не отправляется на сервер и не сохраняется в браузере.')};
    const intro = document.querySelector('.gate .p');
    if (intro) intro.textContent = emptyReason ? ${JSON.stringify(shared ? 'Для общего отчёта нужен действующий общий снимок сопровождения.' : 'Общая версия дашборда опубликована. Для отображения личных показателей нужен ваш действующий снимок.')} : ${JSON.stringify(shared ? 'Общий снимок хранится на сервере в зашифрованном виде. Расшифровка выполняется здесь, в браузере.' : 'Личный снимок хранится на сервере в зашифрованном виде. Расшифровка выполняется здесь, в браузере.')};
    const button = document.getElementById('go');
    if (button && (!binding || !binding.bytes)) button.disabled = true;
  }
  const originalGate = gate;
  gate = function(message) { originalGate(message); updateGate(); };
  // Only the loading/decryption boundary changes. unpack(), render(), all KPI
  // calculations, filters and exports are left exactly as supplied in the HTML.
  decryptFile = async function(text, email, password) {
    if (!binding || !binding.bytes || normalize(email) !== binding.email) throw new Error('Снимок недоступен для этой учётной записи.');
    const f = JSON.parse(text);
    const encode = new TextEncoder();
    const em = binding.email;
    const hash = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', encode.encode(em)))));
    if (f.fmt !== 'kts-personal' || f.v !== 1 || f.emailHash !== hash) throw new Error('Снимок выпущен для другого email.');
    if (f.kdf.name !== 'PBKDF2' || f.kdf.hash !== 'SHA-256' || !Number.isInteger(f.kdf.iter) || f.kdf.iter < 200000 || f.kdf.iter > 600000) throw new Error('Неподдерживаемые параметры снимка.');
    const from64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const base = await crypto.subtle.importKey('raw', encode.encode(em + ':' + password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({name:'PBKDF2',salt:from64(f.kdf.salt),iterations:f.kdf.iter,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['decrypt']);
    let raw;
    try { raw = new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:from64(f.iv)},key,from64(f.ct))); }
    catch { throw new Error('Пароль снимка не подходит или файл повреждён.'); }
    if (f.gz) {
      if (typeof DecompressionStream !== 'function') throw new Error('Для снимка нужен современный браузер с поддержкой gzip.');
      const reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
      const chunks = []; let size = 0;
      try {
        while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 128 * 1024 * 1024) throw new Error('Распакованный снимок больше 128 МиБ.'); chunks.push(part.value); }
      } catch (e) { await reader.cancel().catch(() => {}); throw e; } finally { reader.releaseLock(); }
      raw = new Uint8Array(size); let at = 0; for (const chunk of chunks) { raw.set(chunk, at); at += chunk.length; }
    }
    if (raw.length > 128 * 1024 * 1024) throw new Error('Распакованный снимок больше 128 МиБ.');
    const p = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(raw));
    if (normalize(p.email) !== em || p.issued !== f.issued || p.expires !== f.expires) throw new Error('Получатель или даты внутри снимка не совпадают с его заголовком.');
    const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    if (p.expires < today) throw new Error('Срок действия снимка истёк ' + p.expires + '.');
    if (!Array.isArray(p.cols) || !p.cols.length || p.cols.length > 128 || new Set(p.cols).size !== p.cols.length || p.cols.some((x) => typeof x !== 'string' || ['__proto__','prototype','constructor'].includes(x)) || !Array.isArray(p.rows) || p.rows.length > 500000 || p.rows.some((row) => !Array.isArray(row) || row.length > p.cols.length)) throw new Error('Некорректная структура данных снимка.');
    unlocked = true;
    return p;
  };
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || !event.data || event.data.marker !== marker) return;
    const data = event.data;
    if (loaded) return;
    if (data.type === 'empty' && typeof data.reason === 'string' && Object.prototype.hasOwnProperty.call(emptyMessages, data.reason)) {
      loaded = true;
      emptyReason = data.reason;
      binding = null;
      FILE = null;
      if (typeof D !== 'undefined') D = null;
      gate();
      return;
    }
    if (data.type !== 'snapshot' || typeof data.email !== 'string' || typeof data.originalName !== 'string' || !(data.bytes instanceof ArrayBuffer) || data.bytes.byteLength > 8 * 1024 * 1024) return;
    loaded = true;
    binding = {email:normalize(data.email),bytes:data.bytes};
    FILE = new File([data.bytes], data.originalName, {type:'application/json'});
    gate();
  });
  window.addEventListener('pagehide', () => { binding = null; FILE = null; if (typeof D !== 'undefined') D = null; });
  // No plaintext/password is posted to the outer frame or persisted anywhere.
  window.parent.postMessage({marker, type:'ready'}, '*');
  const originalOpen = tryOpen;
  tryOpen = async function() { try { await originalOpen(); } finally { if (unlocked) { const input = document.getElementById('pass'); if (input) input.value = ''; } } };
  const go = document.getElementById('go');
  if (go) go.disabled = true;
})();`;
}

export function injectPersonalDashboardAdapter(html: string, scope: DashboardScope = 'personal') {
  if (!isPersonalDashboardHtml(html)) throw new Error('HTML не поддерживает контракт личного снимка kts-personal v1');
  const script = `<script data-kts-personal-download-adapter="1">${getTopDashboardDataAdapterScript(null, null, true)}</script><script data-kts-personal-adapter="1">${getPersonalDashboardAdapterScript(scope)}</script>`;
  const index = html.toLowerCase().lastIndexOf('</body>');
  return index >= 0 ? html.slice(0, index) + script + html.slice(index) : html + script;
}

export function personalHtmlCsp(html: string) {
  const renderedHashes = PERSONAL_V12_RENDERED_HANDLERS.map((handler) => `'sha256-${createHash('sha256').update(handler).digest('base64')}'`);
  return buildTopDashboardContentSecurityPolicy(html).split('; ').map((directive) => {
    if (directive.startsWith('sandbox ')) return 'sandbox allow-scripts';
    if (!directive.startsWith('script-src ')) return directive;
    const sources = new Set(directive.slice('script-src '.length).split(' '));
    sources.delete("'none'");
    sources.add("'unsafe-hashes'");
    for (const hash of renderedHashes) sources.add(hash);
    return `script-src ${Array.from(sources).join(' ')}`;
  }).join('; ');
}

type DashboardFrameInput = { versionId: number; snapshotId?: number; preview: boolean; audience?: PersonalDashboardAudience; emptyState?: PersonalDashboardEmptyState };

export function buildPersonalDashboardFrame(input: DashboardFrameInput) {
  return buildDashboardFrame(input, 'personal');
}

export function buildSupportSharedDashboardFrame(input: Omit<DashboardFrameInput, 'audience' | 'emptyState'> & {emptyState?: 'no_snapshot' | 'expired'}) {
  return buildDashboardFrame(input, 'support_shared');
}

function buildDashboardFrame(input: DashboardFrameInput, scope: DashboardScope) {
  const shared = scope === 'support_shared';
  const title = shared ? 'Общий дашборд сопровождения' : 'Личный дашборд продаж';
  const query = new URLSearchParams({version: String(input.versionId)});
  if (!shared) query.set('audience', input.audience ?? 'development');
  if (input.preview) query.set('preview', '1');
  const base = shared ? '/api/admin/manager-dashboard/shared/' : '/api/admin/manager-dashboard/';
  const contentPath = base + 'content?' + query.toString();
  const dataPath = base + 'snapshots' + (input.snapshotId ? '?snapshot=' + input.snapshotId : '');
  const script = `(() => {
    'use strict';
    const frame = document.getElementById('personal');
    const status = document.getElementById('status');
    const preview = ${input.preview};
    const emptyState = ${JSON.stringify(input.emptyState ?? null)};
    let snapshot = null;
    let ready = false;
    let sent = false;
    function deliver() {
      if (!ready || sent || !frame.contentWindow) return;
      if (!preview && emptyState) {
        sent = true;
        frame.contentWindow.postMessage({marker:'${MARKER}',type:'empty',reason:emptyState}, '*');
        return;
      }
      if (!snapshot) return;
      sent = true;
      frame.contentWindow.postMessage({marker:'${MARKER}',type:'snapshot',bytes:snapshot.bytes,email:snapshot.email,originalName:snapshot.originalName}, '*', [snapshot.bytes]);
      snapshot = null;
      status.hidden = true;
    }
    window.addEventListener('message', (event) => {
      if (event.source !== frame.contentWindow || event.origin !== 'null' || !event.data) return;
      if (event.data.marker === '${MARKER}' && event.data.type === 'ready') { ready = true; deliver(); }
      const d = event.data;
      if (d.marker === '${TOP_DASHBOARD_DOWNLOAD_MESSAGE_MARKER}' && d.type === 'download-request'
        && typeof d.name === 'string' && d.name.length > 0 && d.name.length <= ${TOP_DASHBOARD_DOWNLOAD_MAX_NAME_LENGTH}
        && new RegExp(${JSON.stringify(TOP_DASHBOARD_DOWNLOAD_NAME_PATTERN_SOURCE)}, 'i').test(d.name)
        && !new RegExp(${JSON.stringify(TOP_DASHBOARD_DOWNLOAD_INVALID_NAME_PATTERN_SOURCE)}).test(d.name)
        && d.blob instanceof Blob && d.blob.size > 0 && d.blob.size <= ${TOP_DASHBOARD_DOWNLOAD_MAX_BYTES}
        && navigator.userActivation && navigator.userActivation.isActive) {
        window.parent.postMessage({marker:d.marker,type:'download-request',name:d.name,blob:d.blob}, window.location.origin);
      }
    });
    if (preview) status.textContent = ${JSON.stringify(shared ? 'Предпросмотр общего HTML. Снимки и данные сюда не передаются.' : 'Предпросмотр HTML. Личные данные менеджеров сюда не передаются.')};
    else if (emptyState) status.textContent = ${JSON.stringify(input.emptyState ? (shared ? SHARED_EMPTY_STATE_MESSAGES : EMPTY_STATE_MESSAGES)[input.emptyState] : '')};
    else {
      fetch(${JSON.stringify(dataPath)}, {credentials:'same-origin',cache:'no-store'}).then(async (res) => {
        if (!res.ok) throw new Error('Снимок недоступен. Обновите кабинет или обратитесь к администратору.');
        const email = res.headers.get('x-personal-email');
        const name = res.headers.get('x-personal-filename');
        const bytes = await res.arrayBuffer();
        if (!email || !name || bytes.byteLength > 8 * 1024 * 1024) throw new Error('Некорректный снимок.');
        snapshot = {email:decodeURIComponent(email),originalName:decodeURIComponent(name),bytes}; deliver();
      }).catch((error) => {status.textContent = error.message;});
    }
  })();`;
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title><style>html,body{margin:0;height:100%;font-family:Arial,sans-serif}#status{padding:12px;background:#f5f3ff;color:#271078}iframe{border:0;width:100%;height:100%;display:block}</style></head><body><div id="status">${shared ? 'Загрузка общего снимка…' : 'Загрузка личного снимка…'}</div><iframe id="personal" title="${title}" sandbox="allow-scripts" referrerpolicy="same-origin" src="${contentPath.replace(/&/g, '&amp;')}"></iframe><script>${script}</script></body></html>`;
  return { html, csp: buildTopDashboardFrameSecurityPolicy(script) };
}
