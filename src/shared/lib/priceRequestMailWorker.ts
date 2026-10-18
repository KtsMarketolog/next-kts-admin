import nodemailer from 'nodemailer';
import {
  acknowledgePriceRequestMail, claimPriceRequestMail, deferPriceRequestMail,
  priceRequestMailQueueCounts, type ClaimedPriceRequestMail,
} from './db/priceRequestOutboxRepo';

const SMTP_DEADLINE_MS = 15_000;

/** No request content, recipient, SMTP reply or credentials enter logs/error storage. */
function safeMailError(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  return ['EAUTH', 'ETIMEDOUT', 'ECONNECTION', 'ECONNREFUSED', 'ENOTFOUND', 'EENVELOPE', 'ECONFIG'].includes(String(code))
    ? String(code) : 'DELIVERY_FAILED';
}

export async function sendPriceRequestMail(mail: ClaimedPriceRequestMail) {
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD || process.env.SMTP_PASS;
  if (!user || !password) throw Object.assign(new Error('Mail is not configured'), { code: 'ECONFIG' });
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : true,
    auth: { user, pass: password },
    connectionTimeout: 5_000, greetingTimeout: 5_000, socketTimeout: 10_000,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const delivered = await Promise.race([
      transport.sendMail({ from: process.env.SMTP_FROM || `"KTS" <${user}>`, to: mail.recipient,
        subject: mail.subject, text: mail.text, html: mail.html,
        // SMTP is at-least-once after an uncertain acknowledgement; keep a stable identity on retries.
        messageId: `<price-request-${mail.requestId}-${mail.id}@kts-impex.ru>` }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          transport.close();
          reject(Object.assign(new Error('Mail deadline exceeded'), { code: 'ETIMEDOUT' }));
        }, SMTP_DEADLINE_MS);
      }),
    ]);
    if (!delivered.accepted?.length || delivered.rejected?.length) {
      throw Object.assign(new Error('Recipient was not accepted'), { code: 'EENVELOPE' });
    }
  } finally {
    clearTimeout(timer);
    transport.close();
  }
}

type Dependencies = {
  claim: typeof claimPriceRequestMail; send: typeof sendPriceRequestMail;
  acknowledge: typeof acknowledgePriceRequestMail; defer: typeof deferPriceRequestMail;
  counts: typeof priceRequestMailQueueCounts; now: () => number;
};

/** A cron-driven, bounded drain. No DB transaction/connection is held while SMTP is unavailable. */
export async function drainPriceRequestMail(dependencies: Dependencies = {
  claim: claimPriceRequestMail, send: sendPriceRequestMail, acknowledge: acknowledgePriceRequestMail,
  defer: deferPriceRequestMail, counts: priceRequestMailQueueCounts, now: Date.now,
}) {
  const started = dependencies.now();
  let sent = 0;
  let deferred = 0;
  for (let claimed = 0; claimed < 5 && dependencies.now() - started < 45_000; claimed++) {
    const mail = await dependencies.claim();
    if (!mail) break;
    try {
      await dependencies.send(mail);
    } catch (error) {
      await dependencies.defer(mail, safeMailError(error));
      deferred++;
      continue;
    }
    // A DB acknowledgement failure leaves the lease intact for recovery. Never mark it sent without the DB.
    if (await dependencies.acknowledge(mail)) sent++;
  }
  const counts = await dependencies.counts();
  if (counts.failed) console.error(JSON.stringify({ event: 'price_request_mail_needs_attention', failed: counts.failed }));
  return { sent, deferred, ...counts };
}
