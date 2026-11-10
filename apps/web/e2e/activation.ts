import { expect, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';

export const PASSWORD = 'una frase lunga per la prova';

/**
 * A new person's first entry, as in sign-in.spec.ts: password from the activation code, two-factor
 * setup, recovery codes saved. Ends on the overview of their only tenant, or on the heading given
 * (a platform operator lands on the list of customers).
 */
export async function activateAndEnter(
  page: Page,
  code: string,
  landing: RegExp = /^Ciao/,
): Promise<void> {
  await page.goto(`/mercurio/activate#${code}`);
  await page.getByLabel('Nuova password').fill(PASSWORD);
  await page.getByLabel('Ripeti la password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Imposta la password' }).click();
  const secret = (await page.locator('code').innerText()).trim();
  await page
    .getByLabel('Codice a 6 cifre')
    .fill(new TOTP({ secret: Secret.fromBase32(secret) }).generate());
  await page.getByRole('button', { name: 'Conferma' }).click();
  await page.getByLabel('Ho salvato i codici in un posto sicuro').check();
  await page.getByRole('button', { name: 'Entra in Mercurio' }).click();
  await expect(page.getByRole('heading', { name: landing })).toBeVisible();
}
