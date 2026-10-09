import { MAX_PROFITABILITY_AUDIT_BODY, MAX_PROFITABILITY_INVOICE_LINES } from './dashboardProfitabilityAudit';

export const PROFITABILITY_AUDIT_MARKER = 'kts-profitability-audit-v1';

/** Opt-in trusted wrapper. Financial details never enter generic usage telemetry. */
export function dashboardProfitabilityBridgeScript(frameExpression: string, config: {
  dashboardKey: string;
  versionId: number;
  preview: boolean;
}) {
  if (!/^[A-Za-z_$][\w$]*$/.test(frameExpression)
    || !/^top:[1-9][0-9]{0,14}$/.test(config.dashboardKey)
    || !Number.isSafeInteger(config.versionId) || config.versionId < 1
    || typeof config.preview !== 'boolean') throw new Error('Invalid profitability bridge configuration');
  return String.raw`((frame) => {
    'use strict';
    if (!(frame instanceof HTMLIFrameElement)) return;
    const marker = '${PROFITABILITY_AUDIT_MARKER}';
    const config = ${JSON.stringify(config)};
    const endpoint = '/api/admin/dashboard-usage/profitability';
    const MAX_BODY = ${MAX_PROFITABILITY_AUDIT_BODY};
    const MAX_LINES = ${MAX_PROFITABILITY_INVOICE_LINES};
    const MAX_PENDING = 8, MAX_QUEUED_BYTES = 4 * MAX_BODY, MAX_RECENT = 256;
    const pending = new Map(), completed = new Map(), failed = new Set();
    let nonce = '', generation = 0, queuedBytes = 0, hashing = 0, running = false, activeController = null;
    let stopped = false, innerPending = false, innerStatusReady = false;
    const notice = document.createElement('div');
    notice.id = 'profitability-audit-notice'; notice.hidden = true;
    notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
    notice.style.cssText = 'position:fixed;z-index:20;bottom:14px;right:14px;max-width:min(460px,calc(100% - 28px));box-sizing:border-box;padding:10px 14px;border:1px solid #d4cbff;border-radius:10px;box-shadow:0 8px 24px rgba(22,27,46,.18);font:600 14px/1.35 Arial,sans-serif;background:#f0edff;color:#32208c';
    document.body.appendChild(notice);
    function relayPending() {
      if (window.parent !== window) window.parent.postMessage({marker,type:'pending-state',
        pending:innerPending || pending.size > 0 || hashing > 0 || failed.size > 0}, window.location.origin);
    }
    function show(kind, text) {
      // The reviewed report owns a persistent status + retry panel. Avoid two
      // overlapping fixed notices on small screens once that panel is ready.
      notice.hidden = innerStatusReady; notice.dataset.kind = kind; notice.textContent = text;
      notice.style.background = kind === 'error' ? '#fff0ee' : kind === 'success' ? '#eaf8f0' : '#f0edff';
      notice.style.color = kind === 'error' ? '#9d271e' : kind === 'success' ? '#146c3b' : '#32208c';
    }
    function post(message) { if (frame.contentWindow) frame.contentWindow.postMessage(Object.assign({marker,nonce}, message), '*'); }
    function ack(eventId, ok, error) { post(Object.assign({type:'ack',eventId,ok}, ok ? {} : {error})); }
    function fail(eventId, message) {
      if (failed.size < MAX_RECENT) failed.add(eventId);
      show('error', message); ack(eventId, false, message); relayPending();
    }
    function object(value, keys) {
      return value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    }
    function text(value, max) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value); }
    function number(value, max) { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= max; }
    function invoice(value) {
      if (!object(value, ['schemaVersion','documentType','invoiceNumber','currency','dealAmount','amountSource','lines'])
        || value.schemaVersion !== 1 || !['invoice','quote'].includes(value.documentType)
        || !(value.invoiceNumber === null || text(value.invoiceNumber, 200))
        || typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)
        || !(value.dealAmount === null || number(value.dealAmount, 1e15))
        || !['document','lines','unavailable'].includes(value.amountSource)
        || ((value.dealAmount === null) !== (value.amountSource === 'unavailable'))
        || !Array.isArray(value.lines) || !value.lines.length || value.lines.length > MAX_LINES) return null;
      const lines = [];
      for (const line of value.lines) {
        if (!object(line, ['nomenclature','quantity']) || !text(line.nomenclature, 500) || !number(line.quantity, 1e12)) return null;
        lines.push({nomenclature:line.nomenclature,quantity:line.quantity});
      }
      return {schemaVersion:1,documentType:value.documentType,invoiceNumber:value.invoiceNumber,currency:value.currency,
        dealAmount:value.dealAmount,amountSource:value.amountSource,lines};
    }
    const sleep = milliseconds => new Promise(resolve => window.setTimeout(resolve, milliseconds));
    async function deliver(entry, epoch) {
      const delays = [1000, 3000, 10000];
      for (let attempt = 0; attempt < 4; attempt++) {
        if (epoch !== generation || stopped) return null;
        const controller = new AbortController(); activeController = controller;
        const timeout = window.setTimeout(() => controller.abort(), 30000);
        let retry = false;
        try {
          const response = await fetch(endpoint, {method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',
            headers:{'Content-Type':'application/json'},body:entry.body,signal:controller.signal});
          if (epoch !== generation) return null;
          if (response.ok) {
            const result = await response.json().catch(() => null);
            if (result && result.ok === true && (!result.eventId || result.eventId === entry.eventId)) return {ok:true};
            retry = true;
          } else if (response.status === 401 || response.status === 403) {
            stopped = true;
            return {ok:false,error:'Нет доступа для сохранения детализации счёта. Обновите страницу и проверьте авторизацию.'};
          } else if (response.status === 429 || response.status >= 500) retry = true;
          else return {ok:false,error:response.status === 413
            ? 'Детализация счёта слишком большая и не сохранена в журнале.'
            : 'Детализация счёта не принята журналом. Проверьте документ и обратитесь к администратору.'};
        } catch { retry = true; }
        finally { window.clearTimeout(timeout); if (activeController === controller) activeController = null; }
        if (epoch !== generation) return null;
        if (retry && attempt < delays.length) {
          show('pending', 'Детализация счёта ещё не сохранена. Повторяем отправку…');
          await sleep(delays[attempt]);
        }
      }
      return {ok:false,error:'Не удалось сохранить детализацию счёта в журнале. Не закрывайте отчёт и повторите отправку.'};
    }
    async function drain() {
      if (running) return;
      const epoch = generation; running = true;
      try {
        while (pending.size && epoch === generation) {
          const entry = pending.values().next().value;
          const result = stopped ? {ok:false,error:'Нет доступа для сохранения детализации счёта. Обновите страницу.'} : await deliver(entry, epoch);
          if (!result || epoch !== generation) return;
          pending.delete(entry.eventId); queuedBytes -= entry.bytes;
          if (result.ok) {
            completed.set(entry.eventId, entry.digest);
            while (completed.size > MAX_RECENT) completed.delete(completed.keys().next().value);
            failed.delete(entry.eventId); ack(entry.eventId, true);
            if (!failed.size) show(pending.size ? 'pending' : 'success', pending.size ? 'Сохраняем детализацию счетов…' : 'Детализация счёта сохранена в журнале.');
          } else fail(entry.eventId, result.error);
          relayPending();
        }
      } finally {
        if (epoch === generation) running = false;
      }
    }
    async function accept(data) {
      const epoch = generation;
      if (typeof data.eventId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(data.eventId)) return;
      if (!object(data, ['marker','type','nonce','eventId','invoice'])) return fail(data.eventId, 'Некорректная детализация счёта не сохранена.');
      const parsed = invoice(data.invoice);
      if (!parsed) return fail(data.eventId, 'Некорректная детализация счёта не сохранена.');
      const body = JSON.stringify({eventId:data.eventId,dashboardKey:config.dashboardKey,versionId:config.versionId,preview:config.preview,invoice:parsed});
      const bytes = new TextEncoder().encode(body);
      if (bytes.length > MAX_BODY) return fail(data.eventId, 'Детализация счёта слишком большая и не сохранена в журнале.');
      if (hashing >= MAX_PENDING) return fail(data.eventId, 'Очередь журнала заполнена. Повторите отправку после завершения текущей операции.');
      hashing++; relayPending();
      let digest;
      try { digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2,'0')).join(''); }
      catch { if (epoch === generation) fail(data.eventId, 'Не удалось подготовить детализацию счёта. Повторите отправку.'); return; }
      finally { hashing--; relayPending(); }
      if (epoch !== generation) return;
      if (completed.has(data.eventId)) {
        return completed.get(data.eventId) === digest ? ack(data.eventId, true) : fail(data.eventId, 'Идентификатор операции уже использован для другого счёта.');
      }
      if (pending.has(data.eventId)) {
        if (pending.get(data.eventId).digest !== digest) fail(data.eventId, 'Идентификатор операции уже используется для другого счёта.');
        return;
      }
      if (pending.size >= MAX_PENDING || queuedBytes + bytes.length > MAX_QUEUED_BYTES) return fail(data.eventId, 'Очередь журнала заполнена. Повторите отправку после завершения текущей операции.');
      pending.set(data.eventId, {eventId:data.eventId,body,bytes:bytes.length,digest}); queuedBytes += bytes.length;
      show('pending', 'Сохраняем детализацию счёта…'); relayPending(); void drain();
    }
    function initialize() {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      nonce = Array.from(bytes, byte => byte.toString(16).padStart(2,'0')).join(''); generation++;
      if (activeController) activeController.abort();
      pending.clear(); completed.clear(); failed.clear(); queuedBytes = 0; running = false; stopped = false; innerPending = false; innerStatusReady = false;
      notice.hidden = true; post({type:'init'}); relayPending();
    }
    frame.addEventListener('load', initialize);
    window.addEventListener('message', event => {
      if (event.source !== frame.contentWindow || event.origin !== 'null') return;
      const data = event.data;
      if (!data || typeof data !== 'object' || data.marker !== marker) return;
      if (object(data, ['marker','type']) && data.type === 'ready') { innerStatusReady = true; notice.hidden = true; post({type:'init'}); return; }
      if (object(data, ['marker','type','nonce','pending']) && data.type === 'status' && data.nonce === nonce && typeof data.pending === 'boolean') {
        innerStatusReady = true; notice.hidden = true; innerPending = data.pending; relayPending(); return;
      }
      if (data.type !== 'invoice' || data.nonce !== nonce) return;
      void accept(data);
    });
    window.addEventListener('beforeunload', event => {
      if (!pending.size && !hashing) return;
      event.preventDefault(); event.returnValue = '';
    });
    initialize();
  })(${frameExpression});`;
}
