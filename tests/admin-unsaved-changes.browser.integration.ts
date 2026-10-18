/** Browser acceptance of the real hook; synthetic forms and Next history state only. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const fixture = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useAdminUnsavedChanges} from './src/features/admin/model/useAdminUnsavedChanges';
window.prompts=0;window.answer=false;window.restores=[];window.explicit=0;
window.confirm=()=>{window.prompts++;return window.answer;};
const tree={tree:['',{'children':['admin',{'children':['site',{}]}]}],cache:'synthetic-preserved'};
history.replaceState({__NA:true,__PRIVATE_NEXTJS_INTERNALS_TREE:{prior:true},custom:'prior'},'','/admin');
history.pushState({__NA:true,__PRIVATE_NEXTJS_INTERNALS_TREE:tree,custom:'editor'},'','/admin/site?section=info');
// Match the installed App Router's bubble-listener ordering: the framework
// listener is registered first and restores from __NA / private router state.
window.addEventListener('popstate',event=>{
 if(!event.state?.__NA)throw new Error('Next history state lost');
 window.restores.push({url:location.href,state:event.state});
 window.dispatchEvent(new Event('fixture-router'));
});
function App(){
 const[draft,setDraft]=useState(''),[url,setUrl]=useState(location.href),[mounted,setMounted]=useState(true);
 React.useEffect(()=>{const listener=()=>setUrl(location.href);window.addEventListener('fixture-router',listener);return()=>window.removeEventListener('fixture-router',listener);},[]);
 return <><output id="rendered-url">{url}</output><button id="unmount" onClick={()=>setMounted(false)}>Unmount</button>{mounted&&<Editor draft={draft} setDraft={setDraft}/>}</>;
}
function Editor({draft,setDraft}){
 const{confirmLeave}=useAdminUnsavedChanges(Boolean(draft));
 const go=(path)=>{history.pushState({...history.state,custom:'destination'},'',path);window.dispatchEvent(new Event('fixture-router'));};
 const link=event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey){event.preventDefault();return;}event.preventDefault();go(event.currentTarget.href);};
 return <><input aria-label="Draft" value={draft} onChange={event=>setDraft(event.target.value)}/>
 <a id="header-link" href="/catalog" onClick={link}>Catalog</a>
 <a id="query-link" href="/admin/site?section=news" onClick={event=>{event.preventDefault();history.replaceState({...history.state,custom:'new-section'},'',event.currentTarget.href);window.dispatchEvent(new Event('fixture-router'));}}>News</a>
 <a id="blank-link" href="/catalog" target="_blank" onClick={event=>event.preventDefault()}>New tab</a>
 <a id="download-link" href="/file.pdf" download onClick={event=>event.preventDefault()}>Download</a>
 <button id="explicit" onClick={()=>{if(confirmLeave())window.explicit++;}}>Explicit action</button>
 <button id="clean" onClick={()=>setDraft('')}>Saved</button>
 <button id="query-push" onClick={()=>{history.pushState({...history.state},'','/admin/site?section=slider');window.dispatchEvent(new Event('fixture-router'));}}>Query push</button>
 <button id="seed-known" onClick={()=>{history.pushState({...history.state},'','/catalog');history.pushState({...history.state},'','/admin/site?section=info');window.dispatchEvent(new Event('fixture-router'));}}>Seed indexed history</button>
 </>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);
`;

async function main() {
  const root = path.resolve('.');
  const require = createRequire(path.join(root, 'package.json'));
  let modulePath = process.env.PLAYWRIGHT_MODULE_PATH;
  if (!modulePath) {
    try { modulePath = path.dirname(require.resolve('playwright/package.json')); }
    catch { modulePath = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
  }
  const playwright = await import(pathToFileURL(path.join(modulePath, 'index.mjs')).href);
  const bundle = await build({ absWorkingDir: root, stdin: { contents: fixture, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' },
  });
  const server = createServer((request, response) => {
    if (request.url === '/app.js') response.writeHead(200, { 'content-type': 'text/javascript' }).end(bundle.outputFiles[0].contents);
    else response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="ru"><meta charset="utf-8"><div id="root"></div><script src="/app.js"></script></html>');
  });
  let count = 0;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    for (const engine of process.env.KTS_GUARD_ENGINES?.split(',') ?? ['chromium', 'webkit']) {
      const browser = await playwright[engine].launch({ headless: true });
      try {
        for (const scenario of process.env.KTS_GUARD_CASES?.split(',') ?? ['anchor-reject', 'anchor-accept', 'explicit', 'section-query', 'modifiers', 'browser-back-unchanged', 'browser-forward-unchanged', 'query-back', 'saved-back', 'reload', 'cleanup']) {
          const page = await browser.newPage();
          page.setDefaultTimeout(5000);
          const errors: string[] = [];
          page.on('pageerror', (error: Error) => errors.push(error.message));
          await page.route('**/*', (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => route.request().url().startsWith(origin) ? route.continue() : route.abort());
          await page.goto(origin);
          await page.getByRole('textbox', { name: 'Draft' }).waitFor();
          const initialLength = await page.evaluate(() => history.length);
          const originalState = await page.evaluate(() => history.state);
          assert.equal(originalState.__NA, true);
          assert.equal(originalState.__PRIVATE_NEXTJS_INTERNALS_TREE.cache, 'synthetic-preserved');
          await page.getByRole('textbox', { name: 'Draft' }).fill('Keep these unsaved changes');
          const siteUrl = `${origin}/admin/site?section=info`;
          const state = async () => page.evaluate(() => ({ prompts: (window as unknown as { prompts: number }).prompts, restores: (window as unknown as { restores: unknown[] }).restores, url: location.href, historyState: history.state, length: history.length }));
          const answer = (value: boolean) => page.evaluate((next: boolean) => { (window as unknown as { answer: boolean }).answer = next; }, value);
          const waitUrl = async (url: string) => page.waitForFunction((expected: string) => location.href === expected, url);
          if (scenario === 'anchor-reject') {
            await page.locator('#header-link').click();
            assert.equal((await state()).prompts, 1);
            assert.equal((await state()).url, siteUrl);
            assert.equal(await page.locator('#rendered-url').textContent(), siteUrl);
          } else if (scenario === 'anchor-accept') {
            await answer(true);
            await page.locator('#header-link').click();
            await waitUrl(`${origin}/catalog`);
            assert.equal((await state()).prompts, 1);
          } else if (scenario === 'explicit') {
            await page.locator('#explicit').click();
            assert.equal(await page.evaluate(() => (window as unknown as { explicit: number }).explicit), 0);
            await answer(true);
            await page.locator('#explicit').click();
            assert.equal(await page.evaluate(() => (window as unknown as { explicit: number }).explicit), 1);
          } else if (scenario === 'section-query') {
            await page.locator('#query-link').click();
            assert.equal((await state()).url, `${origin}/admin/site?section=news`);
            assert.equal((await state()).prompts, 0);
            assert.equal((await state()).historyState.custom, 'new-section');
            assert.deepEqual((await state()).historyState.__PRIVATE_NEXTJS_INTERNALS_TREE, originalState.__PRIVATE_NEXTJS_INTERNALS_TREE);
            assert.equal((await state()).length, initialLength);
          } else if (scenario === 'modifiers') {
            await page.locator('#header-link').dispatchEvent('click', { ctrlKey: true, button: 0 });
            await page.locator('#blank-link').click();
            await page.locator('#download-link').click();
            assert.equal((await state()).prompts, 0);
          } else if (scenario === 'browser-back-unchanged') {
            await page.evaluate(() => history.back());
            await waitUrl(`${origin}/admin`);
            await page.waitForFunction(() => (window as unknown as { restores: unknown[] }).restores.length === 1);
            assert.equal((await state()).prompts, 0, 'Back is not intercepted; the draft workspace owns SPA retention');
            assert.equal((await state()).historyState.custom, 'prior');
            assert.equal((await state()).length, initialLength);
          } else if (scenario === 'browser-forward-unchanged') {
            await page.locator('#seed-known').click();
            await page.locator('#clean').click();
            await page.evaluate(() => history.go(-2));
            await waitUrl(siteUrl);
            await page.waitForFunction(() => (window as unknown as { restores: unknown[] }).restores.length === 1);
            await page.getByRole('textbox', { name: 'Draft' }).fill('Keep these unsaved changes');
            await page.evaluate(() => history.forward());
            await waitUrl(`${origin}/catalog`);
            await page.waitForFunction(() => (window as unknown as { restores: unknown[] }).restores.length === 2);
            assert.equal((await state()).prompts, 0);
            assert.deepEqual((await state()).historyState.__PRIVATE_NEXTJS_INTERNALS_TREE, originalState.__PRIVATE_NEXTJS_INTERNALS_TREE);
          } else if (scenario === 'query-back') {
            await page.locator('#query-push').click();
            await page.evaluate(() => history.back());
            await waitUrl(siteUrl);
            assert.equal((await state()).prompts, 0);
          } else if (scenario === 'saved-back') {
            await page.locator('#clean').click();
            await page.evaluate(() => history.back());
            await waitUrl(`${origin}/admin`);
            assert.equal((await state()).prompts, 0);
            assert.equal((await state()).length, initialLength);
          } else if (scenario === 'reload') {
            let nativePrompts = 0;
            page.on('dialog', (dialog: { type(): string; dismiss(): Promise<void> }) => { assert.equal(dialog.type(), 'beforeunload'); nativePrompts++; void dialog.dismiss(); });
            await page.reload({ timeout: 1500 }).catch(() => {});
            assert.equal(nativePrompts, 1);
            assert.equal((await state()).url, siteUrl);
          } else if (scenario === 'cleanup') {
            await page.locator('#unmount').click();
            const blocked = await page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
            assert.equal(blocked, false);
            await page.evaluate(() => history.back());
            await waitUrl(`${origin}/admin`);
            assert.equal((await state()).prompts, 0);
          }
          if (!['saved-back', 'cleanup'].includes(scenario)) assert.equal(await page.getByRole('textbox', { name: 'Draft' }).inputValue(), 'Keep these unsaved changes');
          assert.deepEqual(errors, []);
          console.log(`PASS ${engine}/${scenario}`);
          await page.close({ runBeforeUnload: false });
          count++;
        }
      } finally { await browser.close(); }
    }
    console.log(`Unsaved changes guard acceptance passed: ${count} browser cases`);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
