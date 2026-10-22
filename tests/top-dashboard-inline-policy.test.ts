import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildTopDashboardContentSecurityPolicy } from '../src/shared/lib/topDashboardContentSecurity/policy';
import { knowledgeBaseHtmlPolicy } from '../src/shared/lib/knowledgeBaseStorage';

const hash = (source: string) => `'sha256-${createHash('sha256').update(source).digest('base64')}'`;
const scriptRule = (html: string) => buildTopDashboardContentSecurityPolicy(html).split('; ').find(rule => rule.startsWith('script-src '))!;

test('handler hashes use decoded HTML attribute values, not encoded source text', () => {
  const expected = 'window.result="Привет"';
  for (const attribute of [
    'onclick="window.result=&quot;Привет&quot;"',
    "onclick='window.result=&#34;Привет&#34;'",
    'ONCLICK="window.result=&#x22;Привет&#X22;"',
    'onclick=window.result=&#34;Привет&#34;',
  ]) assert.equal(scriptRule(`<button ${attribute}>Открыть</button>`), `script-src 'unsafe-hashes' ${hash(expected)}`);
  assert.equal(scriptRule('<button onclick=window.count++>Next</button>'), `script-src 'unsafe-hashes' ${hash('window.count++')}`);
  assert.equal(scriptRule('<button onclick="window.text=&amp;quot;literal&amp;quot;">Next</button>'),
    `script-src 'unsafe-hashes' ${hash('window.text=&quot;literal&quot;')}`, 'references decode exactly once');
});

test('HTML preprocessing happens before character-reference decoding without trimming source', () => {
  const cases = [
    ['  window.x=1\r\nwindow.y=2\r  ', '  window.x=1\nwindow.y=2\n  '],
    ['window.x=1&#13;window.y=2', 'window.x=1\rwindow.y=2'],
    ['window.x=&#0;', 'window.x=\uFFFD'],
    ['window.x=\u0000', 'window.x=\uFFFD'],
    ['window.x=&#x1F600;', 'window.x=😀'],
    ['window.x=&copycat', 'window.x=&copycat'],
  ];
  for (const [encoded, decoded] of cases) {
    assert.equal(scriptRule(`<button onclick="${encoded}">Test</button>`), `script-src 'unsafe-hashes' ${hash(decoded)}`);
  }
});

test('duplicates keep the first attribute and equivalent encodings produce one hash', () => {
  const policy = scriptRule('<button onclick="window.x=&quot;one&quot;" ONCLICK="window.x=2"></button><button onclick=window.x=&#34;one&#34;></button>');
  assert.equal(policy, `script-src 'unsafe-hashes' ${hash('window.x="one"')}`);
  assert.ok(!policy.includes(hash('window.x=2')));
});

test('fake markup in comments, raw text and other attributes never grants handler permissions', () => {
  const handler = 'window.fake=1';
  const fake = `<button onclick="${handler}"></button>`;
  for (const html of [
    `<!--${fake}-->`, `<textarea>${fake}</textarea>`, `<style>${fake}</style>`,
    `<title>${fake}</title>`, `<noscript>${fake}</noscript>`, `<xmp>${fake}</xmp>`,
    `<div data-example='${fake}'></div>`,
  ]) assert.equal(scriptRule(html), "script-src 'none'");
  const script = `const example = '${fake}';`;
  assert.equal(scriptRule(`<script>${script}</script>`), `script-src ${hash(script)}`);
});

test('scripts retain raw entities and whitespace; quoted > and escaped script text parse as the browser does', () => {
  const script = '\nwindow.x="&amp;";\nwindow.y=2;';
  assert.equal(scriptRule(`<script data-label=">">${script.replace(/\n/g, '\r\n')}</script>`), `script-src ${hash(script)}`);
  const escaped = '<!--<script>window.x=1;</script>window.y=2;-->';
  assert.equal(scriptRule(`<script>${escaped}</script>`), `script-src ${hash(escaped)}`);
  assert.equal(scriptRule('<script>window.x="\u0000";</script>'), `script-src ${hash('window.x="\uFFFD";')}`);
  assert.equal(scriptRule('<script>window.incomplete=1'), "script-src 'none'");
  assert.equal(scriptRule('<pre><script>\nwindow.x=1;</script></pre>'), `script-src ${hash('\nwindow.x=1;')}`);
});

test('real handlers inside templates remain available for author-created clones', () => {
  assert.equal(scriptRule('<template><button onclick="window.x=&quot;yes&quot;">Open</button></template>'),
    `script-src 'unsafe-hashes' ${hash('window.x="yes"')}`);
});

test('chunk boundaries preserve script surrogate pairs, CRLF and attribute references', () => {
  const prefix = '<script>window.x="';
  const script = `window.x="${'a'.repeat(16_384 - prefix.length - 1)}😀";\r\nwindow.y=1;`;
  assert.equal(scriptRule(`<script>${script}</script>`), `script-src ${hash(script.replace(/\r\n/g, '\n'))}`);
  const padding = ' '.repeat(16_384 - '<button onclick="window.x='.length - 3);
  const handler = `window.x=${padding}&quot;yes&quot;`;
  assert.equal(scriptRule(`<button onclick="${handler}"></button>`), `script-src 'unsafe-hashes' ${hash(`window.x=${padding}"yes"`)}`);
});

