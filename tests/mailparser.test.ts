import assert from 'node:assert/strict';
import test from 'node:test';

import { simpleParser } from 'mailparser';

test('mailparser keeps parsing HTML messages with the patched merge dependency', async () => {
  const message = await simpleParser(
    [
      'From: warehouse@example.com',
      'To: stock@example.com',
      'Subject: Stock update',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Остатки на складе: <strong>25</strong></p>',
    ].join('\r\n'),
  );

  assert.match(message.text ?? '', /Остатки на складе:\s*25/);
  assert.match(message.html || '', /<strong>25<\/strong>/);
});
