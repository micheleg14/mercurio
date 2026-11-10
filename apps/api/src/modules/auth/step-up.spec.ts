import { randomBytes } from 'node:crypto';
import { encryptSecret } from './secret-box.js';
import { checkStepUp } from './step-up.js';
import { newTotpSecret, totpCode, TOTP_PERIOD_SECONDS } from './totp.js';

const key = randomBytes(32);
const at = 1_700_000_000_000;
const step = Math.floor(at / 1000 / TOTP_PERIOD_SECONDS);

describe('step-up check', () => {
  const secret = newTotpSecret();
  const credential = (changes: Partial<Parameters<typeof checkStepUp>[0] & object> = {}) => ({
    totpSecretEnc: encryptSecret(secret, key),
    totpConfirmedAt: new Date(at - 86_400_000),
    totpLastStep: null,
    lockedUntil: null,
    ...changes,
  });

  it('accepts the current code and returns its step', () => {
    expect(checkStepUp(credential(), totpCode(secret, at), key, at)).toEqual({
      result: 'OK',
      step,
    });
    expect(checkStepUp(credential(), ` ${totpCode(secret, at)} `, key, at).result).toBe('OK');
  });

  it('refuses a wrong code', () => {
    const wrong = totpCode(secret, at) === '000000' ? '111111' : '000000';
    expect(checkStepUp(credential(), wrong, key, at)).toEqual({ result: 'INVALID' });
  });

  it('refuses a code already used: the operator waits for the next one', () => {
    const used = credential({ totpLastStep: BigInt(step) });
    expect(checkStepUp(used, totpCode(secret, at), key, at)).toEqual({ result: 'INVALID' });
    expect(checkStepUp(used, totpCode(secret, at + 30_000), key, at + 30_000).result).toBe('OK');
  });

  it('refuses a locked account before looking at the code, until the lock expires', () => {
    const locked = credential({ lockedUntil: new Date(at + 60_000) });
    expect(checkStepUp(locked, totpCode(secret, at), key, at)).toEqual({ result: 'LOCKED' });
    expect(checkStepUp(locked, totpCode(secret, at + 90_000), key, at + 90_000).result).toBe('OK');
  });

  it('refuses without a confirmed authenticator, or without credentials', () => {
    expect(
      checkStepUp(credential({ totpConfirmedAt: null }), totpCode(secret, at), key, at),
    ).toEqual({ result: 'INVALID' });
    expect(checkStepUp(null, totpCode(secret, at), key, at)).toEqual({ result: 'INVALID' });
  });
});
