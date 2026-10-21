import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AdminSession } from './adminAuth';
import { getAdminSessionSecret } from './authSecret';
import { PersonalDashboardError } from './managerDashboardDomain';
import type { PersonalDashboardRecipient } from './managerDashboardRecipients';

type ReplacementToken = {
  v: 1;
  action: 'replace' | 'rollback';
  actor: string;
  recipient: PersonalDashboardRecipient;
  fingerprint: string;
  incoming: string;
  expires: number;
  nonce: string;
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const personalReplacementDigest = (value: unknown) => digest(JSON.stringify(value));
const actorDigest = (session: AdminSession) => personalReplacementDigest([session.role, session.adminUserId ?? null, session.sessionId]);
const signature = (body: string) => createHmac('sha256', getAdminSessionSecret()).update(`personal-snapshot-replacement:v1:${body}`).digest();
const conflict = () => new PersonalDashboardError('REPLACEMENT_CONFLICT', 'Подтверждение замены устарело или изменилось. Снова сравните файлы; текущий снимок не изменён.');

export function createPersonalReplacementToken(session: AdminSession, input: Pick<ReplacementToken, 'action' | 'recipient' | 'fingerprint' | 'incoming'>) {
  const body = Buffer.from(JSON.stringify({ v: 1, ...input, actor: actorDigest(session), expires: Date.now() + 10 * 60_000, nonce: randomUUID() } satisfies ReplacementToken)).toString('base64url');
  return `${body}.${signature(body).toString('base64url')}`;
}

export function readPersonalReplacementToken(session: AdminSession, token: string, action: ReplacementToken['action']): ReplacementToken {
  if (typeof token !== 'string' || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw conflict();
  const [body, mac] = token.split('.');
  const supplied = Buffer.from(mac, 'base64url');
  if (supplied.length !== 32 || !timingSafeEqual(signature(body), supplied)) throw conflict();
  let parsed: ReplacementToken;
  try { parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw conflict(); }
  if (parsed?.v !== 1 || parsed.action !== action || parsed.actor !== actorDigest(session)
    || !Number.isSafeInteger(parsed.expires) || parsed.expires < Date.now()
    || !parsed.recipient || !['manager', 'admin'].includes(parsed.recipient.source)
    || !Number.isSafeInteger(parsed.recipient.id) || parsed.recipient.id < 1
    || !/^[a-f0-9]{64}$/.test(parsed.fingerprint) || !/^[a-f0-9]{64}$/.test(parsed.incoming)) throw conflict();
  return parsed;
}