test('large decoded handlers survive value chunks and malformed adjacent attributes', () => {
  const padding = 'a'.repeat(70_000);
  const encoded = `window.x=&quot;${padding}😀&quot;`;
  const expected = `window.x="${padding}😀"`;
  const second = 'window.y=2';
  assert.equal(scriptRule(`<button onclick="${encoded}"onfocus="${second}">Open</button>`),
    `script-src 'unsafe-hashes' ${hash(expected)} ${hash(second)}`);
});

test('many distinct attributes stay bounded and duplicates near the end retain the first handler', { timeout: 20_000 }, () => {
  // The pinned tokenizer normally scans all previous names for each attribute.
  // This modest synthetic document must not turn into quadratic CPU work.
  const child = spawnSync(process.execPath, ['--max-old-space-size=256', '--import', 'tsx', '--input-type=module', '-e', `
    import { buildTopDashboardContentSecurityPolicy as policy } from ${JSON.stringify(new URL('../src/shared/lib/topDashboardContentSecurity/policy.ts', import.meta.url).href)};
    import { createHash } from 'node:crypto';
    import assert from 'node:assert/strict';
    const attrs = Array.from({ length: 150_000 }, (_, i) => 'data-k' + i + '=x').join(' ');
    const html = '<button onclick="window.x=&quot;first&quot;" ' + attrs
      + ' ONCLICK="window.x=2" onfocus="window.y=3" ONFOCUS="ignored()">Open</button>';
    const hash = value => "'sha256-" + createHash('sha256').update(value).digest('base64') + "'";
    const rule = policy(html).split('; ').find(value => value.startsWith('script-src '));
    assert.equal(rule, "script-src 'unsafe-hashes' " + hash('window.x="first"') + ' ' + hash('window.y=3'));
    console.log('bounded attribute-name index');
  `], { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 });
  assert.equal(child.status, 0, `${child.error?.message ?? ''}\n${child.stderr}`);
  assert.match(child.stdout, /bounded attribute-name index/);
});

test('shared fix preserves strict TOP and knowledge-base isolation', () => {
  const html = '<button onclick="window.x=&quot;ok&quot;">Open</button>';
  for (const policy of [buildTopDashboardContentSecurityPolicy(html), knowledgeBaseHtmlPolicy(html)]) {
    assert.ok(policy.includes(hash('window.x="ok"')));
    for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "object-src 'none'"]) {
      assert.ok(policy.split('; ').includes(directive));
    }
    assert.doesNotMatch(policy.split('; ').find(rule => rule.startsWith('script-src '))!, /unsafe-inline|unsafe-eval|\bhttps?:|\bblob:/);
    assert.doesNotMatch(policy, /allow-same-origin|allow-popups-to-escape-sandbox/);
  }
  assert.ok(knowledgeBaseHtmlPolicy(html).split('; ').includes('sandbox allow-scripts'));
  assert.ok(knowledgeBaseHtmlPolicy(html).includes("worker-src 'none'"));
  assert.ok(buildTopDashboardContentSecurityPolicy(html, { allowBlobModules: true }).includes('script-src blob:'));
});

for (const kind of ['script', 'attribute', 'comment']) {
  test(`large embedded ${kind} stays within a small isolated heap and preserves exact hashes`, { timeout: 45_000 }, () => {
    // No customer files. A long uninterrupted value exposes per-character rope
    // amplification that ordinary small HTML and pretty-printed JS do not.
    const child = spawnSync(process.execPath, ['--max-old-space-size=256', '--import', 'tsx', '--input-type=module', '-e', `
      import { buildTopDashboardContentSecurityPolicy as policy } from ${JSON.stringify(new URL('../src/shared/lib/topDashboardContentSecurity/policy.ts', import.meta.url).href)};
      import { createHash } from 'node:crypto';
      import assert from 'node:assert/strict';
      const value = 'A'.repeat(20 * 1024 * 1024 - 256);
      const source = 'window.large="' + value + '";';
      const kind = ${JSON.stringify(kind)};
      const html = kind === 'script' ? '<script>' + source + '</script>'
        : kind === 'attribute' ? '<img src="data:image/png;base64,' + value + '">' : '<!--' + value + '-->';
      const csp = policy(html);
      const rule = csp.split('; ').find(rule => rule.startsWith('script-src '));
      assert.equal(rule, kind === 'script' ? "script-src 'sha256-" + createHash('sha256').update(source).digest('base64') + "'" : "script-src 'none'");
      console.log('exact bounded policy');
    `], { encoding: 'utf8', timeout: 40_000, maxBuffer: 64 * 1024 });
    assert.equal(child.status, 0, `${child.error?.message ?? ''}\n${child.stderr}`);
    assert.match(child.stdout, /exact bounded policy/);
  });
}
