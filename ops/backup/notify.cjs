'use strict';
const fs=require('node:fs/promises');

// Never log dependency messages, SMTP responses, addresses, or authentication
// material. These fixed tokens are enough to distinguish common failure modes.
const SAFE_ERROR_CODES = new Set([
  'EAUTH', 'ESOCKET', 'ECONNECTION', 'ETIMEDOUT', 'ETLS', 'EENVELOPE',
  'EMESSAGE', 'EDNS', 'ESTREAM', 'EPROTOCOL', 'EREQUIRETLS',
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'MODULE_NOT_FOUND',
]);
const SAFE_COMMANDS = new Map([
  ['CONN', 'CONN'], ['AUTH', 'AUTH'], ['AUTH PLAIN', 'AUTH'],
  ['AUTH LOGIN', 'AUTH'], ['AUTH CRAM-MD5', 'AUTH'], ['AUTH XOAUTH2', 'AUTH'],
  ['MAIL FROM', 'MAILFROM'], ['RCPT TO', 'RCPTTO'], ['DATA', 'DATA'],
  ['STARTTLS', 'STARTTLS'], ['EHLO', 'EHLO'], ['HELO', 'HELO'],
  ['LHLO', 'LHLO'], ['RSET', 'RSET'], ['QUIT', 'QUIT'], ['API', 'API'],
]);

function errorValue(error, name) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return undefined;
  // Nodemailer stores these fields directly. Do not invoke arbitrary getters
  // or string conversions while handling an otherwise untrusted error object.
  try { return Object.getOwnPropertyDescriptor(error, name)?.value; }
  catch { return undefined; }
}

function formatDeliveryError(error) {
  const code = errorValue(error, 'code');
  const responseCode = errorValue(error, 'responseCode');
  const command = errorValue(error, 'command');
  const details = [`code=${SAFE_ERROR_CODES.has(code) ? code : 'UNKNOWN'}`];
  if (Number.isInteger(responseCode) && responseCode >= 100 && responseCode <= 599) {
    details.push(`smtp=${responseCode}`);
  }
  if (SAFE_COMMANDS.has(command)) details.push(`command=${SAFE_COMMANDS.get(command)}`);
  return `KTS backup email delivery FAILED [${details.join(' ')}]; check SMTP settings and independent monitor`;
}

async function main() {
  const local=process.env.KTS_ALERT_SOURCE!=='github';
  let env=process.env,mailer;
  if(local) {
    const {context}=require('./common.cjs');const ctx=await context();
    await ctx.privateFile(ctx.config.envFile);env={};
    for(const line of (await fs.readFile(ctx.config.envFile,'utf8')).split(/\r?\n/)) {const i=line.indexOf('=');if(i>0&&!line.startsWith('#'))env[line.slice(0,i).trim()]=line.slice(i+1).trim().replace(/^(['"])(.*)\1$/,'$2');}
    mailer=require('nodemailer');
  } else mailer=require('nodemailer');
  if(!env.SMTP_HOST||!env.SMTP_USER||!env.SMTP_PASSWORD)throw new Error('Alert SMTP settings missing');
  const event=String(process.argv[2]||'backup-check').replace(/[^a-zA-Z0-9_.@-]/g,'').slice(0,120);
  let latest='не подтверждена';
  if(local)try{const s=JSON.parse(await fs.readFile('/home/kts/backups/kts-next-admin/state/capture.json','utf8'));latest=s.ok?s.at:'последняя попытка завершилась ошибкой';}catch{}
  const runUrl=process.env.GITHUB_SERVER_URL&&process.env.GITHUB_REPOSITORY&&process.env.GITHUB_RUN_ID?`${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`:'';
  const transport=mailer.createTransport({host:env.SMTP_HOST,port:Number(env.SMTP_PORT||465),secure:env.SMTP_SECURE==='true'||String(env.SMTP_PORT||465)==='465',auth:{user:env.SMTP_USER,pass:env.SMTP_PASSWORD},connectionTimeout:15000,socketTimeout:30000,tls:{rejectUnauthorized:true}});
  try {await transport.sendMail({from:env.SMTP_FROM||env.SMTP_USER,to:'ktsmarketolog@yandex.ru',subject:event==='test'?'KTS: проверка уведомлений о бэкапах':'KTS: ошибка резервного копирования',text:`Проект: kts-next-admin\nПроверка: ${event}\nВремя UTC: ${new Date().toISOString()}\nПоследний успешный локальный бэкап: ${latest}\n${runUrl?`Проверка GitHub: ${runUrl}\n`:''}Проверьте резервные копии. Это письмо не содержит паролей, ключей или данных клиентов.`});console.log('KTS backup email sent');}
  finally {transport.close();}
}
if (require.main === module) {
  main().catch((error)=>{console.error(formatDeliveryError(error));process.exitCode=1;});
}

module.exports = { formatDeliveryError };
