import { TOP_DASHBOARD_PRINT_MARKER, TOP_DASHBOARD_PRINT_MAX_CHARS } from '../printProtocol';

/** Runs only in the trusted wrapper, never in uploaded HTML. */
export function framePrintScript() {
  return String.raw`
  (() => {
    const PRINT_MARKER = '${TOP_DASHBOARD_PRINT_MARKER}';
    const PRINT_LIMIT = ${TOP_DASHBOARD_PRINT_MAX_CHARS};
    const allowedTags = new Set('DIV SPAN P BR HR H1 H2 H3 H4 H5 H6 TABLE THEAD TBODY TFOOT TR TH TD CAPTION COLGROUP COL B STRONG I EM SMALL UL OL LI DL DT DD SECTION ARTICLE HEADER FOOTER MAIN ASIDE ADDRESS BLOCKQUOTE PRE CODE SUP SUB IMG A LABEL'.split(' '));
    const allowedAttributes = new Set(['id', 'class', 'style', 'hidden', 'colspan', 'rowspan', 'width', 'height', 'align', 'valign', 'dir', 'lang', 'title', 'alt']);
    let activePrint = null;
    let lastPrintAt = 0;
    const acknowledge = (source, requestId) => {
      source.postMessage({ marker: PRINT_MARKER, type: 'print-finished', requestId }, '*');
    };
    function stopPrint() {
      if (!activePrint) return;
      const pending = activePrint;
      activePrint = null;
      clearTimeout(pending.timer);
      pending.frame.remove();
      acknowledge(pending.source, pending.requestId);
    }
    window.addEventListener('pagehide', stopPrint);
    window.addEventListener('message', (event) => {
      if (!(iframe instanceof HTMLIFrameElement) || event.source !== iframe.contentWindow || event.origin !== 'null') return;
      const data = event.data;
      if (!data || data.marker !== PRINT_MARKER || !['print-request', 'print-error'].includes(data.type)) return;
      const requestId = data.requestId;
      if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(requestId)) return;
      const reject = (message) => {
        showNotice('error', message, false);
        acknowledge(event.source, requestId);
      };
      if (!navigator.userActivation?.isActive) {
        reject('Чтобы открыть печать, нажмите кнопку печати в отчёте ещё раз.');
        return;
      }
      if (Date.now() - lastPrintAt < 1000) {
        reject('Окно печати уже открывается. Закройте его перед повторной печатью.');
        return;
      }
      if (data.type === 'print-error' || typeof data.html !== 'string' || !Array.isArray(data.styles)
        || data.styles.length > 100 || data.styles.some((style) => typeof style !== 'string')
        || data.html.length + data.styles.reduce((sum, style) => sum + style.length, 0) > PRINT_LIMIT) {
        reject('Не удалось подготовить страницу печати. Попробуйте печатать меньше счетов за один раз.');
        return;
      }
      // Safari may never emit afterprint for this scriptless document. Retain
      // it while its native dialog could be open; replace only on another
      // gesture-backed request, rather than removing an ongoing print job on
      // a short timer. The old acknowledgement cannot clear the new sheet.
      if (activePrint) stopPrint();
      try {
        // Template contents are inert, including image loads. Do not parse the
        // untrusted document into a live same-origin browsing context.
        const template = document.createElement('template');
        template.innerHTML = data.html;
        const nodes = template.content.querySelectorAll('*');
        if (nodes.length > 50000) throw new Error('print-complexity');
        for (const node of nodes) {
          if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !allowedTags.has(node.tagName)) {
            node.remove();
            continue;
          }
          for (const attribute of Array.from(node.attributes)) {
            const safeImage = node.tagName === 'IMG' && attribute.name === 'src'
              && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-zA-Z0-9+/=\s]+$/.test(attribute.value);
            if (!allowedAttributes.has(attribute.name) && !safeImage) node.removeAttribute(attribute.name);
          }
        }
        const printFrame = document.createElement('iframe');
        printFrame.id = 'dashboard-print-frame';
        printFrame.title = 'Печать отчёта';
        // No scripts, popups, forms or top navigation. The author frame retains
        // its opaque origin and never receives allow-modals/allow-same-origin.
        printFrame.setAttribute('sandbox', 'allow-same-origin allow-modals');
        printFrame.style.cssText = 'position:fixed;width:1px;height:1px;bottom:0;left:0;border:0;opacity:0;pointer-events:none';
        const doc = document.implementation.createHTMLDocument(typeof data.title === 'string' ? data.title.slice(0, 200) : 'Печать отчёта');
        const csp = doc.createElement('meta');
        csp.httpEquiv = 'Content-Security-Policy';
        csp.content = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
        doc.head.prepend(csp);
        for (const css of data.styles) {
          const style = doc.createElement('style');
          // Raw-text STYLE serialization must not turn a CSS string containing
          // </style> into HTML when srcdoc is subsequently parsed.
          style.textContent = css.replace(/</g, '\\3c ');
          doc.head.appendChild(style);
        }
        if (typeof data.bodyClass === 'string') doc.body.className = data.bodyClass.slice(0, 2000);
        if (typeof data.bodyId === 'string') doc.body.id = data.bodyId.slice(0, 200);
        doc.body.appendChild(doc.importNode(template.content, true));
        printFrame.srcdoc = '<!doctype html>' + doc.documentElement.outerHTML;
        activePrint = { frame: printFrame, source: event.source, requestId, timer: setTimeout(stopPrint, 10 * 60_000) };
        lastPrintAt = Date.now();
        printFrame.onload = () => {
          try {
            const printWindow = printFrame.contentWindow;
            if (!printWindow || activePrint?.frame !== printFrame) return;
            printWindow.addEventListener('afterprint', () => window.setTimeout(() => {
              if (activePrint?.frame === printFrame) stopPrint();
            }, 1000), { once: true });
            // Let layout settle before invoking the browser's own print dialog.
            requestAnimationFrame(() => requestAnimationFrame(() => {
              if (activePrint?.frame !== printFrame) return;
              try { printWindow.focus(); printWindow.print(); }
              catch { stopPrint(); showNotice('error', 'Браузер не открыл печать. Нажмите кнопку печати ещё раз.', false); }
            }));
          } catch {
            stopPrint();
            showNotice('error', 'Не удалось открыть окно печати.', false);
          }
        };
        document.body.appendChild(printFrame);
      } catch {
        stopPrint();
        reject('Не удалось подготовить страницу печати. Попробуйте печатать меньше счетов за один раз.');
      }
    });
  })();
`;
}
