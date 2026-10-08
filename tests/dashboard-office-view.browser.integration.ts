/** Synthetic office-subview acceptance; no customer data or external requests. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { injectSalesOfficeView } from '../src/shared/lib/dashboardOfficeView';
import { buildTopDashboardContentSecurityPolicy } from '../src/shared/lib/topDashboardContentSecurity';

const original = `<!doctype html><html><head><title>Аналитика продаж</title></head><body>
<nav>Обычная навигация</nav><main>Полный отчёт</main><div id="tvbox" hidden></div><script>
let loaded=false, revision=0;
function tvEsc(event){if(event.key==='Escape')document.getElementById('tvbox').hidden=true;}
function renderTv(){document.getElementById('tv-body').textContent='Рейтинг сотрудников — снимок '+revision;}
function openTv(){if(!loaded)return;const box=document.getElementById('tvbox');box.innerHTML='<div class="tv-bar"><button>Закрыть</button></div><div id="tv-body"></div>';box.hidden=false;renderTv();document.addEventListener('keydown',tvEsc);}
// Экран для офиса
window.restore=()=>{loaded=true;revision++;window.dispatchEvent(new CustomEvent('kts-top-dashboard-data-ready'));};
</script></body></html>`;

async function main() {
  const runtime=process.env.PLAYWRIGHT_MODULE_PATH??path.join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  const playwright=await import(pathToFileURL(path.join(runtime,'index.mjs')).href);
  const server=createServer((req,res)=>{
    if(req.url==='/content'){
      const html=injectSalesOfficeView(original);
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':buildTopDashboardContentSecurityPolicy(html)}).end(html);
    }else if(req.url==='/unsupported'){
      const html=injectSalesOfficeView('<!doctype html><html><head></head><body><main>Другой отчёт</main></body></html>');
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':buildTopDashboardContentSecurityPolicy(html)}).end(html);
    }else res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end('<!doctype html><html><body><iframe title="Офис" sandbox="allow-scripts" src="/content" style="width:100%;height:700px"></iframe></body></html>');
  });
  await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
  try{
    for(const name of ['chromium','webkit']){
      const browser=await playwright[name].launch({headless:true});
      try{
        const page=await browser.newPage();const errors:string[]=[];let popups=0;
        page.on('pageerror',(error:Error)=>errors.push(error.message));page.on('popup',()=>popups++);
        await page.route('**/*',(route:{request():{url():string};continue():Promise<void>;abort():Promise<void>})=>route.request().url().startsWith(origin)?route.continue():route.abort());
        await page.goto(origin);
        const inner=page.frameLocator('iframe');
        await inner.getByText('Загружаем сохранённые данные для экрана офиса…').waitFor();
        assert.equal(await inner.locator('main').isVisible(),false);
        const content=page.frames().find((frame:{url():string})=>frame.url()===`${origin}/content`);assert.ok(content);
        await content.evaluate(()=> (window as unknown as {restore():void}).restore());
        await inner.getByText('Рейтинг сотрудников — снимок 1').waitFor();
        assert.equal(await inner.getByRole('button',{name:'Закрыть'}).isVisible(),false);
        await page.keyboard.press('Escape');assert.equal(await inner.locator('#tvbox').isVisible(),true);
        await content.evaluate(()=> (window as unknown as {restore():void}).restore());
        await inner.getByText('Рейтинг сотрудников — снимок 2').waitFor();
        assert.equal(popups,0);assert.deepEqual(errors,[]);
        await page.locator('iframe').evaluate((frame:HTMLIFrameElement)=>{frame.src='/unsupported';});
        await inner.getByText('Эта версия HTML не поддерживает встроенный «Экран для офиса». Обновите HTML аналитики продаж.').waitFor();
        assert.equal(await inner.locator('main').isVisible(),false);
        console.log(`${name}: office mode waits for data, refreshes after restore, hides report controls, fails closed for unsupported HTML`);
      }finally{await browser.close();}
    }
  }finally{await new Promise<void>((resolve)=>server.close(()=>resolve()));}
}
void main().catch((error)=>{console.error(error);process.exitCode=1;});
