'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { formatDeliveryError } = require('../notify.cjs');

const fallback = 'KTS backup email delivery FAILED [code=UNKNOWN]; check SMTP settings and independent monitor';
const sentinel = 'fixture-secret-not-real-credential';

test('SMTP diagnostics expose only an allowlisted category, numeric status, and command', () => {
  const error = Object.assign(new Error(`SMTP_PASSWORD=${sentinel}`), {
    code: 'EAUTH', responseCode: 535, command: 'AUTH LOGIN',
    response: `535 password=${sentinel}`, credentials: { password: sentinel },
    stack: `stack contains ${sentinel}`,
  });
  assert.equal(formatDeliveryError(error),
    'KTS backup email delivery FAILED [code=EAUTH smtp=535 command=AUTH]; check SMTP settings and independent monitor');
  assert.equal(formatDeliveryError(error).includes(sentinel), false);
});

test('known Nodemailer and local dependency failure codes are retained exactly', () => {
  for (const code of [
    'EAUTH', 'ESOCKET', 'ECONNECTION', 'ETIMEDOUT', 'ETLS', 'EENVELOPE',
    'EMESSAGE', 'EDNS', 'ESTREAM', 'EPROTOCOL', 'EREQUIRETLS',
    'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
    'EHOSTUNREACH', 'ENETUNREACH', 'MODULE_NOT_FOUND',
  ]) {
    assert.equal(formatDeliveryError({ code }), fallback.replace('UNKNOWN', code));
  }
});

test('unknown or secret-bearing error fields use a fixed fallback without coercion', () => {
  const coercible = { toString() { throw new Error(sentinel); } };
  for (const code of [sentinel, 'EAUTH\n' + sentinel, 'E_NEW_VENDOR_CODE', 535, coercible, Symbol(sentinel)]) {
    assert.equal(formatDeliveryError({ code, command: `AUTH ${sentinel}`, responseCode: sentinel,
      message: sentinel, response: sentinel, stack: sentinel }), fallback);
  }
});

test('null and other non-error values are robust and never printed', () => {
  for (const error of [undefined, null, sentinel, 0, true, Symbol(sentinel)]) {
    assert.equal(formatDeliveryError(error), fallback);
  }
});

test('SMTP response code accepts only integer numbers from 100 through 599', () => {
  for (const responseCode of [100, 250, 421, 535, 599]) {
    assert.equal(formatDeliveryError({ responseCode }), fallback.replace('code=UNKNOWN]', `code=UNKNOWN smtp=${responseCode}]`));
  }
  for (const responseCode of [99, 600, 535.5, '535', NaN, Infinity, null, { valueOf() { throw new Error(sentinel); } }]) {
    assert.equal(formatDeliveryError({ responseCode }), fallback);
  }
});

test('SMTP commands are exact allowlist matches; envelopes or appended credentials are not printed', () => {
  for (const [command, safe] of [
    ['CONN', 'CONN'], ['AUTH PLAIN', 'AUTH'], ['AUTH CRAM-MD5', 'AUTH'],
    ['MAIL FROM', 'MAILFROM'], ['RCPT TO', 'RCPTTO'], ['DATA', 'DATA'], ['STARTTLS', 'STARTTLS'],
  ]) {
    assert.equal(formatDeliveryError({ command }), fallback.replace('code=UNKNOWN]', `code=UNKNOWN command=${safe}]`));
  }
  for (const command of [`AUTH PLAIN ${sentinel}`, `MAIL FROM:<${sentinel}>`, `RCPT TO:<${sentinel}>`,
    'DATA\n' + sentinel, 'auth', sentinel]) {
    assert.equal(formatDeliveryError({ command }), fallback);
  }
});

test('formatter does not invoke error getters and handles throwing proxies', () => {
  const error = {};
  for (const field of ['code', 'responseCode', 'command', 'message', 'response', 'stack']) {
    Object.defineProperty(error, field, { get() { throw new Error(sentinel); } });
  }
  assert.equal(formatDeliveryError(error), fallback);
  assert.equal(formatDeliveryError(new Proxy({}, {
    getOwnPropertyDescriptor() { throw new Error(sentinel); },
  })), fallback);
});

test('importing the formatter does not send mail or run notifier setup', () => {
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.resolve(__dirname, '../notify.cjs'))})`], {
    env: { KTS_ALERT_SOURCE: 'github' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
