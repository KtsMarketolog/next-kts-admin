import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSecureContext, createServer as createTlsServer, TLSSocket } from 'node:tls';
import vm from 'node:vm';
import test from 'node:test';
import * as net from 'node:net';
import nodemailer from 'nodemailer';
import ts from 'typescript';
import type { ClaimedPriceRequestMail } from '../src/shared/lib/db/priceRequestOutboxRepo';

// All credentials, recipients, certificate and SMTP servers are synthetic and local.
// No application environment, database, external provider or production queue is read.
const mail: ClaimedPriceRequestMail = { id: '11', requestId: '9', recipient: 'recipient@example.test',
  subject: 'Synthetic', text: 'Synthetic body', html: '<p>Synthetic body</p>', attempts: 1, leaseToken: 'synthetic' };
const source = ts.transpileModule(readFileSync(new URL('../src/shared/lib/priceRequestMailWorker.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

function loadSender(port: number, secure: boolean, certificate: Buffer, trustCertificate = true) {
  const output = { exports: {} };
  const ownedSockets: Socket[] = [];
  vm.runInNewContext(source, { module: output, exports: output.exports, console,
    process: { env: { SMTP_USER: 'sender@example.test', SMTP_PASSWORD: 'synthetic-only',
      SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: String(secure) } },
    // Shorten only the application's total deadline; real Nodemailer SMTP/TLS stays intact.
    setTimeout: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds === 15_000 ? 750 : milliseconds),
    clearTimeout,
    require: (name: string) => {
      if (name === './db/priceRequestOutboxRepo') return {};
      if (name === 'node:net') return { ...net, createConnection: (options: net.NetConnectOpts) => {
        const socket = net.createConnection(options);
        ownedSockets.push(socket);
        return socket;
      } };
      assert.equal(name, 'nodemailer');
      return { createTransport: (options: Record<string, unknown>) => nodemailer.createTransport({
        ...options,
        // Trust only this test's ephemeral certificate, never disable verification.
        tls: { ...(trustCertificate ? { ca: certificate } : {}), servername: 'localhost', rejectUnauthorized: true },
      }) };
    },
  });
  return Object.assign((output.exports as { sendPriceRequestMail: (mail: ClaimedPriceRequestMail) => Promise<void> }).sendPriceRequestMail, { ownedSockets });
}

type Mode = 'plain' | 'implicit-tls' | 'starttls';

async function smtpServer(mode: Mode, slow: boolean, key: Buffer, cert: Buffer) {
  const active = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const commands: string[] = [];
  let dataCount = 0;
  let tlsSessions = 0;
  const context = createSecureContext({ key, cert });
  const later = (callback: () => void, milliseconds: number) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, milliseconds);
    timers.add(timer);
  };
  const attach = (socket: Socket, encrypted: boolean, greeting: boolean) => {
    let buffer = '';
    let inData = false;
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    const onData = (chunk: string) => {
      buffer += chunk;
      while (buffer.includes('\r\n')) {
        const index = buffer.indexOf('\r\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') { inData = false; dataCount++; socket.write('250 2.0.0 Accepted\r\n'); }
          continue;
        }
        const command = line.split(' ')[0];
        commands.push(command);
        if (command === 'EHLO') {
          socket.write(mode === 'starttls' && !encrypted
            ? '250-synthetic\r\n250 STARTTLS\r\n' : '250-synthetic\r\n250 AUTH PLAIN\r\n');
        } else if (command === 'STARTTLS') {
          socket.removeListener('data', onData);
          socket.write('220 Start TLS\r\n', () => {
            const wrapped = new TLSSocket(socket, { isServer: true, secureContext: context });
            wrapped.once('error', () => socket.destroy());
            wrapped.once('close', () => socket.destroy());
            wrapped.once('secure', () => { tlsSessions++; });
            attach(wrapped, true, false);
          });
          return;
        } else if (command === 'AUTH') socket.write('235 Authenticated\r\n');
        else if (command === 'MAIL') socket.write('250 Sender accepted\r\n');
        else if (command === 'RCPT') {
          if (!slow) socket.write('250 Recipient accepted\r\n');
          else {
            // Keep the inactivity timer alive past the total deadline. A close()-only
            // implementation keeps receiving these replies and subsequently sends DATA.
            for (let index = 1; index <= 10; index++) later(() => {
              if (!socket.destroyed) socket.write('250-Still processing\r\n');
            }, index * 100);
            later(() => { if (!socket.destroyed) socket.write('250 Recipient accepted\r\n'); }, 1_150);
          }
        } else if (command === 'DATA') { inData = true; socket.write('354 Send message\r\n'); }
        else if (command === 'QUIT') socket.end('221 Bye\r\n');
        else assert.fail(`Unexpected synthetic SMTP command: ${command}`);
      }
    };
    socket.on('data', onData);
    if (greeting) socket.write('220 synthetic ESMTP\r\n');
  };
  const server = mode === 'implicit-tls'
    ? createTlsServer({ key, cert }, (socket) => { tlsSessions++; attach(socket, true, true); })
    : createServer((socket) => attach(socket, false, true));
  server.on('tlsClientError', () => {});
  server.on('connection', (socket: Socket) => {
    active.add(socket);
    socket.once('close', () => active.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { port: address.port, active, commands, get dataCount() { return dataCount; }, get tlsSessions() { return tlsSessions; },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of active) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('real SMTP transport owns and terminates plain, implicit TLS and STARTTLS connections', async (suite) => {
  const directory = mkdtempSync(join(tmpdir(), 'kts-price-smtp-'));
  const keyPath = join(directory, 'synthetic-key.pem');
  const certPath = join(directory, 'synthetic-cert.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
    const key = readFileSync(keyPath);
    const cert = readFileSync(certPath);
    for (const mode of ['plain', 'implicit-tls', 'starttls'] as const) {
      for (const slow of [false, true]) {
        await suite.test(`${mode}: ${slow ? 'deadline destroys active socket and prevents late DATA' : 'successful send remains compatible'}`, async () => {
          const smtp = await smtpServer(mode, slow, key, cert);
          try {
            const send = loadSender(smtp.port, mode === 'implicit-tls', cert);
            if (slow) {
              await assert.rejects(send(mail), { code: 'ETIMEDOUT' });
              await delay(100);
              assert.equal(smtp.active.size, 0, 'socket must close before any new retry can start');
              await delay(600); // past the delayed final RCPT reply
              assert.equal(smtp.commands.includes('DATA'), false, 'no SMTP DATA after the deadline');
              assert.equal(smtp.dataCount, 0);
            } else {
              await send(mail);
              await delay(50);
              assert.equal(smtp.dataCount, 1);
              assert.equal(smtp.active.size, 0);
            }
            assert.ok(smtp.commands.includes('RCPT'), 'exercise an active SMTP send, not only connection startup');
            assert.equal(smtp.tlsSessions, mode === 'plain' ? 0 : 1);
          } finally { await smtp.close(); }
        });
      }
    }
    await suite.test('implicit TLS still rejects an untrusted certificate before AUTH or DATA', async () => {
      const smtp = await smtpServer('implicit-tls', false, key, cert);
      try {
        const send = loadSender(smtp.port, true, cert, false);
        await assert.rejects(send(mail), { code: 'ESOCKET' });
        await delay(50);
        assert.ok(send.ownedSockets.every((socket) => socket.destroyed));
        assert.equal(smtp.commands.includes('AUTH'), false);
        assert.equal(smtp.dataCount, 0);
        assert.equal(smtp.active.size, 0);
      } finally { await smtp.close(); }
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
