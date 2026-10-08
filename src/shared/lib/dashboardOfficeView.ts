/** Known sales HTML's in-page office view. Never opens a popup or crosses the sandbox. */
export function supportsSalesOfficeView(html: string) {
  return /\bfunction\s+openTv\s*\(/.test(html)
    && /\bfunction\s+renderTv\s*\(/.test(html)
    && /\bid\s*=\s*["']tvbox["']/.test(html)
    && /Экран\s+для\s+офиса/iu.test(html);
}

export function injectSalesOfficeView(html: string) {
  const supported = supportsSalesOfficeView(html);
  const adapter = `<style data-kts-office-view>
    body{margin:0!important;overflow:auto!important}
    body > :not(#tvbox):not(#kts-office-notice){display:none!important}
    #tvbox:not([hidden]){display:block!important;position:fixed!important;inset:0!important;width:100%!important;height:100%!important;overflow:auto!important;margin:0!important;border:0!important;border-radius:0!important;z-index:1000!important}
    #tvbox > .tv-bar{display:none!important}
    #kts-office-notice{padding:24px;font:16px/1.5 Arial,sans-serif;color:#252334;background:white}
  </style><script data-kts-office-view>(()=>{
    'use strict';
    let notice, timeout, restored=false;
    function openOffice(){
      if (!notice) return;
      if (!${supported} || typeof window.openTv !== 'function' || typeof window.renderTv !== 'function') {
        clearTimeout(timeout);
        notice.textContent='Эта версия HTML не поддерживает встроенный «Экран для офиса». Обновите HTML аналитики продаж.';
        return;
      }
      if (!restored) return;
      try {
        window.openTv();
        const box=document.getElementById('tvbox');
        if (!box || box.hidden || !box.querySelector('#tv-body')) return;
        if (typeof window.tvEsc === 'function') document.removeEventListener('keydown',window.tvEsc);
        notice.hidden=true;
        clearTimeout(timeout);
      } catch {
        clearTimeout(timeout);
        notice.hidden=false;
        notice.textContent='Не удалось открыть «Экран для офиса». Проверьте опубликованный HTML и снимок аналитики продаж.';
      }
    }
    function start(){
      notice=document.createElement('p');notice.id='kts-office-notice';notice.setAttribute('role','status');
      notice.textContent='Загружаем сохранённые данные для экрана офиса…';document.body.appendChild(notice);
      timeout=setTimeout(()=>{if(!notice.hidden)notice.textContent='Данные для экрана офиса не загружены. Проверьте текущий снимок в «Аналитике продаж».';},120000);
      openOffice();
    }
    window.addEventListener('kts-top-dashboard-data-ready',()=>{restored=true;setTimeout(openOffice,0);});
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
  })();</script>`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) { const index = head.index + head[0].length; return html.slice(0,index) + adapter + html.slice(index); }
  return adapter + html;
}
