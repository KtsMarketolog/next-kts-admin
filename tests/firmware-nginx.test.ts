import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../ops/apply-firmware-nginx-limit.sh', import.meta.url));
const config = `server {
    listen 80 default_server;
    server_name kts-impex.ru www.kts-impex.ru;
    location = /klimatika/prog/firmware/update/hse/gen_1/hse_gen_1.c23 {
        proxy_pass http://127.0.0.1:3000$request_uri;
    }
    location = /klimatika/prog/firmware/update/hse/gen_1/hse_gen_1.ver {
        proxy_pass http://127.0.0.1:3000$request_uri;
    }
    location / {
        return 301 https://kts-impex.ru$request_uri;
    }
}
server {
    listen 443 ssl http2 default_server;
    listen [::]:443 ssl http2 default_server;
    server_name kts-impex.ru;
    client_max_body_size 25m;
    location ~ ^/api/admin/top-dashboard/blocks/[1-9][0-9]*/data/?$ {
        client_max_body_size 501m;
        proxy_pass http://127.0.0.1:3000;
        proxy_request_buffering off;
    }
    location /uploads/ {
        alias /var/www/kts-uploads/;
    }
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
server {
    listen 443 ssl http2;
    server_name www.kts-impex.ru;
    return 301 https://kts-impex.ru$request_uri;
}
`;

async function fixture(t: TestContext, source = config) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'kts-firmware-nginx-test-')));
  t.after(async () => {
    assert.ok(path.basename(root).startsWith('kts-firmware-nginx-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const target = path.join(root, 'kts-next-admin');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'calls');
  await mkdir(bin);
  await writeFile(target, source);
  await writeFile(log, '');
  // Never invoke sudo, the real nginx or systemctl. Root identity is simulated
  // only for this child, whose target and every write stay inside the fixture.
  await writeFile(path.join(bin, 'id'), '#!/bin/sh\nprintf "%s\\n" "${TEST_UID:-0}"\n', { mode: 0o755 });
  await writeFile(path.join(bin, 'nginx'), `#!/bin/sh
printf 'nginx %s\n' "$*" >> "$TEST_LOG"
if [ "$TEST_FAILURE" = baseline ]; then exit 1; fi
if [ "$TEST_FAILURE" = validation ] && grep -Fq 'location = /api/admin/firmware {' "$TEST_TARGET"; then exit 1; fi
exit 0
`, { mode: 0o755 });
  await writeFile(path.join(bin, 'systemctl'), `#!/bin/sh
printf 'systemctl %s\n' "$*" >> "$TEST_LOG"
if [ "$TEST_FAILURE" = reload ] && [ ! -f "$TEST_ONCE" ]; then
    touch "$TEST_ONCE"
    exit 1
fi
exit 0
`, { mode: 0o755 });
  return {
    root, target,
    run: (env: Record<string, string> = {}) => spawnSync('/bin/sh', [script, target], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_UID: '0', TEST_FAILURE: '', TEST_LOG: log, TEST_TARGET: target,
        TEST_ONCE: path.join(root, 'reload-failed-once'), ...env },
      encoding: 'utf8', timeout: 10000,
    }),
    contents: () => readFile(target, 'utf8'),
    calls: async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean),
    backups: async () => (await readdir(root)).filter((name) => name.startsWith('kts-next-admin.backup.')),
    assertClean: async () => {
      assert.deepEqual((await readdir(root)).filter((name) => /\.(candidate|restore)\.|\.firmware-limit\.lock$/.test(name)), []);
    },
  };
}

