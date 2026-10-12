// Server-only credential storage. Never import this module from client components.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import { getAdminSessionSecret } from './authSecret';

const PURPOSE = 'kts:employee-password:v1';
type KeySource = 'dedicated' | 'session';

function encryptionKey(source: KeySource) {
  if (typeof window !== 'undefined') throw new Error('Employee password vault is server-only');
  if (source === 'dedicated') {
    const encoded = process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY ?? '';
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) {
      throw new Error('EMPLOYEE_PASSWORD_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    }
    return key;
  }
  // Separate purpose/key from session signatures; the secret is stable across releases.
  const secret = getAdminSessionSecret();
  if (process.env.NODE_ENV === 'production' && Buffer.byteLength(secret) < 32) {
    throw new Error('A strong ADMIN_SESSION_SECRET is required for employee password storage');
  }
  return Buffer.from(hkdfSync('sha256', secret, PURPOSE, 'encryption', 32));
}

function associatedData(passwordHash: string) {
  if (!/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(passwordHash)) {
    throw new Error('Invalid employee password hash');
  }
  // The random salt in the login hash binds this encrypted copy to this exact credential.
  return Buffer.from(`${PURPOSE}:${createHash('sha256').update(passwordHash).digest('hex')}`);
}

export function encryptEmployeePassword(password: string, passwordHash: string): string {
  if (!password || password.length > 200) throw new Error('Invalid employee password length');
  const source: KeySource = process.env.EMPLOYEE_PASSWORD_ENCRYPTION_KEY ? 'dedicated' : 'session';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(source), iv);
  cipher.setAAD(associatedData(passwordHash));
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  return ['v1', source, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptEmployeePassword(ciphertext: string | null | undefined, passwordHash: string): string | null {
  if (!ciphertext || ciphertext.length > 2048) return null;
  const parts = ciphertext.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1' || !['dedicated', 'session'].includes(parts[1])) return null;
  if (parts.slice(2).some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  const iv = Buffer.from(parts[2], 'base64url');
  const tag = Buffer.from(parts[3], 'base64url');
  if (iv.length !== 12 || tag.length !== 16) return null;
  // Missing key is operational failure, not evidence that a password was not saved.
  const key = encryptionKey(parts[1] as KeySource);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(associatedData(passwordHash));
    decipher.setAuthTag(tag);
    const password = Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64url')), decipher.final()]).toString('utf8');
    return password && password.length <= 200 ? password : null;
  } catch {
    return null; // Tampering, stale ciphertext, or key rotation: never return an old password.
  }
}

export async function verifyEmployeePasswordCopy(password: string, passwordHash: string): Promise<boolean> {
  if (!password || password.length > 200 || !/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(passwordHash)) return false;
  const [, salt, hash] = passwordHash.split(':');
  const actual = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, (error, result) => error ? reject(error) : resolve(result));
  });
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

export async function resolveEmployeePasswordCiphertext(input: {
  password?: string;
  passwordHash: string;
  previousCiphertext?: string | null;
  legacyPassword?: string | null;
}): Promise<string | null> {
  if (input.password !== undefined) return encryptEmployeePassword(input.password, input.passwordHash);
  if (input.previousCiphertext) {
    // Profile-only edits must not destroy the only recoverable copy during an
    // accidental key/configuration change. Reads still authenticate against the
    // current hash; preserving an opaque packet cannot expose an old password.
    try {
      if (decryptEmployeePassword(input.previousCiphertext, input.passwordHash) !== null) return input.previousCiphertext;
    } catch {
      return input.previousCiphertext;
    }
  }
  if (input.legacyPassword && await verifyEmployeePasswordCopy(input.legacyPassword, input.passwordHash)) {
    return encryptEmployeePassword(input.legacyPassword, input.passwordHash);
  }
  return input.previousCiphertext ?? null;
}
