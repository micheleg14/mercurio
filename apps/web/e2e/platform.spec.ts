import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { activateAndEnter } from './activation.js';
import { expectAccessible } from './axe.js';

const state = JSON.parse(readFileSync(resolve(import.meta.dirname, '.state.json'), 'utf8')) as {
  operator: { email: string; code: string };
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

// Phase 8a from the browser (docs/adr/0038): the operator granted at installation activates the
// account, creates a customer, and its first administrator enters with the code; the operator then
// switches on a module and the administrator finds it, and suspends and reactivates the customer.
test('a customer born from the browser, governed by the platform operator', async ({
  page,
  browser,
}) => {
  const run = String(randomInt(100_000, 1_000_000));
  // No customer of their own: the operator lands on the list of customers.
  await activateAndEnter(page, state.operator.code, /^Clienti$/);
  await expect(page.getByText('Piattaforma').first()).toBeVisible();
  await expectAccessible(page, 'platform customers');
  await page.screenshot({ path: 'screens/desktop-platform-list.png', fullPage: true });

  await page.getByRole('link', { name: 'Nuovo cliente' }).click();
  await page.getByLabel('Nome', { exact: true }).fill(`Gruppo Verdi ${run}`);
  await expect(page.getByLabel('Identificativo')).toHaveValue(`gruppo-verdi-${run}`);
  await page.getByLabel('Ragione sociale').fill(`Verdi ${run} Srl`);
  await page.getByLabel('Partita IVA').fill(newVat());
  await page.getByRole('checkbox', { name: /^Magazzino/ }).click();
  await page.getByLabel('Email').fill(`laura-${run}@example.com`);
  await page.getByLabel('Nome e cognome').fill('Laura Verdi');
  await page.screenshot({ path: 'screens/desktop-platform-new.png', fullPage: true });
  await page.getByRole('button', { name: 'Crea il cliente' }).click();

  const dialog = page.getByRole('alertdialog');
  const code = (await dialog.getByTestId('activation-code').innerText()).trim();
  await dialog.getByRole('button', { name: 'Chiudi' }).click();
  await expect(page.getByRole('heading', { name: `Gruppo Verdi ${run}` })).toBeVisible();
  await expect(page.getByText('In attesa di attivazione')).toBeVisible();

  // The first administrator, in a browser of their own: only the modules chosen.
  const other = await browser.newContext();
  const admin = await other.newPage();
  await activateAndEnter(admin, code);
  await expect(admin.getByRole('link', { name: 'Magazzini' })).toBeVisible();
  await expect(admin.getByRole('link', { name: 'Ordini clienti' })).toHaveCount(0);

  // The operator switches Orders on: the administrator finds it at the next page.
  await page.reload();
  await page.getByRole('checkbox', { name: /^Ordini/ }).click();
  await page.getByRole('button', { name: 'Salva i moduli' }).click();
  await expect(page.getByText('Moduli salvati.')).toBeVisible();
  await admin.reload();
  await expect(admin.getByRole('link', { name: 'Ordini clienti' })).toBeVisible();

  // Suspended with a reason, then reactivated.
  await page.getByLabel('Motivo').fill('Prova di sospensione');
  await page.getByRole('button', { name: 'Sospendi' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Sospendi' }).click();
  await expect(page.getByRole('button', { name: 'Riattiva' })).toBeVisible();
  await expect(page.getByText('Sospeso', { exact: true }).first()).toBeVisible();
  await page.getByLabel('Motivo').fill('Fine della prova');
  await page.getByRole('button', { name: 'Riattiva' }).click();
  await expect(page.getByRole('button', { name: 'Sospendi' })).toBeVisible();
  await expect(page.getByText('Attivo', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Riattivato: Fine della prova/)).toBeVisible();
  await expectAccessible(page, 'platform customer');
  await page.screenshot({ path: 'screens/desktop-platform-tenant.png', fullPage: true });
  await page.screenshot({ path: 'screens/readme-platform.png' });

  // The administrator's own Activity names who did it as the Mercurio operator.
  await admin.reload();
  await admin.getByRole('link', { name: 'Attività' }).click();
  await expect(admin.getByText('Operatore Mercurio').first()).toBeVisible();
  await other.close();
});
