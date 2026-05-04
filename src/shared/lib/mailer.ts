import nodemailer from 'nodemailer';

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export async function sendSystemMail(input: { to: string; subject: string; text: string; html: string }) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : true,
    auth: {
      user: requireEnv('SMTP_USER'),
      pass: requireEnv('SMTP_PASSWORD'),
    },
  });

  const user = requireEnv('SMTP_USER');
  await transporter.sendMail({
    from: process.env.SMTP_FROM || `"KTS" <${user}>`,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
  });
}
