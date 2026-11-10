import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { activateAndEnter, freshCode } from './activation.js';
import { expectAccessible } from './axe.js';

const state = JSON.parse(readFileSync(resolve(import.meta.dirname, '.state.json'), 'utf8')) as {
  recoveryOperator: { email: string; code: string };
  recoveryTenant: { slug: string; email: string; code: string };
};

/** A made-up Italian VAT number with a valid check digit, different at every run. */
function newVat(): string {
  const first10 = Array.from({ length: 10 }, (_, i) =>
    i === 0 ? randomInt(1, 10) : randomInt(10),
  ).join('');
  let sum = 0;
  first10.split('').forEach((char, i) => {
    const digit = Number(char) * (i % 2 === 0 ? 1 : 2);
    sum += digit > 9 ? digit - 9 : digit;
  });
  return first10 + String((10 - (sum % 10)) % 10);
}

/** A desktop picture, and the same page at tablet width, for the artifact "responsive-screens". */
async function snapBoth(page: Page, name: string) {
  await page.screenshot({ path: `screens/desktop-${name}.png`, fullPage: true });
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.screenshot({ path: `screens/tablet-${name}.png`, fullPage: true });
  await page.setViewportSize(size);
}

// Phase 8b from the browser (docs/adr/0039): the operator adds a company to a customer, recovers
// the account of its administrator, then adds a second operator and revokes them. The
// irreversible actions ask for a fresh one-time code, so the test waits for the next one.
test('companies, account recovery and operators from the platform area', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const run = String(randomInt(100_000, 1_000_000));
  const secret = await activateAndEnter(page, state.recoveryOperator.code, /^Clienti$/);

  // The administrator of the customer, in a browser of their own.
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await activateAndEnter(admin, state.recoveryTenant.code);
  await expect(admin.getByLabel('Azienda:')).toHaveCount(0);

  await test.step('a further company: the administrator can choose it', async () => {
    await page.getByLabel('Cerca per nome o identificativo').fill(state.recoveryTenant.slug);
    await page.getByRole('link', { name: /Browser Magazzino rc/ }).click();
    await page.getByRole('button', { name: 'Aggiungi azienda' }).click();
    await page.getByLabel('Ragione sociale').fill(`Seconda ${run} Srl`);
    await page.getByLabel('Partita IVA').fill(newVat());
    const form = page.getByRole('heading', { name: 'Nuova azienda' }).locator('xpath=..');
    await form.getByRole('button', { name: 'Aggiungi', exact: true }).click();
    await expect(page.getByText(`Seconda ${run} Srl aggiunta.`, { exact: false })).toBeVisible();

    await admin.reload();
    await expect(admin.getByLabel('Azienda:')).toBeVisible();
  });

  await test.step('recovery: the administrator starts over with a new authenticator', async () => {
    await page.getByRole('link', { name: 'Recupero account' }).click();
    await page.getByLabel('Email').fill(state.recoveryTenant.email);
    await page.getByRole('button', { name: 'Cerca' }).click();
    await expect(page.getByText(/Browser Magazzino rc/)).toBeVisible();
    await expectAccessible(page, 'platform recovery');
    await snapBoth(page, 'platform-recovery');

    await page.getByRole('button', { name: 'Genera codice di recupero' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByLabel('Motivo').fill('Telefono perso, prova del browser');
    await dialog
      .getByLabel("Codice dell'app di autenticazione")
      .fill(await freshCode(page, secret));
    await dialog.getByRole('button', { name: 'Genera codice di recupero' }).click();
    // The confirmation closes and the code opens: page locators, not one dialog.
    await expect(page.getByRole('heading', { name: /^Codice di recupero per/ })).toBeVisible();
    const code = (await page.getByTestId('activation-code').innerText()).trim();
    await page.getByRole('button', { name: 'Chiudi' }).click();

    // The old session is closed at once: the next page asks to sign in.
    await admin.reload();
    await expect(admin.getByRole('button', { name: 'Accedi' })).toBeVisible();
    await adminContext.close();

    const againContext = await browser.newContext();
    const again = await againContext.newPage();
    await activateAndEnter(again, code);
    await again.getByRole('link', { name: 'Attività' }).click();
    await expect(again.getByText("Codice di recupero dell'account generato").first()).toBeVisible();
    await againContext.close();
  });

  await test.step('operators: a second one enters, then is revoked', async () => {
    await page.getByRole('link', { name: 'Operatori' }).click();
    await page.getByRole('button', { name: 'Aggiungi operatore' }).click();
    let dialog = page.getByRole('alertdialog');
    await dialog.getByLabel('Email').fill(`secondo-op-${run}@example.com`);
    await dialog.getByLabel('Nome').fill(`Secondo Operatore ${run}`);
    await dialog
      .getByLabel("Codice dell'app di autenticazione")
      .fill(await freshCode(page, secret));
    await dialog.getByRole('button', { name: 'Aggiungi operatore' }).click();
    const code = (await page.getByTestId('activation-code').innerText()).trim();
    await page.getByRole('button', { name: 'Chiudi' }).click();

    const secondContext = await browser.newContext();
    const second = await secondContext.newPage();
    await activateAndEnter(second, code, /^Clienti$/);

    await page.reload();
    const row = page.getByRole('row', { name: new RegExp(`Secondo Operatore ${run}`) });
    await expect(row).toBeVisible();
    await expectAccessible(page, 'platform operators');
    await snapBoth(page, 'platform-operators');

    await row.getByRole('button', { name: 'Revoca' }).click();
    dialog = page.getByRole('alertdialog');
    await dialog.getByLabel('Motivo').fill('Fine della prova');
    await dialog
      .getByLabel("Codice dell'app di autenticazione")
      .fill(await freshCode(page, secret));
    await dialog.getByRole('button', { name: 'Revoca' }).click();
    await expect(page.getByText(`Secondo Operatore ${run} non è più un operatore.`)).toBeVisible();

    // Effective at the next request: the area is closed to them.
    await second.goto('/mercurio/platform/tenants');
    await expect(second.getByRole('heading', { name: /^Clienti$/ })).toHaveCount(0);
    await expect(second).not.toHaveURL(/\/platform\//);
    await secondContext.close();
  });
});
