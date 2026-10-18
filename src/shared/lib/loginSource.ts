import { isIP } from 'node:net';

/**
 * The production nginx proxy overwrites X-Real-IP with $remote_addr and Next
 * listens on loopback only. Do not use X-Forwarded-For here: its leading values
 * can be supplied by a client, as can the login/session cookie.
 */
export function getLoginSourceIp(request: Request): string | null {
  const value = request.headers.get('x-real-ip')?.trim();
  if (!value) return process.env.NODE_ENV === 'production' ? null : '127.0.0.1';
  const version = isIP(value);
  if (version === 4) return value;
  // Zone IDs are local interface identifiers, not public client identities.
  if (version !== 6 || value.includes('%')) return null;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}
