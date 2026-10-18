// Server-only client credentials. Never import from client components.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

import { getAdminSessionSecret } from './authSecret';
import { verifyEmployeePasswordCopy } from './employeePasswordVault';

const PURPOSE = 'kts:client-password:v1';
type KeySource = 'dedicated' | 'session';

function encryptionKey(source: KeySource) {
  if (typeof window !== 'undefined') throw new Error('Client password vault is server-only');
  let secret: string | Buffer;
  if (source === 'dedicated') {
    const encoded = process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY ?? '';
    secret = Buffer.from(encoded, 'base64');
    if (secret.length !== 32 || secret.toString('base64') !== encoded) {
      throw new Error('EMPLOYEE_PASSWORD_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    }
  } else {
    secret = getAdminSessionSecret();
    if (process.env.NODE_ENV === 'production' && Buffer.byteLength(secret) < 32) {
      throw new Error('A strong ADMIN_SESSION_SECRET is required for client password storage');
    }
  }
  // Reuse the stable deployment secret, never the employee encryption key itself.
  // Purpose separation also makes employee packets unusable in the client vault.
  return Buffer.from(hkdfSync('sha256', secret, PURPOSE, 'encryption', 32));
}

function associatedData(passwordHash: string) {
  if (!/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(passwordHash)) throw new Error('Invalid client password hash');
  return Buffer.from(`${PURPOSE}:${createHash('sha256').update(passwordHash).digest('hex')}`);
}

export function encryptClientPassword(password: string, passwordHash: string) {
  if (!password || password.length > 200) throw new Error('Invalid client password length');
  const source: KeySource = process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY ? 'dedicated' : 'session';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(source), iv);
  cipher.setAAD(associatedData(passwordHash));
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return ['v1', source, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptClientPassword(ciphertext: string | null | undefined, passwordHash: string): string | null {
  if (!ciphertext || ciphertext.length > 2048) return null;
  const parts = ciphertext.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1' || !['dedicated', 'session'].includes(parts[1])) return null;
  if (parts.slice(2).some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  const iv = Buffer.from(parts[2], 'base64url');
  const tag = Buffer.from(parts[3], 'base64url');
  if (iv.length !== 12 || tag.length !== 16) return null;
  // Missing keys are an operational error, not an absent display copy.
  const key = encryptionKey(parts[1] as KeySource);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(associatedData(passwordHash));
    decipher.setAuthTag(tag);
    const password = Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64url')), decipher.final()]).toString('utf8');
    return password && password.length <= 200 ? password : null;
  } catch {
    return null; // Changed hash, wrong key or tampering must never reveal an old copy.
  }
}

export async function resolveClientPasswordCiphertext(input: {
  passwordHash: string;
  previousCiphertext?: string | null;
  legacyPassword?: string | null;
  preserveOpaqueOnKeyFailure?: boolean;
}) {
  if (input.previousCiphertext) {
    try {
      if (decryptClientPassword(input.previousCiphertext, input.passwordHash) !== null) return input.previousCiphertext;
    } catch (error) {
      // An unrelated profile edit can retain the opaque copy without reading it.
      // A migration must still fail rather than discard recoverable plaintext.
      if (input.preserveOpaqueOnKeyFailure && !input.legacyPassword) return input.previousCiphertext;
      throw error;
    }
  }
  if (input.legacyPassword && await verifyEmployeePasswordCopy(input.legacyPassword, input.passwordHash)) {
    return encryptClientPassword(input.legacyPassword, input.passwordHash);
  }
  // Keep an opaque copy on profile-only changes; read authentication still fails
  // closed if the key/hash changes. A password replacement never uses this path.
  return input.previousCiphertext ?? null;
}
