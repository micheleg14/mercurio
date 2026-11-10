import { expect, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

export const PASSWORD = 'una frase lunga per la prova';

const STEP_MS = 30_000;
/** The last 30-second step used with each secret: a code is accepted only once. */
const usedSteps = new Map<string, number>();

/** The current code of an authenticator, remembering its step as used. */
function codeNow(secret: string): string {
  usedSteps.set(secret, Math.floor(Date.now() / STEP_MS));
  return new TOTP({ secret: Secret.fromBase32(secret) }).generate();
}

/**
 * A code never used before with this secret, as an operator types it in a confirmation
 * (docs/adr/0039): right after another one, it waits for the next step (30 seconds at most).
 */
export async function freshCode(page: Page, secret: string): Promise<string> {
  const last = usedSteps.get(secret) ?? -1;
  while (Math.floor(Date.now() / STEP_MS) <= last) await page.waitForTimeout(1_000);
  return codeNow(secret);
}

/**
 * A new person's first entry, as in sign-in.spec.ts: password from the activation code, two-factor
 * setup, recovery codes saved. Ends on the overview of their only tenant, or on the heading given
 * (a platform operator lands on the list of customers). Returns the authenticator secret.
 */
export async function activateAndEnter(
  page: Page,
  code: string,
  landing: RegExp = /^Ciao/,
): Promise<string> {
  await page.goto(`/mercurio/activate#${code}`);
  await page.getByLabel('Nuova password').fill(PASSWORD);
  await page.getByLabel('Ripeti la password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Imposta la password' }).click();
  const secret = (await page.locator('code').innerText()).trim();
  await page.getByLabel('Codice a 6 cifre').fill(codeNow(secret));
  await page.getByRole('button', { name: 'Conferma' }).click();
  await page.getByLabel('Ho salvato i codici in un posto sicuro').check();
  await page.getByRole('button', { name: 'Entra in Mercurio' }).click();
  await expect(page.getByRole('heading', { name: landing })).toBeVisible();
  return secret;
}
