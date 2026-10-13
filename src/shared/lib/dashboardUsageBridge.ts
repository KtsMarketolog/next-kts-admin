import { DASHBOARD_USAGE_MARKER } from './dashboardUsage';

function uploadParserScript() {
  return String.raw`function usageUpload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 2 || typeof value.name !== 'string'
      || !value.name.trim() || value.name.length > 255 || ['.','..'].includes(value.name)
      || /[\u0000-\u001f\u007f/\\\u202a-\u202e\u2066-\u2069]/.test(value.name)
      || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > 2147483648) return null;
    return {name:value.name,size:value.size};
  }`;
}

/** Explicit semantic events only; optional safe file metadata must come from a successful-load adapter. */
export function dashboardUsageAdapterScript() {
  return `(() => {
  if (window.__ktsDashboardUsage) return;
  const marker = '${DASHBOARD_USAGE_MARKER}';
  ${uploadParserScript()}
  const allowed = new Set(['report_open','tab_changed','filter_changed','calculation_completed','data_loaded','export_started']);
  let nonce = '', opened = false, lastInteraction = 0, profile = null, intent = null;
  const pending = [];
  const emit = (action, upload) => {
    if (!nonce) {
      if (pending.length < 20 && (upload || !pending.some(event => event.action === action && !event.upload))) pending.push({action,upload});
      return;
    }
    window.parent.postMessage(upload ? {marker,type:'event',nonce,action,upload} : {marker,type:'event',nonce,action}, '*');
  };
  const send = (action, metadata) => {
    if (!allowed.has(action)) return;
    const upload = action === 'data_loaded' && metadata && Object.keys(metadata).length === 1 ? usageUpload(metadata.upload) : null;
    if (metadata && !upload) return;
    if (action !== 'data_loaded' && action !== 'report_open' && Date.now() - lastInteraction > 30000) return;
    emit(action, upload);
  };
  const beginRender = () => {
    const current = intent; intent = null;
    if (!current || document.hidden || Date.now() - current.at > 1000) return null;
    let completed = false;
    return (calculated = true) => {
      if (completed || document.hidden) return; completed = true;
      if (current.action !== 'calculation_completed') emit(current.action);
      if (calculated) emit('calculation_completed');
    };
  };
  window.__ktsDashboardUsage = Object.freeze({record:send, beginRender, configure: configuration => {
    if (!profile && configuration && typeof configuration.id === 'string') profile = configuration;
  }});
  window.addEventListener('message', (event) => {
    const d = event.data;
    if (event.source !== window.parent || !d || d.marker !== marker || d.type !== 'init'
      || typeof d.nonce !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(d.nonce)) return;
    if (nonce && nonce !== d.nonce) opened = false;
    nonce = d.nonce;
    if (!opened) { opened = true; send('report_open'); pending.splice(0).forEach(event => emit(event.action,event.upload)); }
  });
  ['pointerdown','keydown','change','input','click'].forEach(type => document.addEventListener(type, event => {
    if (event.isTrusted && !document.hidden) lastInteraction = Date.now();
  }, true));
  const reviewedIntent = (event) => {
    if (!profile || !event.isTrusted || document.hidden || !(event.target instanceof Element)) return;
    const el = event.target;
    let action = null;
    if (event.type === 'click') {
      const tab = profile.tabs && el.closest(profile.tabs);
      if (tab && !tab.matches(':disabled,[aria-disabled="true"],.on,[aria-selected="true"]')) action = 'tab_changed';
      else if (profile.calculationClicks && el.closest(profile.calculationClicks)) action = 'calculation_completed';
      else if (profile.filterClicks && el.closest(profile.filterClicks)) action = 'filter_changed';
    } else if (!el.matches(':disabled,[type="password"],[type="file"]')) {
      if (profile.calculationInputs && el.matches(profile.calculationInputs)) action = 'calculation_completed';
      else if (profile.filterInputs && el.matches(profile.filterInputs)) action = 'filter_changed';
    }
    if (action) intent = {action, at:Date.now()};
    else if (event.type === 'click') intent = null;
  };
  ['click','change','input'].forEach(type => document.addEventListener(type, reviewedIntent, true));
  document.addEventListener('click', event => {
    if (profile || !event.isTrusted || document.hidden || !(event.target instanceof Element)) return;
    const el = event.target.closest('[role="tab"],button[data-tab],a[data-tab],button[data-page],a[data-page],button.tab,a.tab,button.nav-item,a.nav-item');
    if (el && !el.matches(':disabled,[aria-disabled="true"]')) send('tab_changed');
  }, true);
  document.addEventListener('change', event => {
    if (profile || !event.isTrusted || document.hidden || !(event.target instanceof Element)) return;
    const el = event.target;
    // Selected filters are recognisable by their semantic container or adapter attribute.
    // Ordinary forms (including passwords and financial inputs) are not inspected.
    if (el.matches('[data-kts-usage-filter],select[id^="filter"],select[id^="flt"],input[id="summaryMonth"]')
      || (el.closest('.filters,[data-filters]') && el.matches('select,input[type="checkbox"],input[type="radio"],input[type="date"]'))) send('filter_changed');
  }, true);
  // HTML authors may report a completed operation, not merely a button press.
  window.addEventListener('kts:dashboard-usage', event => { if (event.detail && allowed.has(event.detail.action)) send(event.detail.action); });
  window.parent.postMessage({marker,type:'ready'}, '*');
})();`;
}

export function injectDashboardUsageAdapter(html: string) {
  const script = `<script data-kts-dashboard-usage="1">${dashboardUsageAdapterScript()}</script>`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) { const at = head.index + head[0].length; return html.slice(0, at) + script + html.slice(at); }
  return script + html;
}

/** Runs in a same-origin trusted wrapper. It relays only whitelisted scalars. */
export function dashboardUsageRelayScript(frameExpression: string) {
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(frameExpression)) throw new Error('Invalid usage frame variable');
  return `(() => {
    const usageFrame = ${frameExpression}, usageMarker = '${DASHBOARD_USAGE_MARKER}';
    ${uploadParserScript()}
    let usageNonce = '';
    const probeUsage = () => { if (usageNonce && usageFrame.contentWindow) usageFrame.contentWindow.postMessage({marker:usageMarker,type:'init',nonce:usageNonce}, '*'); };
    usageFrame.addEventListener('load', probeUsage);
    window.addEventListener('message', event => {
      const d = event.data;
      if (!d || d.marker !== usageMarker) return;
      if (event.source === window.parent && event.origin === window.location.origin && d.type === 'init'
        && typeof d.nonce === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(d.nonce)) {
        usageNonce = d.nonce; probeUsage(); return;
      }
      if (event.source !== usageFrame.contentWindow || event.origin !== 'null') return;
      if (d.type === 'ready') { probeUsage(); return; }
      if (d.type === 'event' && usageNonce && d.nonce === usageNonce
        && ['report_open','tab_changed','filter_changed','calculation_completed','data_loaded','export_started'].includes(d.action)) {
        const upload = d.action === 'data_loaded' && d.upload !== undefined ? usageUpload(d.upload) : null;
        const keys = upload ? ['marker','type','nonce','action','upload'] : ['marker','type','nonce','action'];
        if (Object.keys(d).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(d,key))) return;
        window.parent.postMessage(upload ? {marker:usageMarker,type:'event',nonce:usageNonce,action:d.action,upload}
          : {marker:usageMarker,type:'event',nonce:usageNonce,action:d.action}, window.location.origin);
      }
    });
    window.parent.postMessage({marker:usageMarker,type:'ready'}, window.location.origin);
  })();`;
}
