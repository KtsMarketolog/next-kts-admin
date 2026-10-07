/** Synthetic browser acceptance only; never requests production or external data. */
import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { compile } from 'sass';

async function main() {
  const root = path.resolve('.');
  const require = createRequire(path.join(root, 'package.json'));
  let modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
  if (!modulePath) {
    try { modulePath = path.dirname(require.resolve('playwright/package.json')); }
    catch { modulePath = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
  }
  const playwright = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href);
  const screenshots = await mkdtemp('/private/tmp/kts-paired-dashboard-ui-');
  const css: string[] = [];
  const bundle = await build({
    absWorkingDir:root, stdin:{resolveDir:root, loader:'tsx', contents:`
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {DashboardPair} from './src/features/admin/dashboard-pair/DashboardPair';
      let pair=null; window.calls=[]; window.revoked=false;
      const options=[{key:'top:1',title:'Первый отчёт'},{key:'top:2',title:'Второй отчёт'}];
      window.fetch=async(url,init={})=>{
        if(url==='/api/admin/dashboard-usage')return Response.json({ok:true});
        if(url!=='/api/admin/dashboard-pair')throw Error('Unexpected URL '+url);
        if(init.method==='PUT'){pair={...JSON.parse(init.body),revision:1};window.calls.push(pair);return Response.json({ok:true});}
        const admin=!new URLSearchParams(location.search).has('viewer');
        if(!admin&&!pair)pair={keys:['top:1','top:2'],layout:'columns',revision:1};
        return Response.json({configured:!!pair,canConfigure:admin,layout:pair?.layout??'columns',revision:pair?.revision??0,
          ...(admin?{settings:pair,options}:{}),panels:pair?pair.keys.map((key,index)=>window.revoked&&index===1
            ?{key:'restricted:1',title:'Отчёт недоступен',available:false,message:'Для этого отчёта администратор должен предоставить доступ.'}
            :{key,title:options[index].title,available:true,kind:'top',versionId:1}):[]});
      };
      createRoot(document.getElementById('root')).render(<DashboardPair/>);
    `}, bundle:true, write:false, platform:'browser', format:'iife', jsx:'automatic',
    define:{'process.env.NODE_ENV':'"test"'}, alias:{'@':path.join(root,'src')},
    plugins:[{name:'fixture-ui',setup(plugin){
      plugin.onResolve({filter:/^next\/link$/},()=>({path:'next-link',namespace:'fixture'}));
      plugin.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:"import React from 'react'; export default function Link(props){return <a {...props}/>}",loader:'jsx',resolveDir:root}));
      plugin.onLoad({filter:/\.module\.scss$/},(args)=>{
        const styles=compile(args.path,{importers:[{findFileUrl(url){return url.startsWith('@/')?pathToFileURL(path.join(root,'src',url.slice(2))):null;}}]}).css;
        const prefix=`fixture${css.length}_`;
        const names=[...new Set([...styles.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match)=>match[1]))];
        css.push(styles.replace(/\.([a-zA-Z_][\w-]*)/g,(_,name)=>`.${prefix}${name}`));
        return {contents:`export default ${JSON.stringify(Object.fromEntries(names.map((name)=>[name,prefix+name])))};`,loader:'js'};
      });
    }}],
  });
  const server=createServer((req,res)=>{
    const url=new URL(req.url??'/', 'http://127.0.0.1');
    if(url.pathname==='/')res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end('<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/app.js"></script></html>');
    else if(url.pathname==='/app.js')res.writeHead(200,{'Content-Type':'text/javascript'}).end(bundle.outputFiles[0].contents);
    else if(url.pathname==='/style.css')res.writeHead(200,{'Content-Type':'text/css'}).end('body{margin:0;font:16px Arial}*{box-sizing:border-box}'+css.join('\n'));
    else if(url.pathname.endsWith('/frame'))res.writeHead(200,{'Content-Type':'text/html'}).end('<!doctype html><p>Синтетический отчёт</p>');
    else res.writeHead(404).end();
  });
  let count=0;
  try {
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address(); assert.ok(address&&typeof address!=='string');
    const origin=`http://127.0.0.1:${address.port}`;
    for(const name of ['chromium','webkit']){
      const engine=playwright[name]; try{await access(engine.executablePath());}catch{continue;}
      const browser=await engine.launch({headless:true});
      try {
        const context=await browser.newContext({viewport:{width:1440,height:1100}});
        await context.route('**/*',(route:{request():{url():string};continue():Promise<void>;abort():Promise<void>})=>route.request().url().startsWith(origin)?route.continue():route.abort());
        const page=await context.newPage(); const errors:string[]=[]; page.on('pageerror',(error:Error)=>errors.push(error.message));
        await page.goto(origin); await page.getByText('Пара отчётов ещё не назначена').waitFor();
        assert.equal(await page.locator('iframe').count(),0);
        await page.getByLabel('Первый отчёт',{exact:true}).selectOption('top:1');
        await page.getByLabel('Второй отчёт',{exact:true}).selectOption('top:1');
        assert.equal(await page.getByRole('button',{name:'Сохранить фиксированную пару'}).isDisabled(),true);
        await page.getByLabel('Второй отчёт',{exact:true}).selectOption('top:2');
        await page.getByRole('button',{name:'Сохранить фиксированную пару'}).click();
        await page.waitForFunction(()=>document.querySelectorAll('iframe').length===2);
        await page.getByRole('button',{name:'Друг под другом',exact:true}).click();
        assert.equal(await page.locator('[data-layout]').getAttribute('data-layout'),'rows');
        await page.getByRole('button',{name:'Рядом',exact:true}).click();
        await page.screenshot({path:path.join(screenshots,`${name}-pair.png`),fullPage:true});
        await page.setViewportSize({width:390,height:900});
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
        await page.goto(`${origin}/?viewer=1`);
        await page.waitForFunction(()=>document.querySelectorAll('iframe').length===2);
        assert.equal(await page.getByText('Настройка пары — только для администратора').count(),0);
        await page.evaluate(()=>{(window as unknown as {revoked:boolean}).revoked=true;});
        await page.getByRole('button',{name:'Обновить',exact:true}).click();
        await page.getByRole('heading',{name:'Отчёт недоступен'}).waitFor();
        assert.equal(await page.locator('iframe').count(),1);
        assert.equal(await page.getByRole('heading',{name:'Второй отчёт'}).count(),0);
        assert.deepEqual(errors,[]); await context.close(); count++;
      } finally {await browser.close();}
    }
    assert.ok(count>0,'No browser engines available');
    console.log(`Paired report UI passed in ${count} engines. Screenshots: ${screenshots}`);
  } finally {await new Promise<void>((resolve)=>server.close(()=>resolve()));}
}
void main().catch((error)=>{console.error(error);process.exitCode=1;});
