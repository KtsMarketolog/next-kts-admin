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
    #tvbox[hidden]{display:none!important}
    #tvbox:not([hidden]){display:block!important;position:fixed!important;inset:0!important;width:100%!important;height:100%!important;overflow:auto!important;margin:0!important;border:0!important;border-radius:0!important;z-index:1000!important}
    #tvbox > .tv-bar,#tvbox > .tvbar{display:none!important}
    #kts-office-notice{padding:24px;font:16px/1.5 Arial,sans-serif;color:#252334;background:white}
  </style><script data-kts-office-view>(()=>{
    'use strict';
    const loadingMessage='Загружаем сохранённые данные для экрана офиса…';
    const unsupportedMessage='Эта версия HTML не поддерживает встроенный «Экран для офиса». Обновите HTML аналитики продаж.';
    const openErrorMessage='Не удалось открыть «Экран для офиса». Проверьте опубликованный HTML и снимок аналитики продаж.';
    let notice, timeout, openTimer, restored=false, activeRestoreId=null, failure=null;
    function hideOffice(){
      const box=document.getElementById('tvbox');
      if(box)box.hidden=true;
      if(typeof window.tvEsc==='function')document.removeEventListener('keydown',window.tvEsc);
    }
    function showNotice(message){
      if(!notice)return;
      notice.hidden=false;
      notice.textContent=message;
    }
    function fail(message){
      restored=false;
      failure=message;
      clearTimeout(timeout);
      clearTimeout(openTimer);
      hideOffice();
      showNotice(message);
    }
    function waitForRestore(){
      clearTimeout(timeout);
      clearTimeout(openTimer);
      hideOffice();
      if(!notice)return;
      if(!${supported}){fail(unsupportedMessage);return;}
      showNotice(loadingMessage);
      timeout=setTimeout(()=>fail('Данные для экрана офиса не загружены. Проверьте текущий снимок в «Аналитике продаж».'),120000);
    }
    function matchesRestore(event){
      return activeRestoreId===null || (event.detail && event.detail.restoreId===activeRestoreId);
    }
    function openOffice(){
      if (!notice) return;
      if (!${supported} || typeof window.openTv !== 'function' || typeof window.renderTv !== 'function') {
        fail(unsupportedMessage);
        return;
      }
      if (!restored) return;
      try {
        window.openTv();
        const box=document.getElementById('tvbox');
        if (!box || box.hidden || !box.querySelector('#tv-body')) {fail(openErrorMessage);return;}
        if (typeof window.tvEsc === 'function') document.removeEventListener('keydown',window.tvEsc);
        notice.hidden=true;
        clearTimeout(timeout);
      } catch {
        fail(openErrorMessage);
      }
    }
    function start(){
      clearTimeout(openTimer);
      notice=document.createElement('p');notice.id='kts-office-notice';notice.setAttribute('role','status');
      document.body.appendChild(notice);
      if(failure){fail(failure);return;}
      if(restored)openOffice();else{waitForRestore();openOffice();}
    }
    window.addEventListener('kts-top-dashboard-restore-start',(event)=>{
      const id=event.detail && event.detail.restoreId;
      if(!Number.isSafeInteger(id)||id<=0||(activeRestoreId!==null&&id<=activeRestoreId))return;
      activeRestoreId=id;
      restored=false;
      failure=null;
      waitForRestore();
    });
    window.addEventListener('kts-top-dashboard-data-ready',(event)=>{
      if(failure||!matchesRestore(event))return;
      restored=true;
      failure=null;
      clearTimeout(timeout);
      clearTimeout(openTimer);
      openTimer=setTimeout(openOffice,0);
    });
    window.addEventListener('kts-top-dashboard-data-error',(event)=>{
      if(!matchesRestore(event))return;
      fail('Не удалось загрузить данные для экрана офиса. Проверьте текущий снимок в «Аналитике продаж».');
    });
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
  })();</script>`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) { const index = head.index + head[0].length; return html.slice(0,index) + adapter + html.slice(index); }
  return adapter + html;
}
