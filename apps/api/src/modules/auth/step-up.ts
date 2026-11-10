import { decryptSecret } from './secret-box.js';
import { verifyTotp } from './totp.js';

/**
 * The actions that ask the operator for a fresh one-time code (docs/adr/0039): they cannot be
 * undone, or they hand an account over. A stolen session alone is not enough for them.
 */
export const STEP_UP_ACTIONS = ['ACCOUNT_RECOVERY', 'OPERATOR_GRANT', 'OPERATOR_REVOKE'] as const;
export type StepUpAction = (typeof STEP_UP_ACTIONS)[number];

/** What a step-up check concluded: the step to remember, or why it was refused. */
export type StepUpCheck = { result: 'OK'; step: number } | { result: 'INVALID' | 'LOCKED' };

interface StepUpCredential {
  totpSecretEnc: string | null;
  totpConfirmedAt: Date | null;
  totpLastStep: bigint | null;
  lockedUntil: Date | null;
}

/**
 * Checks a code against the credential, without touching the database. A locked account is
 * refused before looking at the code; a code already used (its step at or before the last one)
 * is as wrong as a mistyped one.
 */
export function checkStepUp(
  credential: StepUpCredential | null,
  code: string,
  encryptionKey: Buffer,
  at = Date.now(),
): StepUpCheck {
  if (credential?.lockedUntil && credential.lockedUntil.getTime() > at) {
    return { result: 'LOCKED' };
  }
  if (!credential?.totpSecretEnc || !credential.totpConfirmedAt) return { result: 'INVALID' };
  const secret = decryptSecret(credential.totpSecretEnc, encryptionKey);
  const step = verifyTotp(secret, code.trim(), credential.totpLastStep, at);
  return step === null ? { result: 'INVALID' } : { result: 'OK', step };
}
