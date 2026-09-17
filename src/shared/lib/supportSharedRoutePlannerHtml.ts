import { isPersonalDashboardHtml } from './managerDashboardHtml';
import { buildTopDashboardContentSecurityPolicy, buildTopDashboardFrameSecurityPolicy, getTopDashboardDataAdapterScript } from './topDashboardContentSecurity';
import { TOP_DASHBOARD_DOWNLOAD_MESSAGE_MARKER, TOP_DASHBOARD_DOWNLOAD_MAX_BYTES, TOP_DASHBOARD_DOWNLOAD_NAME_PATTERN_SOURCE, TOP_DASHBOARD_DOWNLOAD_INVALID_NAME_PATTERN_SOURCE } from './topDashboardDownloadBridge';

export type SupportSharedHtmlFormat = 'ktsp' | 'route-planner-v1';
const MARKER = 'kts-support-route-planner-v1';
const MAX_JSON_BYTES = 100 * 1024 * 1024;
const LOAD_HOOK = /\bwindow\.UI\s*=\s*\{/;

// Compatibility detection, not a trust decision: all supplied code remains in
// the opaque-origin sandbox, without cabinet cookies or general network access.
export function detectSupportSharedHtmlFormat(html: string): SupportSharedHtmlFormat | null {
  if (isPersonalDashboardHtml(html)) return 'ktsp';
  if (/<html[\s>]/i.test(html) && /\bfunction\s+loadSnapshot\s*\(j\)/.test(html)
    && /\bfunction\s+handleFiles\s*\(list\)/.test(html) && LOAD_HOOK.test(html)
    && /\bid=["']snapIn["']/.test(html) && /\bapp\s*:\s*['"]компоновщик['"]/.test(html)
    && /\bS\.orders\s*=\s*revive\(j\.orders\)/.test(html)) return 'route-planner-v1';
  return null;
}

export function injectSupportSharedRoutePlannerAdapter(html: string) {
  if (detectSupportSharedHtmlFormat(html) !== 'route-planner-v1') throw new Error('Несовместимый HTML компоновщика');
  // Expose only the existing loading boundary, not the internal state. The
  // supplied calculations and render functions are not rewritten.
  const hooked = html.replace(LOAD_HOOK, 'window.__ktsLoadSharedSnapshot = loadSnapshot; window.UI = {');
  const early = `<script data-kts-shared-downloads="1">${getTopDashboardDataAdapterScript(null, null, true)}</script>`;
  const withEarly = hooked.replace(/<head\b[^>]*>/i, (tag) => tag + early);
  const adapter = `<script data-kts-shared-route-planner="1">${routePlannerAdapterScript()}</script>`;
  // Unicode lowercasing may expand characters in bundled libraries (e.g. İ).
  // Match against the original source, otherwise the insertion offset drifts.
  const index = Array.from(withEarly.matchAll(/<\/body\s*>/gi)).at(-1)?.index ?? -1;
  return index < 0 ? withEarly + adapter : withEarly.slice(0, index) + adapter + withEarly.slice(index);
}

function routePlannerAdapterScript() {
  return `(() => {
    'use strict';
    const marker = '${MARKER}';
    const load = window.__ktsLoadSharedSnapshot;
    delete window.__ktsLoadSharedSnapshot;
    let installed = false;
    const send = (type) => window.parent.postMessage({marker,type}, '*');
    // Keep original exports/calculations available, but local file selection
    // cannot replace the centrally published report in a manager's cabinet.
    const style = document.createElement('style');
    style.textContent = '[onclick*="UI.openSnapshot"],[onclick*="UI.handleFiles"],label[for="fi"],label[for="fd"]{display:none!important}';
    document.head.appendChild(style);
    if (window.UI) window.UI.openSnapshot = () => {};
    // Only map coordinates cross this boundary. Uploaded code cannot put names
    // or report fragments in arbitrary external image URLs/query strings.
    const tiles = new Map(); let tileId = 0;
    if (window.L && window.L.TileLayer) window.L.TileLayer.prototype.createTile = function(coords, done) {
      const tile = document.createElement('img'); tile.alt = ''; tile.setAttribute('role','presentation');
      const id = ++tileId;
      if (tiles.size >= 128) { setTimeout(() => done(new Error('tile limit'),tile), 0); return tile; }
      const timer = setTimeout(() => { tiles.delete(id); done(new Error('tile timeout'),tile); }, 20000);
      tiles.set(id, {tile,done,timer});
      window.parent.postMessage({marker,type:'map-tile',id,z:coords.z,x:coords.x,y:coords.y}, '*');
      return tile;
    };
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (event.source !== window.parent || !data || data.marker !== marker || data.type !== 'map-tile-result') return;
      const pending = tiles.get(data.id); if (!pending) return;
      tiles.delete(data.id); clearTimeout(pending.timer);
      if (!(data.blob instanceof Blob) || data.blob.type !== 'image/png' || data.blob.size > 512 * 1024) { pending.done(new Error('tile unavailable'),pending.tile); return; }
      const url = URL.createObjectURL(data.blob);
      pending.tile.onload = () => { URL.revokeObjectURL(url); pending.done(null,pending.tile); };
      pending.tile.onerror = () => { URL.revokeObjectURL(url); pending.done(new Error('tile unavailable'),pending.tile); };
      pending.tile.src = url;
    });
    // The supplied print action writes a blank popup and prints it. Collect
    // only that document; the trusted wrapper prints a script-free copy.
    window.open = function(url) {
      if (url && String(url).toLowerCase() !== 'about:blank') return null;
      let html = '', closed = false, printed = false;
      const document = {write(...parts) { if (!closed) html += parts.join(''); }, close() { closed = true; }};
      return {document, focus() {}, close() { closed = true; }, print() {
        if (printed || !html || html.length > 5 * 1024 * 1024) return;
        printed = true;
        window.parent.postMessage({marker,type:'print',html}, '*');
      }};
    };
    window.addEventListener('message', async (event) => {
      const data = event.data;
      if (event.source !== window.parent || !data || data.marker !== marker || installed) return;
      if (data.type === 'probe') { send('ready'); return; }
      if (data.type !== 'snapshot' || !(data.blob instanceof Blob) || data.blob.size < 1 || data.blob.size > ${MAX_JSON_BYTES}) return;
      installed = true;
      try {
        let text = await data.blob.text();
        const json = JSON.parse(text); text = '';
        if (json.snapshot !== true || json.app !== 'компоновщик' || !Array.isArray(json.orders) || typeof load !== 'function') throw new Error('invalid');
        load(json);
        send('installed');
      } catch { send('error'); }
    });
    send('ready');
  })();`;
}

export function supportSharedRoutePlannerCsp(html: string) {
  // v26 generates onclick/onchange attributes dynamically. Permit attributes
  // only in this isolated report; executable script elements still need hashes.
  return buildTopDashboardContentSecurityPolicy(html).split('; ').map((rule) => {
    if (rule.startsWith('sandbox ')) return 'sandbox allow-scripts';
    return rule;
  }).concat("script-src-attr 'unsafe-inline'").join('; ');
}

export function buildSupportSharedRoutePlannerFrame(input: {versionId: number; snapshotId?: number; preview: boolean}) {
  const query = new URLSearchParams({version: String(input.versionId)});
  if (input.preview) query.set('preview', '1');
  const content = '/api/admin/manager-dashboard/shared/content?' + query;
  const dataQuery = new URLSearchParams({version: String(input.versionId)});
  if (input.snapshotId) dataQuery.set('snapshot', String(input.snapshotId));
  if (input.preview) dataQuery.set('preview', '1');
  const dataPath = '/api/admin/manager-dashboard/shared/json?' + dataQuery;
  const script = `(() => {
    'use strict';
    const frame = document.getElementById('report'), status = document.getElementById('status');
    const marker = '${MARKER}', hasSnapshot = ${!!input.snapshotId};
    let ready = false, sent = false, snapshot = null, printing = false;
    const controller = new AbortController();
    let tileRunning = 0, tileBudget = 0, tileWindow = Date.now();
    const tileQueue = [], tileControllers = new Set();
    const tileResult = (id,blob) => frame.contentWindow && frame.contentWindow.postMessage({marker,type:'map-tile-result',id,blob}, '*');
    function pumpTiles() {
      while (tileRunning < 6 && tileQueue.length) {
        const tile = tileQueue.shift(), cancel = new AbortController();
        tileRunning++; tileControllers.add(cancel);
        const deadline = setTimeout(() => cancel.abort(), 12000);
        fetch('https://tile.openstreetmap.org/' + tile.z + '/' + tile.x + '/' + tile.y + '.png',
          {credentials:'omit',referrerPolicy:'origin',cache:'default',redirect:'error',signal:cancel.signal})
          .then(async (res) => {
            if (!res.ok || !res.body || res.headers.get('content-type')?.split(';')[0] !== 'image/png'
              || res.headers.has('x-blocked') || Number(res.headers.get('content-length')) > 512 * 1024) throw new Error('tile');
            const reader = res.body.getReader(), chunks = []; let size = 0;
            try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
              if (size > 512 * 1024) throw new Error('size'); chunks.push(part.value); } }
            catch (error) { await reader.cancel().catch(() => {}); throw error; }
            finally { reader.releaseLock(); }
            const blob = new Blob(chunks, {type:'image/png'});
            const prefix = new Uint8Array(await blob.slice(0,8).arrayBuffer());
            if (prefix.join(',') !== '137,80,78,71,13,10,26,10') throw new Error('png');
            tileResult(tile.id,blob);
          }).catch(() => tileResult(tile.id,null)).finally(() => {
            clearTimeout(deadline); tileControllers.delete(cancel); tileRunning--; pumpTiles();
          });
      }
    }
    function requestTile(data) {
      if (!sent || !Number.isSafeInteger(data.id) || data.id < 1 || data.id > 1000000) return;
      if (Date.now() - tileWindow > 60000) { tileBudget = 0; tileWindow = Date.now(); }
      if (![data.z,data.x,data.y].every(Number.isSafeInteger) || data.z < 0 || data.z > 18
        || data.x < 0 || data.y < 0 || data.x >= 2 ** data.z || data.y >= 2 ** data.z
        || tileQueue.length >= 64 || ++tileBudget > 256) { tileResult(data.id,null); return; }
      tileQueue.push({id:data.id,z:data.z,x:data.x,y:data.y}); pumpTiles();
    }
    const deliver = () => {
      if (!ready || sent || !snapshot || !frame.contentWindow) return;
      sent = true; status.textContent = 'Открытие общего отчёта…';
      frame.contentWindow.postMessage({marker,type:'snapshot',blob:snapshot}, '*'); snapshot = null;
    };
    const timer = setTimeout(() => {
      if (hasSnapshot && !status.hidden) { controller.abort(); status.textContent = 'Отчёт не открылся. Перезагрузите отчёт или обратитесь к администратору.'; }
    }, 120000);
    function printDocument(source) {
      if (printing || !navigator.userActivation || !navigator.userActivation.isActive || typeof source !== 'string' || source.length > 5 * 1024 * 1024) return;
      printing = true;
      // Do not execute or reuse supplied HTML in the cabinet origin. Retain
      // only print typography/tables; scripts, URLs, forms and metadata go away.
      const parsed = new DOMParser().parseFromString(source, 'text/html');
      const allowed = new Set(['HTML','HEAD','BODY','TITLE','STYLE','DIV','SPAN','P','BR','HR','H1','H2','H3','H4','TABLE','THEAD','TBODY','TFOOT','TR','TH','TD','COLGROUP','COL','B','STRONG','I','EM','SMALL','UL','OL','LI']);
      for (const node of Array.from(parsed.querySelectorAll('*'))) {
        if (!allowed.has(node.tagName)) { node.remove(); continue; }
        for (const attr of Array.from(node.attributes)) if (!['class','style','colspan','rowspan'].includes(attr.name)) node.removeAttribute(attr.name);
      }
      const policy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; sandbox allow-same-origin allow-modals";
      const printFrame = document.createElement('iframe');
      printFrame.id = 'print-report'; printFrame.title = 'Печать маршрута';
      printFrame.setAttribute('sandbox','allow-same-origin allow-modals');
      printFrame.style.cssText = 'position:fixed;width:1px;height:1px;bottom:0;left:0;border:0';
      printFrame.srcdoc = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="' + policy + '">' + parsed.head.innerHTML + '</head><body>' + parsed.body.innerHTML + '</body></html>';
      printFrame.onload = () => {
        try { printFrame.contentWindow.focus(); printFrame.contentWindow.print(); }
        catch { status.hidden = false; status.textContent = 'Браузер заблокировал печать. Разрешите печать для сайта.'; }
        finally { setTimeout(() => {printFrame.remove(); printing = false;}, 1000); }
      };
      document.body.appendChild(printFrame);
    }
    window.addEventListener('message', (event) => {
      if (event.source !== frame.contentWindow || event.origin !== 'null' || !event.data) return;
      const d = event.data;
      if (d.marker === marker) {
        if (d.type === 'ready') { ready = true; deliver(); }
        if (d.type === 'installed' && sent) { status.hidden = true; clearTimeout(timer); }
        if (d.type === 'error') { clearTimeout(timer); status.textContent = 'Файл не открылся в этом HTML. Обратитесь к администратору.'; }
        if (d.type === 'print') printDocument(d.html);
        if (d.type === 'map-tile') requestTile(d);
      }
      if (d.marker === '${TOP_DASHBOARD_DOWNLOAD_MESSAGE_MARKER}' && d.type === 'download-request'
        && typeof d.name === 'string' && d.name.length > 0 && d.name.length <= 255
        && new RegExp(${JSON.stringify(TOP_DASHBOARD_DOWNLOAD_NAME_PATTERN_SOURCE)}, 'i').test(d.name)
        && !new RegExp(${JSON.stringify(TOP_DASHBOARD_DOWNLOAD_INVALID_NAME_PATTERN_SOURCE)}).test(d.name)
        && d.blob instanceof Blob && d.blob.size > 0 && d.blob.size <= ${TOP_DASHBOARD_DOWNLOAD_MAX_BYTES}
        && navigator.userActivation && navigator.userActivation.isActive) {
        window.parent.postMessage(d, window.location.origin);
      }
    });
    if (!hasSnapshot) status.textContent = 'Для этой версии HTML общий JSON ещё не опубликован.';
    else fetch(${JSON.stringify(dataPath)}, {credentials:'same-origin',cache:'no-store',signal:controller.signal}).then(async (res) => {
      if (!res.ok || !res.body || res.headers.get('x-kts-shared-version') !== '${input.versionId}'
        || res.headers.get('x-kts-shared-snapshot') !== '${input.snapshotId ?? ''}'
        || !/^[a-f0-9]{64}$/.test(res.headers.get('x-kts-shared-sha256') || '')) throw new Error('invalid');
      const reader = res.body.getReader(), chunks = []; let size = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
        if (size > ${MAX_JSON_BYTES}) throw new Error('size'); chunks.push(part.value); } }
      catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      if (!size) throw new Error('empty');
      snapshot = new Blob(chunks, {type:'application/json'}); deliver();
    }).catch(() => { clearTimeout(timer); status.textContent = 'Общий файл недоступен. Обновите страницу или обратитесь к администратору.'; });
    window.addEventListener('pagehide', () => { controller.abort(); snapshot = null; clearTimeout(timer); tileQueue.length = 0; tileControllers.forEach((item) => item.abort()); });
  })();`;
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Общий отчёт сопровождения</title><style>html,body{margin:0;height:100%;font-family:Arial,sans-serif}#status{padding:12px;background:#f5f3ff;color:#271078}#report{border:0;width:100%;height:100%;display:block}</style></head><body><div id="status">Загрузка общего отчёта…</div><iframe id="report" title="Компоновщик рейсов" sandbox="allow-scripts" referrerpolicy="same-origin" src="${content.replace(/&/g, '&amp;')}"></iframe><script>${script}</script></body></html>`;
  return {html, csp: buildTopDashboardFrameSecurityPolicy(script).replace("connect-src 'self'", "connect-src 'self' https://tile.openstreetmap.org")};
}
