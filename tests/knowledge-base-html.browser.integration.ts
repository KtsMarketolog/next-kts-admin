/** Real CSP+sandbox in Chromium and WebKit; synthetic local HTML only, no production data. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { knowledgeBaseHtmlPolicy } from '../src/shared/lib/knowledgeBaseStorage';

const html = `<!doctype html><meta charset="utf-8"><title>Synthetic knowledge material</title><button id="increment" onclick="window.count++;document.querySelector('#value').textContent=String(window.count)">Increase</button><span id="value">0</span>
<img src="/leak-image"><script src="/external.js"></script><form action="/form" method="post"><input name="test" value="synthetic"></form>
<script>
window.count=0;window.security={};
try{window.security.parentCookie=parent.document.cookie}catch(e){window.security.parentBlocked=true}
try{document.cookie='untrusted=1';window.security.cookie=document.cookie}catch(e){window.security.cookieBlocked=true}
try{localStorage.setItem('untrusted','1')}catch(e){window.security.storageBlocked=true}
try{window.security.popupBlocked=window.open('/popup')===null}catch(e){window.security.popupBlocked=true}
try{document.querySelector('form').submit()}catch(e){window.security.formBlocked=true}
fetch('/api/leak',{credentials:'include'}).then(()=>window.security.fetchBlocked=false).catch(()=>window.security.fetchBlocked=true);
</script>`;

async function main() {
  const require = createRequire(path.resolve('package.json'));
  let runtime = process.env.PLAYWRIGHT_MODULE_PATH;
  if (!runtime) {
    try { runtime = path.dirname(require.resolve('playwright/package.json')); }
    catch { runtime = path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
  }
  const playwright = await import(pathToFileURL(path.join(runtime, 'index.mjs')).href);
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? '');
    if (request.url === '/material') response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': knowledgeBaseHtmlPolicy(html), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }).end(html);
    else if (request.url === '/') response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'synthetic_parent=secret; SameSite=Lax' })
      .end('<!doctype html><title>Parent</title><iframe src="/material" sandbox="allow-scripts"></iframe>');
    else response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (const engine of ['chromium', 'webkit']) {
      const browser = await playwright[engine].launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto(origin);
        await page.frameLocator('iframe').locator('#increment').click();
        const frame = page.frames().find((value: { url(): string }) => value.url() === `${origin}/material`)!;
        await frame.waitForFunction('window.security.fetchBlocked===true');
        assert.equal(await frame.locator('#value').textContent(), '1', `${engine} retains author scripts and handlers`);
        const security = await frame.evaluate('window.security');
        assert.equal(security.parentBlocked, true); assert.equal(security.cookieBlocked, true);
        assert.equal(security.storageBlocked, true); assert.equal(security.popupBlocked, true);
        assert.equal(security.fetchBlocked, true); assert.equal(await page.title(), 'Parent');
        assert.equal(await page.evaluate('localStorage.getItem("untrusted")'), null);
        assert.equal(hits.some(value => ['/api/leak', '/external.js', '/leak-image', '/popup', '/form'].includes(value)), false);
        // Even a direct navigation has opaque origin: the response header, not
        // just the parent iframe attribute, is the security boundary.
        await page.goto(`${origin}/material`);
        await page.waitForFunction('window.security.fetchBlocked===true');
        assert.equal(await page.evaluate('window.security.cookieBlocked'), true);
        await page.close();
        console.log(`PASS ${engine}: KB author behavior and HTML origin/network/form/popup isolation`);
      } finally { await browser.close(); }
    }
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