test('firmware nginx helper adds only the exact HTTPS 26m location and is idempotent', async (t) => {
  const f = await fixture(t);
  const first = f.run();
  assert.equal(first.status, 0, first.stderr);
  const updated = await f.contents();
  const inserted = /    location = \/api\/admin\/firmware \{\n[\s\S]*?    \}\n\n/.exec(updated);
  assert.ok(inserted);
  assert.equal(updated.replace(inserted[0], ''), config, 'every original line, public route and TOP limit stays unchanged');
  assert.ok(updated.indexOf(inserted[0]) > updated.indexOf('client_max_body_size 25m;'));
  assert.match(inserted[0], /client_max_body_size 26m;/);
  for (const line of config.slice(config.lastIndexOf('    location / {')).split('\n').slice(1, 10)) {
    assert.ok(inserted[0].includes(line), `preserve existing proxy setting: ${line}`);
  }
  assert.deepEqual(await f.calls(), ['nginx -t', 'nginx -t', 'systemctl reload nginx']);
  const backups = await f.backups();
  assert.equal(backups.length, 1);
  assert.equal(await readFile(path.join(f.root, backups[0]), 'utf8'), config);
  const again = f.run();
  assert.equal(again.status, 0, again.stderr);
  assert.equal(await f.contents(), updated);
  assert.deepEqual(await f.backups(), backups);
  assert.deepEqual(await f.calls(), ['nginx -t', 'nginx -t', 'systemctl reload nginx', 'nginx -t']);
  await f.assertClean();
});

for (const failure of ['validation', 'reload']) {
  test(`firmware nginx helper restores exact original configuration after ${failure} failure`, async (t) => {
    const f = await fixture(t);
    const result = f.run({ TEST_FAILURE: failure });
    assert.notEqual(result.status, 0);
    assert.equal(await f.contents(), config);
    assert.equal((await f.backups()).length, 1, 'retain recovery backup on failure');
    assert.deepEqual(await f.calls(), failure === 'validation'
      ? ['nginx -t', 'nginx -t', 'nginx -t', 'systemctl reload nginx']
      : ['nginx -t', 'nginx -t', 'systemctl reload nginx', 'nginx -t', 'systemctl reload nginx']);
    await f.assertClean();
  });
}

test('firmware nginx helper rejects invalid baseline without applying or reloading anything', async (t) => {
  const f = await fixture(t);
  assert.notEqual(f.run({ TEST_FAILURE: 'baseline' }).status, 0);
  assert.equal(await f.contents(), config);
  assert.deepEqual(await f.calls(), ['nginx -t']);
  assert.deepEqual(await f.backups(), []);
  await f.assertClean();
});

for (const [name, source] of [
  ['wrong hostname', config.replace('server_name kts-impex.ru;', 'server_name other.example;')],
  ['unexpected global limit', config.replace('client_max_body_size 25m;', 'client_max_body_size 50m;')],
  ['existing conflicting location', config.replace('    location /uploads/ {', '    location = /api/admin/firmware {\n        client_max_body_size 25m;\n    }\n    location /uploads/ {')],
  ['unexpected root routing', config.replace('        proxy_cache_bypass $http_upgrade;', '        try_files $uri @app;')],
  ['missing forwarding header', config.replace('        proxy_set_header X-Forwarded-Proto $scheme;\n', '')],
]) {
  test(`firmware nginx helper refuses ${name} without changing the virtual host`, async (t) => {
    const f = await fixture(t, source);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.equal(await f.contents(), source);
    assert.deepEqual(await f.calls(), []);
    assert.deepEqual(await f.backups(), []);
    await f.assertClean();
  });
}

test('firmware nginx helper refuses unprivileged use, symlink targets and competing helper locks', async (t) => {
  const f = await fixture(t);
  assert.notEqual(f.run({ TEST_UID: '1000' }).status, 0);
  assert.equal(await f.contents(), config);
  await mkdir(`${f.target}.firmware-limit.lock`);
  assert.notEqual(f.run().status, 0);
  await rm(`${f.target}.firmware-limit.lock`, { recursive: true });
  const original = path.join(f.root, 'original-vhost');
  await writeFile(original, config);
  await rm(f.target);
  await symlink(original, f.target);
  assert.notEqual(f.run().status, 0);
  assert.equal(await readFile(original, 'utf8'), config);
  assert.deepEqual(await f.calls(), []);
  assert.deepEqual(await f.backups(), []);
});
