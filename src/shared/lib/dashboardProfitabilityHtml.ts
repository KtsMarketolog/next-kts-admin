import { createHash } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import { instrumentReviewedProfitabilityUsage } from './dashboardUsageProfiles';

// This fingerprint covers only the author's application script, never the private embedded stock.
// Automatic hooks require review; explicit invoice-v1 uses the independent author contract below.
const V19_APPLICATION_SHA256 = 'e58f2d053f9edc76217a13e1a3d8ec89bd8e2493604ef00786d70b656d6e9b84';
const ADAPTER_ATTRIBUTE = 'data-kts-profitability-audit-adapter="v1"';
const INVOICE_SUCCESS = "S.log.push({ file: f.name, kind: inv.docType + ' · ' + r.kind, ok: true, id: inv.id, msg });";
const SNAPSHOT_SUCCESS = "S.log.push({ file: f.name, kind: 'снимок', ok: true, msg: 'счетов: ' + d.invs.length + ', сохранён ' + dtstr(new Date(d.saved)) });";

type SupportedScript = { start: number; end: number; source: string; content: string };

function supportedApplication(html: string): SupportedScript | null {
  if (html.includes(ADAPTER_ATTRIBUTE)) return null;
  let result: SupportedScript | null = null;
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = match[1];
    // V19 has an ordinary, inline, classic script. JSON and bundled PDF worker scripts are data.
    if (attributes.trim()) continue;
    const content = match[2];
    if (!content.includes(INVOICE_SUCCESS) || !content.includes(SNAPSHOT_SUCCESS)) continue;
    if (content.split(INVOICE_SUCCESS).length !== 2 || content.split(SNAPSHOT_SUCCESS).length !== 2) return null;
    if (createHash('sha256').update(content, 'utf8').digest('hex') !== V19_APPLICATION_SHA256) continue;
    if (result) return null;
    result = { start: match.index!, end: match.index! + match[0].length, source: match[0], content };
  }
  return result;
}

export function isSupportedProfitabilityHtml(html: string): boolean {
  return supportedApplication(html) !== null;
}

// A conventional, explicit head keeps insertion outside comments, attribute
// values and author scripts. The declaration below is independently HTML-parsed.
function protocolHeadEnd(html: string): number | null {
  const tagAttributes = `(?:[^<>"']|"[^"]*"|'[^']*')*`;
  const space = `(?:\\s|<!--(?:[\\s\\S]*?)-->)*`;
  const head = new RegExp(`^${space}(?:<!doctype\\b${tagAttributes}>${space})?(?:<html(?=[\\s>])${tagAttributes}>${space})?<head(?=[\\s>])${tagAttributes}>`, 'i').exec(html);
  return head ? head[0].length : null;
}

/** Explicit author opt-in, never inferred from JS strings, comments or filenames. */
export function declaresDashboardInvoiceAudit(html: string): boolean {
  if (!html.includes('kts-dashboard-audit') || protocolHeadEnd(html) === null) return false;
  let inHead = false;
  let inertDepth = 0;
  let declarations = 0;
  let supported = false;
  const inert = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template', 'svg', 'math']);
  try {
    sanitizeHtml(html, {
      allowedTags: [], allowedAttributes: {},
      textFilter: () => '',
      onOpenTag(name, attributes) {
        if (inert.has(name)) inertDepth++;
        if (name === 'head' && !inertDepth) inHead = true;
        if (name === 'body' && !inertDepth) inHead = false;
        if (name !== 'meta' || !inHead || inertDepth || attributes.name !== 'kts-dashboard-audit') return;
        declarations++;
        supported = attributes.content === 'invoice-v1';
      },
      onCloseTag(name) {
        if (name === 'head' && !inertDepth) inHead = false;
        if (inert.has(name)) inertDepth = Math.max(0, inertDepth - 1);
      },
    });
  } catch { return false; }
  return declarations === 1 && supported;
}

