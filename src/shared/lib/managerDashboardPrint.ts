import { framePrintScript } from './topDashboardContentSecurity/frame/print';
import { TOP_DASHBOARD_PRINT_MARKER, TOP_DASHBOARD_PRINT_MAX_CHARS } from './topDashboardContentSecurity/printProtocol';

/**
 * A bounded, inert replacement for the personal HTML's blank-window card print.
 * It never opens a browsing context, runs the card's scripts or relaxes sandbox.
 */
export function personalDashboardPrintAdapterScript() {
  return String.raw`(() => {
    const marker = '${TOP_DASHBOARD_PRINT_MARKER}';
    const maximum = ${TOP_DASHBOARD_PRINT_MAX_CHARS};
    const previousOpen = window.open.bind(window);
    let active = null;
    const discard = (state) => {
      if (!state) return;
      state.closed = true;
      state.html = '';
      clearTimeout(state.timer);
      if (active === state) active = null;
    };
    const fail = (state) => {
      const requestId = crypto.randomUUID();
      window.parent.postMessage({ marker, type: 'print-error', requestId }, '*');
      discard(state);
    };
    window.addEventListener('pagehide', () => discard(active));
    window.addEventListener('message', (event) => {
      if (event.source !== window.parent || !active || !event.data || event.data.marker !== marker
        || event.data.type !== 'print-finished' || event.data.requestId !== active.requestId) return;
      discard(active);
    });
    window.open = function openPersonalPrintCard(url, target, features) {
      const address = url == null ? '' : String(url);
      if ((address !== '' && address.toLowerCase() !== 'about:blank')
        || (target != null && target !== '' && target !== '_blank')) return previousOpen(url, target, features);
      // The trusted receiver independently checks source, origin and activation.
      if (!navigator.userActivation?.isActive) { fail(null); return null; }
      discard(active);
      const state = { html: '', closed: false, committed: false, requestId: null, timer: 0 };
      active = state;
      state.timer = window.setTimeout(() => discard(state), 10 * 60_000);
      const append = (parts, newline) => {
        if (state.closed || state.committed) return;
        if (newline && state.html.length >= maximum) { fail(state); return; }
        for (const part of parts) {
          const text = String(part);
          if (state.html.length + text.length + (newline ? 1 : 0) > maximum) { fail(state); return; }
          state.html += text;
        }
        if (newline) state.html += '\n';
      };
      const virtualDocument = {
        open() { if (!state.closed) { state.html = ''; state.committed = false; } return virtualDocument; },
        write(...parts) { append(parts, false); },
        writeln(...parts) { append(parts, true); },
        close() { state.committed = true; },
      };
      return {
        document: virtualDocument,
        get closed() { return state.closed; },
        focus() {},
        close() { discard(state); },
        print() {
          if (state.closed || state.requestId) return;
          try {
            if (!state.html.trim()) throw new Error('empty-print-card');
            // TEMPLATE is inert: even embedded images cannot start a load here.
            const template = document.createElement('template');
            template.innerHTML = state.html;
            const styles = Array.from(template.content.querySelectorAll('style'), (style) => style.textContent || '');
            const title = (template.content.querySelector('title')?.textContent || 'Карточка клиента').slice(0, 200);
            template.content.querySelectorAll('script,iframe,object,embed,link,base,meta,style,title,input,textarea,select').forEach((node) => node.remove());
            const html = template.innerHTML;
            if (html.length + styles.reduce((sum, style) => sum + style.length, 0) > maximum) throw new Error('print-card-size');
            state.requestId = crypto.randomUUID();
            window.parent.postMessage({ marker, type: 'print-request', requestId: state.requestId,
              html, styles, title, bodyClass: '', bodyId: '' }, '*');
            // The receiver owns its sanitized copy; do not retain source markup.
            state.html = '';
          } catch { fail(state); }
        },
      };
    };
  })();`;
}

/** Reuses the TOP sanitizer and scriptless print frame in the trusted wrapper. */
export function personalDashboardFramePrintScript() {
  return String.raw`(() => {
    const iframe = frame;
    const notice = document.getElementById('print-notice');
    const showNotice = (_kind, message) => {
      notice.textContent = message;
      notice.hidden = false;
    };
    window.addEventListener('message', (event) => {
      if (event.source === iframe.contentWindow && event.origin === 'null'
        && event.data?.marker === '${TOP_DASHBOARD_PRINT_MARKER}' && event.data.type === 'print-request') notice.hidden = true;
    });
    ${framePrintScript()}
  })();`;
}
