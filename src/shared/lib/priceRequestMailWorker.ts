import nodemailer from 'nodemailer';
import { createConnection, type Socket } from 'node:net';
import {
  acknowledgePriceRequestMail, claimPriceRequestMail, deferPriceRequestMail,
  priceRequestMailQueueCounts, type ClaimedPriceRequestMail,
} from './db/priceRequestOutboxRepo';

const SMTP_DEADLINE_MS = 15_000;
const SMTP_CONNECT_MS = 5_000;

function mailTimeout() {
  return Object.assign(new Error('Mail deadline exceeded'), { code: 'ETIMEDOUT' });
}

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
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || 465);
  let socket: Socket | undefined;
  let finished = false;
  let cancelConnect: (() => void) | undefined;
  const transport = nodemailer.createTransport({
    host, port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : true,
    auth: { user, pass: password },
    connectionTimeout: SMTP_CONNECT_MS, greetingTimeout: 5_000, socketTimeout: 10_000,
    getSocket: (_options, callback) => {
      // MIME preparation can finish after the deadline: never open a late connection.
      if (finished) { callback(mailTimeout()); return; }
      // Non-pooled transport.close() does NOT close active SMTP connections. Own the
      // underlying TCP socket, including DNS/connect, implicit TLS and STARTTLS upgrades.
      let connection: Socket;
      try {
        connection = createConnection({ host, port });
      } catch {
        callback(Object.assign(new Error('Mail connection configuration is invalid'), { code: 'ECONFIG' }));
        return;
      }
      socket = connection;
      // A queued DNS/socket error may arrive after cancellation removed its callback.
      connection.on('error', () => {});
      let settled = false;
      const settle = (error: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        cancelConnect = undefined;
        connection.removeListener('connect', connected);
        connection.removeListener('error', failed);
        if (error || finished) {
          connection.destroy();
          callback(error || mailTimeout());
        } else {
          // Nodemailer retains its TLS negotiation and certificate verification.
          callback(null, { connection });
        }
      };
      const connected = () => settle(null);
      const failed = (error: Error) => settle(error);
      const connectTimer = setTimeout(() => settle(mailTimeout()), SMTP_CONNECT_MS);
      cancelConnect = () => settle(mailTimeout());
      connection.once('connect', connected);
      connection.once('error', failed);
    },
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
          finished = true;
          socket?.destroy();
          cancelConnect?.();
          reject(mailTimeout());
        }, SMTP_DEADLINE_MS);
      }),
    ]);
    if (!delivered.accepted?.length || delivered.rejected?.length) {
      throw Object.assign(new Error('Recipient was not accepted'), { code: 'EENVELOPE' });
    }
  } finally {
    finished = true;
    clearTimeout(timer);
    socket?.destroy();
    cancelConnect?.();
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
