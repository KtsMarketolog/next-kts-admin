import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';

import { applySessionCookie, getOrCreateSessionCookie } from '@/shared/lib/publicSession';
import { checkDbRateLimit } from '@/shared/lib/rateLimit';

export const runtime = 'nodejs';

const MAX_ATTACHMENT_SIZE = 8 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_FIELD_LENGTH = 2000;
const PUBLIC_FORM_SESSION_COOKIE = 'kts_public_form_sid';

const ALLOWED_ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/rtf',
  'text/rtf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const ALLOWED_ATTACHMENT_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'rtf', 'jpg', 'jpeg', 'png', 'webp']);

export async function POST(req: Request) {
  const formSession = getOrCreateSessionCookie(req, PUBLIC_FORM_SESSION_COOKIE);
  const [sessionLimit, globalLimit] = await Promise.all([
    checkDbRateLimit(`partner-request:session:${formSession.sessionId}`, 5, 10 * 60 * 1000),
    checkDbRateLimit('partner-request:global', 100, 10 * 60 * 1000),
  ]);
  if (!sessionLimit.allowed || !globalLimit.allowed) {
    const retryAfter = Math.max(sessionLimit.retryAfter, globalLimit.retryAfter);
    const response = NextResponse.json(
      { ok: false, error: 'TOO_MANY_REQUESTS' },
      {
        status: 429,
        headers: { 'Retry-After': String(retryAfter) },
      },
    );
    applySessionCookie(response.headers, formSession);
    return response;
  }

  try {
    const formData = await req.formData();
    const fields: Record<string, string> = {};
    const attachments: { filename: string; content: Buffer; contentType?: string }[] = [];
    let totalAttachmentSize = 0;

    for (const [key, value] of formData.entries()) {
      if (value instanceof File) {
        if (!value.size) continue;
        validateAttachment(value, totalAttachmentSize);

        const buf = Buffer.from(await value.arrayBuffer());
        totalAttachmentSize += buf.length;
        attachments.push({
          filename: value.name || 'attachment',
          content: buf,
          contentType: value.type || undefined,
        });
      } else {
        fields[key] = normalizeField(value);
      }
    }

    const email = fields.email || '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const response = NextResponse.json({ ok: false, error: 'INVALID_EMAIL' }, { status: 400 });
      applySessionCookie(response.headers, formSession);
      return response;
    }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT || 465),
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : true,
      auth: {
        user: requireEnv('SMTP_USER'),
        pass: requireEnv('SMTP_PASSWORD'),
      },
    });

    const mailFrom = process.env.SMTP_FROM || `"KTS" <${requireEnv('SMTP_USER')}>`;
    const mailTo = process.env.SMTP_TO || 'ktsmarketolog@yandex.ru';
    const subject = 'Новая заявка партнёра';
    const htmlBody = `
      <h2>${subject}</h2>
      <ul>
        <li><b>Цель:</b> ${escapeHtml(fields.purpose || '')}</li>
        <li><b>Компания/Имя:</b> ${escapeHtml(fields.company || '')}</li>
        <li><b>Город:</b> ${escapeHtml(fields.city || '')}</li>
        <li><b>Контактное лицо/Вакансия:</b> ${escapeHtml(fields.contact || '')}</li>
        <li><b>Телефон:</b> ${escapeHtml(fields.phone || '')}</li>
        <li><b>Email:</b> ${escapeHtml(email)}</li>
      </ul>
      <p><b>Комментарий:</b></p>
      <pre style="white-space:pre-wrap;font-family:ui-monospace,Menlo,Monaco,'Courier New',monospace;">${escapeHtml(fields.comment || '')}</pre>
    `.trim();

    await transporter.sendMail({
      from: mailFrom,
      to: mailTo,
      subject,
      text:
        `${subject}\n` +
        `Цель: ${fields.purpose || ''}\n` +
        `Компания/Имя: ${fields.company || ''}\n` +
        `Город: ${fields.city || ''}\n` +
        `Контактное лицо/Вакансия: ${fields.contact || ''}\n` +
        `Телефон: ${fields.phone || ''}\n` +
        `Email: ${email}\n\n` +
        `Комментарий:\n${fields.comment || ''}\n`,
      html: htmlBody,
      attachments,
      replyTo: email,
    });

    const response = NextResponse.json({ ok: true });
    applySessionCookie(response.headers, formSession);
    return response;
  } catch (err) {
    if (err instanceof PublicFormError) {
      const response = NextResponse.json({ ok: false, error: err.message }, { status: err.status });
      applySessionCookie(response.headers, formSession);
      return response;
    }

    console.error('MAIL_FAILED', err);
    const response = NextResponse.json({ ok: false, error: 'MAIL_FAILED' }, { status: 500 });
    applySessionCookie(response.headers, formSession);
    return response;
  }
}

function validateAttachment(file: File, currentTotalSize: number) {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  const allowedByType = Boolean(file.type && ALLOWED_ATTACHMENT_TYPES.has(file.type));
  const allowedByExtension = ALLOWED_ATTACHMENT_EXTENSIONS.has(extension);

  if (!allowedByType && !allowedByExtension) {
    throw new PublicFormError('UNSUPPORTED_ATTACHMENT_TYPE', 400);
  }

  if (file.size > MAX_ATTACHMENT_SIZE || currentTotalSize + file.size > MAX_TOTAL_ATTACHMENT_SIZE) {
    throw new PublicFormError('ATTACHMENT_TOO_LARGE', 400);
  }
}

function normalizeField(value: FormDataEntryValue) {
  return String(value ?? '').trim().slice(0, MAX_FIELD_LENGTH);
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

class PublicFormError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

function escapeHtml(s: string) {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
