import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req=createRequire(`${root}/package.json`);
const {build}=req('esbuild');
const sass=req('sass');
const {chromium,webkit}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out=await fs.mkdtemp('/private/tmp/kts-analog-ui.');
await build({stdin:{contents:`export * from '${root}/src/shared/lib/analogs.ts';`,resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:`${out}/engine.mjs`,tsconfig:`${root}/tsconfig.json`});
const engine=await import(pathToFileURL(`${out}/engine.mjs`));
await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {AnalogFinder} from '${root}/src/features/analogs/AnalogFinder.tsx';createRoot(document.getElementById('root')).render(<AnalogFinder/>);`,resolveDir:root,loader:'tsx'},bundle:true,platform:'browser',format:'esm',outfile:`${out}/ui.js`,jsx:'automatic',tsconfig:`${root}/tsconfig.json`,plugins:[{name:'scss',setup(b){b.onLoad({filter:/\.scss$/},args=>({contents:sass.compile(args.path,{importers:[{findFileUrl(url){return url.startsWith('@/')?pathToFileURL(`${root}/src/${url.slice(2)}`):null;}}]}).css,loader:'local-css'}));}}]});
const stock=(row,id)=>({productId:id,title:`${row.model} — тестовое наименование для печати`,sku:`TEST-${id}`,model:row.model,stock:id%2?11:0,stockMoscow:id%2?3:0,stockVolzhsk:id%2?8:0,unit:'шт.',isExpected:false});
const candidates=engine.getSanhuaKnowledgeCandidates().map((row,i)=>({...row,catalogMatches:[stock(row,i+1)]}));
let failNext=false;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/analogs/sanhua'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({candidates}));return;}
  if(url.pathname==='/api/analogs/search'){
    res.setHeader('Content-Type','application/json');
    if(failNext){failNext=false;res.statusCode=503;res.end(JSON.stringify({error:'Не удалось проверить актуальный каталог и остатки. Повторите поиск позже.'}));return;}
    const p=engine.searchAnalogs(url.searchParams.get('q')??'', url.searchParams.get('refrigerant'), url.searchParams.get('sourceBrand'));
    const results=p.results.filter(r=>/^Sanhua/.test(r.brand)).map((r,i)=>({...r,catalogMatches:[stock(r,i+1),stock(r,i+2)],stock:null}));
    res.end(JSON.stringify({...p,results,total:results.length}));return;
  }
  if(url.pathname==='/ui.js'||url.pathname==='/ui.css'){res.setHeader('Content-Type',url.pathname.endsWith('css')?'text/css':'text/javascript');res.end(await fs.readFile(`${out}${url.pathname}`));return;}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/ui.css"><style>*{box-sizing:border-box}body{margin:0;background:#f4f5f8;font-family:Arial,sans-serif}#root{max-width:1420px;margin:30px auto;padding:20px}button,input,select{font:inherit}</style></head><body><main id="root"></main><script type="module" src="/ui.js"></script></body></html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
try{
for(const [name,type] of [['chromium',chromium],['webkit',webkit]]){
 const browser=await type.launch({headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${port}`);
 await page.getByRole('searchbox').fill('NRV 6s');
 await page.getByRole('button',{name:'Найти аналоги',exact:true}).click();
 await page.getByRole('button',{name:'Danfoss NRV 6s',exact:true}).click();
 await page.getByText('В каталоге КТС',{exact:true}).first().waitFor();
 if(await page.getByText('TEST-1',{exact:false}).count()===0)throw new Error('Missing distinct catalogue SKU');
 await page.screenshot({path:`${out}/${name}-search.png`,fullPage:true});
 await page.getByRole('button',{name:'Подбор Sanhua',exact:true}).click();
 await page.getByLabel('1. Тип изделия').selectOption('check-valves');
 await page.getByText('Позиций по таблице:',{exact:false}).waitFor();
 await page.locator('summary').filter({hasText:'Что дополнить техническому специалисту'}).click();
 await page.getByText('Фильтры разборные',{exact:true}).waitFor();
 await page.screenshot({path:`${out}/${name}-sanhua.png`,fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('heading',{name:'От модели к проверке параметров'}).scrollIntoViewIfNeeded();
 await page.screenshot({path:`${out}/${name}-mobile.png`,fullPage:false});
 const headingSize=await page.getByRole('heading',{name:'От модели к проверке параметров'}).evaluate(el=>parseFloat(getComputedStyle(el).fontSize));
 assert.ok(headingSize>=20, 'Mobile heading must remain legible');
 const sizeOptions=await page.getByLabel('Размер присоединения').locator('option').count();
 assert.ok(sizeOptions>1, await page.getByLabel('Размер присоединения').evaluate(el=>el.outerHTML));
 await page.getByLabel('Размер присоединения').selectOption({index:1});
 await page.getByRole('button',{name:'Посмотреть связи этой модели'}).first().click();
 await page.getByText('Найдена исходная позиция',{exact:true}).waitFor();
 const sizes=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:window.innerWidth}));
 if(sizes.scroll>sizes.width+1)throw new Error(`Mobile horizontal overflow ${JSON.stringify(sizes)}`);
 await page.getByRole('button',{name:'Поиск аналогов',exact:true}).click();
 failNext=true;
 await page.getByRole('button',{name:'Найти аналоги',exact:true}).click();
 await page.getByText('Не удалось проверить актуальный каталог и остатки. Повторите поиск позже.',{exact:true}).waitFor();
 if(await page.getByRole('button',{name:'Найти аналоги',exact:true}).isDisabled())throw new Error('Button stuck after error');
 if(errors.length)throw new Error(errors.join('\n'));
 console.log(JSON.stringify({browser:name,passed:true,sizes,candidates:candidates.length,output:out}));
 }finally{await browser.close();}
}
}finally{await new Promise(resolve=>server.close(resolve));}
