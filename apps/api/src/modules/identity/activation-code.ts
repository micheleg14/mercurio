import { createHash, randomBytes } from 'node:crypto';

export const ACTIVATION_CODE_DAYS = 7;
/** A recovery code replaces an account that works: it lasts one day (docs/adr/0039). */
export const RECOVERY_CODE_DAYS = 1;

/**
 * A one-time activation code: 256 random bits, shown once to whoever creates the user. Only its
 * SHA-256 hash is stored. A fast hash is enough because the code is random and long, unlike a
 * password, so it cannot be guessed from a list.
 */
export function newActivationCode(now = new Date(), days = ACTIVATION_CODE_DAYS) {
  const code = randomBytes(32).toString('base64url');
  return {
    code,
    hash: hashActivationCode(code),
    expiresAt: new Date(now.getTime() + days * 24 * 60 * 60 * 1000),
  };
}

export function hashActivationCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
