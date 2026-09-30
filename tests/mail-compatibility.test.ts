import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';

test('mail upgrade preserves project SMTP configuration without opening a connection', () => {
  const transport = nodemailer.createTransport({
    host: 'smtp.example.test', port: 465, secure: true,
    auth: { user: 'system@example.test', pass: 'synthetic-test-password' },
  });
  assert.equal(transport.options.host, 'smtp.example.test');
  assert.equal(transport.options.port, 465);
  assert.equal(transport.options.secure, true);
  transport.close();
});

test('outgoing Russian text, HTML, reply-to and Buffer attachments round trip through the incoming parser offline', async () => {
  const content = Buffer.from('Артикул;Остаток\nKTS-123;25\n', 'utf8');
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  try {
    const result = await transport.sendMail({
      from: '"КТС — склад" <warehouse@example.test>',
      to: 'manager@example.test, support@example.test',
      replyTo: 'client@example.test',
      subject: 'Остатки КТС — обновление',
      date: new Date('2026-09-30T07:41:00.000Z'),
      text: 'Остатки на складе: 25',
      html: '<p>Остатки на складе: <strong>25</strong></p>',
      attachments: [{ filename: 'остатки.csv', content, contentType: 'text/csv' }],
    });
    assert.ok(Buffer.isBuffer(result.message));
    assert.deepEqual(result.envelope.to, ['manager@example.test', 'support@example.test']);
    const parsed = await simpleParser(result.message);
    assert.equal(parsed.from?.value[0].address, 'warehouse@example.test');
    assert.equal(parsed.from?.value[0].name, 'КТС — склад');
    assert.equal(parsed.replyTo?.value[0].address, 'client@example.test');
    assert.equal(parsed.subject, 'Остатки КТС — обновление');
    assert.equal(parsed.date?.toISOString(), '2026-09-30T07:41:00.000Z');
    assert.match(parsed.text ?? '', /Остатки на складе: 25/);
    assert.match(parsed.html || '', /<strong>25<\/strong>/);
    assert.equal(parsed.attachments.length, 1);
    assert.equal(parsed.attachments[0].filename, 'остатки.csv');
    assert.equal(parsed.attachments[0].contentType, 'text/csv');
    assert.deepEqual(parsed.attachments[0].content, content);
  } finally { transport.close(); }
});

test('stream transport does not turn untrusted subject newlines into recipients or extra headers', async () => {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  try {
    const result = await transport.sendMail({
      from: 'system@example.test', to: 'manager@example.test',
      subject: 'Заявка\r\nBcc: outsider@example.test',
      text: 'Synthetic local test only',
    });
    assert.ok(Buffer.isBuffer(result.message));
    assert.deepEqual(result.envelope.to, ['manager@example.test']);
    const parsed = await simpleParser(result.message);
    assert.equal(parsed.bcc, undefined);
    assert.equal(parsed.headers.has('bcc'), false);
  } finally { transport.close(); }
});

test('CommonJS entry point used by server bundles still exposes createTransport and sendMail', async () => {
  const require = createRequire(import.meta.url);
  const common = require('nodemailer') as typeof nodemailer;
  assert.equal(typeof common.createTransport, 'function');
  const transport = common.createTransport({ jsonTransport: true });
  try {
    const result = await transport.sendMail({ from: 'from@example.test', to: 'to@example.test', subject: 'Проверка', text: 'Без SMTP' });
    const message = JSON.parse(result.message);
    assert.equal(message.subject, 'Проверка');
    assert.equal(message.text, 'Без SMTP');
  } finally { transport.close(); }
});
