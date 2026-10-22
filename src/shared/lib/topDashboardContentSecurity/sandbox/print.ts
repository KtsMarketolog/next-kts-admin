import { TOP_DASHBOARD_PRINT_MARKER, TOP_DASHBOARD_PRINT_MAX_CHARS } from '../printProtocol';

/** Only presentation leaves the opaque report; nothing is uploaded or persisted. */
export function sandboxPrintScript() {
  return String.raw`
  (() => {
    const PRINT_MARKER = '${TOP_DASHBOARD_PRINT_MARKER}';
    const PRINT_LIMIT = ${TOP_DASHBOARD_PRINT_MAX_CHARS};
    let pendingPrint = null;
    let printTimer = 0;
    let printStartedAt = 0;
    const finishPrint = () => {
      if (!pendingPrint) return;
      pendingPrint = null;
      clearTimeout(printTimer);
      window.dispatchEvent(new Event('afterprint'));
    };
    window.addEventListener('message', (event) => {
      if (event.source !== window.parent || !event.data || event.data.marker !== PRINT_MARKER
        || event.data.type !== 'print-finished' || event.data.requestId !== pendingPrint) return;
      finishPrint();
    });
    window.print = function printDashboard() {
      if (pendingPrint && Date.now() - printStartedAt < 1000) return;
      // WebKit can omit afterprint for a scriptless child. A fresh user print
      // must still work; do not dispatch afterprint here, since the author has
      // just prepared the NEW sheet and may clear it in that handler.
      clearTimeout(printTimer);
      printStartedAt = Date.now();
      pendingPrint = crypto.randomUUID();
      try {
        window.dispatchEvent(new Event('beforeprint'));
        const body = document.body.cloneNode(true);
        // In particular, never copy embedded invoice/stock JSON or library bundles.
        body.querySelectorAll('script,iframe,object,embed,link,base,meta').forEach((node) => node.remove());
        const originals = document.body.querySelectorAll('input,textarea,select');
        body.querySelectorAll('input,textarea,select').forEach((node, index) => {
          const original = originals[index];
          const text = document.createElement('span');
          if (original instanceof HTMLInputElement) {
            text.textContent = ['password', 'file', 'hidden'].includes(original.type) ? ''
              : original.type === 'checkbox' || original.type === 'radio' ? (original.checked ? '✓' : '—') : original.value;
          } else if (original instanceof HTMLSelectElement) {
            text.textContent = Array.from(original.selectedOptions, (option) => option.textContent).join(', ');
          } else if (original instanceof HTMLTextAreaElement) text.textContent = original.value;
          node.replaceWith(text);
        });
        const styles = Array.from(document.querySelectorAll('style'), (style) => style.textContent || '');
        const html = body.innerHTML;
        const title = document.title.slice(0, 200);
        if (html.length + styles.reduce((sum, style) => sum + style.length, 0) > PRINT_LIMIT) {
          throw new Error('print-size');
        }
        window.parent.postMessage({ marker: PRINT_MARKER, type: 'print-request', requestId: pendingPrint,
          html, styles, title, bodyClass: document.body.className, bodyId: document.body.id }, '*');
        printTimer = window.setTimeout(finishPrint, 10 * 60_000);
      } catch {
        window.parent.postMessage({ marker: PRINT_MARKER, type: 'print-error', requestId: pendingPrint }, '*');
        finishPrint();
      }
    };
  })();
`;
}
