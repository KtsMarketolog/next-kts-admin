'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const fixtureId = 'fixtureAccessKey000000';
const fixtureSecret = 'fixtureSecret000000000000000000000000/+=';
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

// Python supplies a real controlling PTY; all paths and values are synthetic.
// Test input travels over stdin, never the credential installer's argv.
const ptyDriver = `import os, sys, json, pty, termios, fcntl, subprocess, select, time, signal
spec=json.load(sys.stdin)
master, slave=pty.openpty()
def control():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
proc=subprocess.Popen(['/bin/bash', spec['script']], stdin=slave, stdout=slave, stderr=slave, preexec_fn=control)
output=b''
sent_id=False
sent_secret=False
deadline=time.monotonic()+20
while True:
    ready,_,_=select.select([master],[],[],0.05)
    if ready:
        try: output+=os.read(master,65536)
        except OSError: pass
    if b'Paste Access Key ID (hidden), then Enter: ' in output and not sent_id:
        os.write(master,(spec['id']+'\\n').encode()); sent_id=True
    if b'Paste Secret Access Key (hidden), then Enter: ' in output and not sent_secret:
        if spec.get('interrupt'): proc.send_signal(signal.SIGTERM)
        else: os.write(master,(spec['secret']+'\\n').encode())
        sent_secret=True
    if proc.poll() is not None:
        while select.select([master],[],[],0)[0]:
            try:
                chunk=os.read(master,65536)
                if not chunk: break
                output+=chunk
            except OSError: break
        break
    if time.monotonic()>deadline:
        proc.kill(); proc.wait(); raise RuntimeError('interactive fixture timed out')
echo=bool(termios.tcgetattr(master)[3]&termios.ECHO)
os.close(master); os.close(slave)
print(json.dumps({'code':proc.returncode,'output':output.decode(errors='replace'),'echo':echo,'sentId':sent_id,'sentSecret':sent_secret}))
`;

async function fixture(t, { collide = false } = {}) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kts-credential-test-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'backup'), configDir = path.join(temporary, 'config');
  await fs.mkdir(root, { mode: 0o700 }); await fs.mkdir(configDir, { mode: 0o700 });
  await fs.writeFile(path.join(root, '.kts-backup-root'), 'kts-next-admin\n', { mode: 0o600 });
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({
    project: 'kts-next-admin', root,
    cloud: { profile: 'kts-backup', region: 'ru-central1', endpoint: 'https://storage.yandexcloud.net',
      configFile: path.join(configDir, 'aws-config'), credentialsFile: path.join(configDir, 'aws-credentials') },
  }), { mode: 0o600 });
  const source = await fs.readFile(path.join(__dirname, '../configure-credentials.sh'), 'utf8');
  const node = shellQuote(process.execPath);
  // Only platform/audited-path guards are shimmed. Real Bash read/stty, temp
  // files, atomic links, traps and credential publication execute unchanged.
  const shim = [
    'id() { if [[ "$1" == -un ]]; then builtin printf kts; else builtin printf 1001; fi; }',
    `stat() { ${node} -e 'const fs=require("node:fs");process.stdout.write("kts:"+(fs.statSync(process.argv[1]).mode&511).toString(8))' "\${@: -1}"; }`,
    `realpath() { ${node} -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "\${@: -1}"; }`,
    'chmod() { local mode=$1; shift; if [[ "$1" == -- ]]; then shift; fi; command chmod "$mode" "$@"; }',
    collide ? 'ln() { if [[ "$1" == -- ]]; then shift; fi; if [[ "${@: -1}" == "$aws_credentials" ]]; then builtin printf foreign > "$aws_credentials"; return 1; else command ln "$@"; fi; }'
      : 'ln() { if [[ "$1" == -- ]]; then shift; fi; command ln "$@"; }',
  ].join('\n') + '\n';
  const patched = source.replace('readonly root=/home/kts/backups/kts-next-admin', 'readonly root=' + shellQuote(root))
    .replace('readonly config_dir=/home/kts/.config/kts-backup', 'readonly config_dir=' + shellQuote(configDir))
    .replaceAll('/usr/bin/node', node).replace('/usr/bin/flock --exclusive --wait 1800 9', '/usr/bin/true')
    .replace('[[ "$(id -un)"', shim + '[[ "$(id -un)"');
  const script = path.join(temporary, 'interactive-fixture.sh');
  await fs.writeFile(script, patched, { mode: 0o700 });
  return { root, configDir, script };
}

