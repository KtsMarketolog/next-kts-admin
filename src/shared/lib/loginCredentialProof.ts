import { createHmac, timingSafeEqual } from 'crypto';
import { getAdminSessionSecret } from './authSecret';

export class LoginCredentialsChangedError extends Error {
  constructor() { super('Login credentials changed; authenticate again'); }
}

export type LoginCredentialSnapshot = {
  id: number;
  login: string;
  email: string;
  passwordHash: string;
  passwordChangedAt: string | null;
};

function fingerprint(values: unknown[]) {
  return createHmac('sha256', getAdminSessionSecret())
    .update('kts:verified-login-credentials:v1\0').update(JSON.stringify(values)).digest('hex');
}

/** Server-only proof of precisely the credential snapshot whose password was checked. */
export function loginCredentialProof(actorType: 'admin' | 'manager' | 'client', role: string, user: LoginCredentialSnapshot) {
  return fingerprint([actorType, role, user.id, user.login, user.email, user.passwordHash, user.passwordChangedAt]);
}

export function environmentLoginCredentialProof(password: string) {
  return fingerprint(['environment-admin', password]);
}

export function assertLoginCredentialProof(expected: string, actual: string) {
  if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(actual)
    || !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))) {
    throw new LoginCredentialsChangedError();
  }
}
