import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);

/** Preserve the existing login hash format without blocking the request worker. */
export async function hashEmployeePassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = await deriveKey(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${hash.toString('hex')}`;
}