/** Detailed invoice collection is optional and independent of author release numbers. */
export function supportsDashboardInvoiceAudit(html: string): boolean {
  return isSupportedProfitabilityHtml(html) || declaresDashboardInvoiceAudit(html);
}

/** Local-invoice recognizer: unknown author versions must not share private inputs as generic snapshots. */
export function isProfitabilityHtmlCandidate(html: string): boolean {
  return /\bkts-rent-snapshot\b/.test(html)
    && (/<input\b[^>]*\bid\s*=\s*(["'])fInv\1/i.test(html) || /\bparseInvoiceFile\s*\(/.test(html))
    && (/Рентабельность\s+(?:сч[её]тов|сделок)/iu.test(html) || /["']kts-rent:/.test(html));
}

/** Runs in the opaque report frame; the trusted wrapper owns identity, authorization and persistence. */
function auditAdapterScript(protocol = false): string {
  return String.raw`(function () {
  'use strict';
  var protocol = ${protocol ? 'true' : 'false'};
  if (window.__ktsProfitabilityAuditV19 || (protocol && window.KTSDashboardAudit)) return;
  var marker = 'kts-profitability-audit-v1';
  var nonce = null;
  var selectedFiles = new WeakSet();
  var protocolReceipts = new WeakMap();
  var queue = [];
  var MAX_QUEUE = 100;
  var MAX_BODY = 1024 * 1024;
  var rejected = 0;
  var error = '';
  var completed = 0;
  var notice = null;
  var status = null;
  var retry = null;
  var nextAttempt = 0;
  var lastReady = 0;
  var lastStatus = 0;

  function reportPending(force) {
    if (!nonce || window.parent === window || (!force && Date.now() - lastStatus < 3000)) return;
    lastStatus = Date.now();
    window.parent.postMessage({ marker: marker, type: 'status', nonce: nonce, pending: Boolean(queue.length || rejected) }, '*');
  }

  function text(value, max) {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error('Поля счёта не подходят для журнала; проверьте номер и наименования.');
    }
    return value;
  }
  function finite(value, max) { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= max; }
  function exactObject(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || keys.some(function (key) { return !Object.prototype.hasOwnProperty.call(value, key); })) {
      throw new Error('Некорректный формат invoice-v1. Передавайте только исходные поля счёта или КП.');
    }
    return value;
  }
  function canonicalInvoice(value) {
    var inv = exactObject(value, ['schemaVersion', 'documentType', 'invoiceNumber', 'currency', 'dealAmount', 'amountSource', 'lines']);
    if (inv.schemaVersion !== 1 || ['invoice', 'quote'].indexOf(inv.documentType) < 0
      || typeof inv.currency !== 'string' || !/^[A-Z]{3}$/.test(inv.currency)
      || ['document', 'lines', 'unavailable'].indexOf(inv.amountSource) < 0
      || (inv.dealAmount === null) !== (inv.amountSource === 'unavailable')
      || (inv.dealAmount !== null && !finite(inv.dealAmount, 1e15))
      || !Array.isArray(inv.lines) || !inv.lines.length || inv.lines.length > 1000) {
      throw new Error('Некорректные исходные данные счёта или КП для invoice-v1. Ручные расчёты в этот журнал не передаются.');
    }
    return { schemaVersion: 1, documentType: inv.documentType, invoiceNumber: inv.invoiceNumber === null ? null : text(inv.invoiceNumber, 200),
      currency: inv.currency, dealAmount: inv.dealAmount, amountSource: inv.amountSource,
      lines: inv.lines.map(function (value) {
        var line = exactObject(value, ['nomenclature', 'quantity']);
        if (!finite(line.quantity, 1e12)) throw new Error('Количество в счёте выходит за допустимый диапазон журнала.');
        return { nomenclature: text(line.nomenclature, 500), quantity: line.quantity };
      }) };
  }
  function uploadMetadata(file) {
    if (typeof file.name !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 2147483648) return null;
    var name = file.name.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 255);
    return name && name !== '.' && name !== '..' ? { name: name, size: file.size } : null;
  }
  function project(inv) {
    if (!inv || !Array.isArray(inv.lines)) throw new Error('В счёте нет распознанных позиций.');
    // Manual rows are entered in RUB even in a foreign-currency document. They are not original invoice items.
    var sourceLines = inv.lines.filter(function (line) { return line && !line.manual; });
    if (!sourceLines.length || sourceLines.length > 1000) throw new Error('Для журнала требуется от 1 до 1000 исходных позиций счёта.');
    var lines = sourceLines.map(function (line) {
      if (!finite(line.qty, 1e12)) throw new Error('Количество в счёте выходит за допустимый диапазон журнала.');
      return { nomenclature: text(line.name, 500), quantity: line.qty };
    });
    // cur is user-editable; curDet is the currency parsed from the original document.
    var currency = inv.curDet || inv.cur || 'RUB';
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new Error('Не удалось определить валюту исходного счёта.');
    var missingNumber = Array.isArray(inv.warns) && inv.warns.some(function (warning) {
      return typeof warning === 'string' && /не найден номер (?:сч[её]та|КП)/i.test(warning);
    });
    // The parser falls back to a filename when it cannot find a number. Do not present that as an invoice number.
    var invoiceNumber = missingNumber || inv.no == null || inv.no === '' ? null : text(inv.no, 200);
    var dealAmount = null;
    var amountSource = 'unavailable';
    if (inv.totalDue != null) {
      if (!finite(inv.totalDue, 1e15)) throw new Error('Сумма исходного счёта выходит за допустимый диапазон журнала.');
      dealAmount = inv.totalDue;
      amountSource = 'document';
    } else if (sourceLines.every(function (line) { return finite(line.gross, 1e15); })) {
      var sum = sourceLines.reduce(function (value, line) { return value + line.gross; }, 0);
      if (!finite(sum, 1e15)) throw new Error('Сумма позиций выходит за допустимый диапазон журнала.');
      dealAmount = sum;
      amountSource = 'lines';
    }
    return { schemaVersion: 1, documentType: inv.docType === 'КП' ? 'quote' : 'invoice', invoiceNumber: invoiceNumber,
      currency: currency, dealAmount: dealAmount, amountSource: amountSource, lines: lines };
  }
  function uuid() {
    if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') throw new Error('Браузер не поддерживает защищённую запись журнала.');
    if (typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    var bytes = window.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    var hex = Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }
  function redraw() {
    reportPending(true);
    if (!document.body) return;
    if (!notice) {
      notice = document.createElement('aside');
      notice.id = 'kts-profitability-audit-notice';
      notice.setAttribute('aria-label', 'Журнал загрузки счетов');
      notice.style.cssText = 'position:fixed;bottom:8px;left:8px;max-width:min(680px,calc(100vw - 16px));z-index:2147483647;padding:9px 12px;border:1px solid #b9c5d9;border-radius:8px;background:#f5f8ff;color:#18253e;font:12px/1.45 system-ui,sans-serif;box-shadow:0 2px 10px #0002;box-sizing:border-box';
      var disclosure = document.createElement('div');
      disclosure.textContent = 'При загрузке счёта в журнал сохраняются пользователь, имя и размер файла, номер, позиции, количество, исходная сумма и валюта.';
      notice.appendChild(disclosure);
      status = document.createElement('div');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      notice.appendChild(status);
      retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Повторить запись';
      retry.style.cssText = 'margin-top:5px;padding:4px 8px;cursor:pointer';
      retry.addEventListener('click', function () { nextAttempt = 0; lastReady = 0; pump(); });
      notice.appendChild(retry);
      document.body.appendChild(notice);
    }
    if (rejected) {
      status.textContent = 'Не записано: ' + rejected + '. ' + error + ' Повторите загрузку этих документов после устранения причины. В очереди: ' + queue.length + '.';
    } else if (error) {
      status.textContent = 'Запись не подтверждена: ' + error + ' В очереди: ' + queue.length + '. Не закрывайте страницу — повторяем запись.';
    } else if (queue.length) {
      status.textContent = 'Ожидают подтверждения записи: ' + queue.length + '. Не закрывайте страницу.';
    } else {
      status.textContent = completed ? 'Загрузка документов записана в журнал: ' + completed + '.' : 'Журнал готов к загрузке документов.';
    }
    notice.style.borderColor = rejected || error ? '#c64545' : '#b9c5d9';
    retry.hidden = !queue.length;
  }
  function ready() {
    if (window.parent === window) return;
    window.parent.postMessage({ marker: marker, type: 'ready' }, '*');
  }
  function pump() {
    var now = Date.now();
    reportPending(false);
    if (!nonce) {
      if (now - lastReady >= 3000 || !lastReady) { lastReady = now; ready(); }
      if (queue.length && now - queue[0].created > 10000) { error = 'Нет соединения с журналом сайта.'; redraw(); }
      return;
    }
    if (!queue.length || now < nextAttempt) return;
    var item = queue[0];
    try {
      window.parent.postMessage(Object.assign({ marker: marker, type: 'invoice', nonce: nonce, eventId: item.eventId, invoice: item.invoice }, item.upload ? { upload: item.upload } : {}), '*');
      nextAttempt = now + 10000;
    } catch (_) {
      error = 'Не удалось отправить запись на сайт.';
      nextAttempt = now + 30000;
      redraw();
    }
  }
  function markFiles(event) {
    if (!event.isTrusted) return;
    var files;
    if (event.type === 'change') {
      var input = event.target;
      if (!input || input.type !== 'file' || (!protocol && ['fInv', 'fSnap', 'fDirInv'].indexOf(input.id) < 0)) return;
      files = input.files;
    } else if (event.type === 'drop') {
      files = event.dataTransfer && event.dataTransfer.files;
    }
    if (files) Array.from(files).forEach(function (file) { if (file && typeof file === 'object') selectedFiles.add(file); });
  }
  function recordInvoices(invoices, file) {
    // File identity ties success hooks to a real local import, not a shared snapshot restore or bundled demo.
    if (!file || !selectedFiles.has(file) || !Array.isArray(invoices)) return;
    var upload = uploadMetadata(file);
    invoices.forEach(function (inv) {
      try {
        if (queue.length >= MAX_QUEUE) throw new Error('Очередь журнала заполнена. Дождитесь записи предыдущих документов.');
        var invoice = project(inv);
        var eventId = uuid();
        // Reserve room for the trusted wrapper envelope (dashboard/version/preview metadata).
        if (new TextEncoder().encode(JSON.stringify({ eventId: eventId, invoice: invoice, upload: upload })).byteLength > MAX_BODY - 1024) {
          throw new Error('Детализация счёта превышает 1 МБ; запись не отправлена.');
        }
        queue.push({ eventId: eventId, invoice: invoice, upload: upload, created: Date.now() });
      } catch (reason) {
        rejected++;
        error = reason instanceof Error ? reason.message : 'Не удалось подготовить запись.';
      }
    });
    redraw();
    pump();
  }
  function recordInvoice(value, file) {
    // The protocol never inspects arbitrary author variables or reads file bytes.
    // Success is declared by the author after import, not inferred from choosing a file.
    if (!file || !selectedFiles.has(file)) return null;
    try {
      var upload = uploadMetadata(file);
      if (!upload) throw new Error('Не удалось определить имя и размер выбранного файла.');
      var invoice = canonicalInvoice(value);
      var key = JSON.stringify(invoice);
      var receipts = protocolReceipts.get(file);
      if (receipts && receipts.has(key)) return receipts.get(key);
      if (queue.length >= MAX_QUEUE || (receipts && receipts.size >= 1000)) throw new Error('Очередь журнала заполнена. Дождитесь записи предыдущих документов.');
      var eventId = uuid();
      if (new TextEncoder().encode(JSON.stringify({ eventId: eventId, invoice: invoice, upload: upload })).byteLength > MAX_BODY - 1024) {
        throw new Error('Детализация счёта превышает 1 МБ; запись не отправлена.');
      }
      if (!receipts) { receipts = new Map(); protocolReceipts.set(file, receipts); }
      receipts.set(key, eventId);
      queue.push({ eventId: eventId, invoice: invoice, upload: upload, created: Date.now() });
      redraw();
      pump();
      return eventId;
    } catch (reason) {
      rejected++;
      error = reason instanceof Error ? reason.message : 'Не удалось подготовить запись.';
      redraw();
      return null;
    }
  }
  if (protocol) {
    Object.defineProperty(window, 'KTSDashboardAudit', { value: Object.freeze({ version: 'invoice-v1', recordInvoice: recordInvoice }), writable: false, configurable: false });
  } else {
    Object.defineProperty(window, '__ktsProfitabilityAuditV19', { value: Object.freeze({ recordInvoices: recordInvoices }), writable: false, configurable: false });
  }
  document.addEventListener('change', markFiles, true);
  document.addEventListener('drop', markFiles, true);
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || window.parent === window) return;
    var data = event.data;
    if (!data || data.marker !== marker) return;
    if (data.type === 'init' && typeof data.nonce === 'string' && /^[a-zA-Z0-9_-]{24,128}$/.test(data.nonce)) {
      var changed = nonce !== data.nonce;
      nonce = data.nonce;
      if (changed) { nextAttempt = 0; if (!rejected) error = ''; }
      redraw();
      pump();
    } else if (data.type === 'ack' && data.nonce === nonce && queue.length && data.eventId === queue[0].eventId) {
      if (data.ok === true) {
        queue.shift();
        completed++;
        nextAttempt = 0;
        if (!rejected) error = '';
      } else if (data.ok === false) {
        // Never discard a failed record. Retry the same id so the server can deduplicate a lost ACK.
        if (!rejected) error = typeof data.error === 'string' ? data.error.slice(0, 300) : 'Сайт не подтвердил сохранение.';
        nextAttempt = Date.now() + 30000;
      } else return;
      redraw();
      pump();
    }
  });
  window.addEventListener('beforeunload', function (event) {
    if (!queue.length && !rejected) return;
    event.preventDefault();
    event.returnValue = '';
  });
  document.addEventListener('DOMContentLoaded', function () { redraw(); ready(); });
  window.setInterval(pump, 1000);
  redraw();
  pump();
})();`;
}

export function injectProfitabilityAuditAdapter(html: string): string {
  if (html.includes(ADAPTER_ATTRIBUTE)) return html;
  const application = supportedApplication(html);
  if (!application) {
    const insertAt = protocolHeadEnd(html);
    if (insertAt === null || !declaresDashboardInvoiceAudit(html)) return html;
    return html.slice(0, insertAt) + `\n<script ${ADAPTER_ATTRIBUTE}>${auditAdapterScript(true)}</script>\n` + html.slice(insertAt);
  }
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (!head || head.index >= application.start) return html;
  const invoiceHook = INVOICE_SUCCESS + "\n      try { if (!DEMO) window.__ktsProfitabilityAuditV19.recordInvoices([inv], f); } catch (_) { /* Audit must not change report calculations. */ }";
  const snapshotHook = SNAPSHOT_SUCCESS + "\n    try { if (!DEMO) window.__ktsProfitabilityAuditV19.recordInvoices(d.invs, f); } catch (_) { /* Audit must not change report calculations. */ }";
  const source = instrumentReviewedProfitabilityUsage(application.source).replace(INVOICE_SUCCESS, invoiceHook).replace(SNAPSHOT_SUCCESS, snapshotHook);
  const patched = html.slice(0, application.start) + source + html.slice(application.end);
  const insertAt = head.index + head[0].length;
  return patched.slice(0, insertAt) + `\n<script ${ADAPTER_ATTRIBUTE}>${auditAdapterScript()}</script>\n` + patched.slice(insertAt);
}
