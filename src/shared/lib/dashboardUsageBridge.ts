import { DASHBOARD_USAGE_MARKER } from './dashboardUsage';

/** Explicit semantic events only. Never reads input values, text, HTML or filenames. */
export function dashboardUsageAdapterScript() {
  return `(() => {
  if (window.__ktsDashboardUsage) return;
  const marker = '${DASHBOARD_USAGE_MARKER}';
  const allowed = new Set(['report_open','tab_changed','filter_changed','calculation_completed','data_loaded','export_started']);
  let nonce = '', opened = false, lastInteraction = 0;
  const pending = new Set();
  const send = (action) => {
    if (!allowed.has(action)) return;
    if (action !== 'data_loaded' && action !== 'report_open' && Date.now() - lastInteraction > 30000) return;
    if (!nonce) { if (action === 'data_loaded') pending.add(action); return; }
    window.parent.postMessage({marker,type:'event',nonce,action}, '*');
  };
  window.__ktsDashboardUsage = Object.freeze({record:send});
  window.addEventListener('message', (event) => {
    const d = event.data;
    if (event.source !== window.parent || !d || d.marker !== marker || d.type !== 'init'
      || typeof d.nonce !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(d.nonce)) return;
    if (nonce && nonce !== d.nonce) opened = false;
    nonce = d.nonce;
    if (!opened) { opened = true; send('report_open'); pending.forEach(send); pending.clear(); }
  });
  ['pointerdown','keydown','change'].forEach(type => document.addEventListener(type, event => {
    if (event.isTrusted && !document.hidden) lastInteraction = Date.now();
  }, true));
  document.addEventListener('click', event => {
    if (!event.isTrusted || document.hidden || !(event.target instanceof Element)) return;
    const el = event.target.closest('[role="tab"],[data-tab],[data-page],.tab,.nav-item');
    if (el && !el.matches(':disabled,[aria-disabled="true"]')) send('tab_changed');
  }, true);
  document.addEventListener('change', event => {
    if (!event.isTrusted || document.hidden || !(event.target instanceof Element)) return;
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
        window.parent.postMessage({marker:usageMarker,type:'event',nonce:usageNonce,action:d.action}, window.location.origin);
      }
    });
    window.parent.postMessage({marker:usageMarker,type:'ready'}, window.location.origin);
  })();`;
}