async function interactive(f, options = {}) {
  const result = await run('python3', ['-c', ptyDriver], JSON.stringify({
    script: f.script, id: fixtureId, secret: fixtureSecret, ...options,
  }));
  assert.equal(result.code, 0, 'PTY driver failed');
  const session = JSON.parse(result.stdout);
  assert.equal(session.output.includes(fixtureId), false, 'ID must not echo');
  assert.equal(session.output.includes(fixtureSecret), false, 'secret must not echo');
  assert.equal(session.echo, true, 'terminal echo must be restored');
  return session;
}

test('credential setup script has strict mode, shared lock and no credential arguments', async () => {
  const source = await fs.readFile(path.join(__dirname, '../configure-credentials.sh'), 'utf8');
  assert.match(source, /set \+xv/); assert.match(source, /set -Eeuo pipefail/); assert.match(source, /umask 077/);
  assert.match(source, /exec 9>"\$root\/\.operation\.lock"/);
  assert.match(source, /\[\[ \$# == 0 \]\]/);
  assert.match(source, /builtin read -r -s -u 3 access_key_id/);
  assert.match(source, /builtin read -r -s -u 3 secret_access_key/);
});

test('interactive setup hides both values and atomically installs private static-profile files', async (t) => {
  const f = await fixture(t), result = await interactive(f);
  assert.equal(result.code, 0, result.output); assert.match(result.output, /Private AWS profile installed: kts-backup/);
  const credentials = path.join(f.configDir, 'aws-credentials'), config = path.join(f.configDir, 'aws-config');
  assert.equal((await fs.stat(credentials)).mode & 0o777, 0o600); assert.equal((await fs.stat(config)).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(credentials, 'utf8'), '[kts-backup]\naws_access_key_id = ' + fixtureId + '\naws_secret_access_key = ' + fixtureSecret + '\n');
  assert.match(await fs.readFile(config, 'utf8'), /region = ru-central1/);
  assert.deepEqual((await fs.readdir(f.configDir)).sort(), ['aws-config', 'aws-credentials', 'config.json']);
});

test('noninteractive input is rejected before any credential read or file write', async (t) => {
  const f = await fixture(t), result = await run('/bin/bash', [f.script], 'ignored\n');
  assert.equal(result.code, 64); assert.match(result.stderr, /interactive TTY is required/);
  assert.deepEqual(await fs.readdir(f.configDir), ['config.json']);
});

test('invalid secret and interruption restore terminal and leave no credential files', async (t) => {
  for (const options of [{ secret: 'short' }, { interrupt: true }]) {
    const f = await fixture(t), result = await interactive(f, options);
    assert.notEqual(result.code, 0);
    assert.deepEqual(await fs.readdir(f.configDir), ['config.json']);
  }
});

test('existing AWS files are preserved and no secret prompt appears', async (t) => {
  const f = await fixture(t), target = path.join(f.configDir, 'aws-config');
  await fs.writeFile(target, 'preserve', { mode: 0o600 });
  const result = await interactive(f);
  assert.equal(result.code, 78); assert.equal(result.sentId, false);
  assert.equal(await fs.readFile(target, 'utf8'), 'preserve');
});

test('second publication collision rolls back only this run and preserves competing file', async (t) => {
  const f = await fixture(t, { collide: true }), result = await interactive(f);
  assert.notEqual(result.code, 0);
  await assert.rejects(fs.stat(path.join(f.configDir, 'aws-config')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.configDir, 'aws-credentials'), 'utf8'), 'foreign');
  assert.deepEqual((await fs.readdir(f.configDir)).sort(), ['aws-credentials', 'config.json']);
});
