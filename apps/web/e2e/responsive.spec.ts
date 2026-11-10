import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { activateAndEnter } from './activation.js';
import { expectAccessible } from './axe.js';

// The interface on a phone and on a tablet (docs/conventions.md F20), with demo people other
// than those of registry.spec.ts, so no two tests spend the same one-time code.
const DEMO_PASSWORD = 'Demo-password-2026';
const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

async function signInAs(page: Page, email: string, landing: RegExp = /^Ciao/) {
  await page.goto('/mercurio/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Accedi' }).click();
  await page
    .getByLabel('Codice')
    .fill(new TOTP({ secret: Secret.fromBase32(DEMO_TOTP_SECRET) }).generate());
  await page.getByRole('button', { name: 'Verifica' }).click();
  await expect(page.getByRole('heading', { name: landing })).toBeVisible();
}

/** A picture of the screen for the CI artifact "responsive-screens", to look at the layout. */
async function snap(page: Page, name: string) {
  await page.screenshot({
    path: `screens/${test.info().project.name}-${name}.png`,
    fullPage: true,
  });
}

/** The page never scrolls sideways: everything fits the width of the screen. */
async function expectNoHorizontalScroll(page: Page) {
  // A string runs in the page: this file is compiled without the DOM types.
  const overflow = (await page.evaluate(
    'document.documentElement.scrollWidth - document.documentElement.clientWidth',
  )) as number;
  expect(overflow).toBeLessThanOrEqual(0);
}

test('@phone menu in a panel, cards, a record with the actions at the bottom', async ({ page }) => {
  const name = `Cliente Telefono ${randomInt(100_000, 1_000_000)} Srl`;
  await signInAs(page, 'sara.neri@example.com');
  await expectNoHorizontalScroll(page);

  // The menu opens from the top bar, with the company choice.
  await page.getByRole('button', { name: 'Apri il menu' }).click();
  const panel = page.getByRole('dialog', { name: 'Menu principale' });
  await expect(panel.getByLabel('Azienda:')).toBeVisible();
  await snap(page, '1-menu');
  await panel.getByRole('link', { name: 'Clienti e fornitori' }).click();
  await expect(panel).toBeHidden();

  // Cards, not a table.
  await expect(page.getByRole('link', { name: 'Ferramenta Bruni Srl' })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await snap(page, '2-list');

  // A new customer, then a change with the bar at the bottom.
  await page.getByRole('link', { name: 'Nuovo soggetto' }).click();
  await page.getByLabel('Ragione sociale').fill(name);
  await page.getByLabel('Partita IVA').fill(newVat());
  await page.getByRole('button', { name: 'Salva' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Salva' })).toHaveCount(0);
  await page.getByLabel('Città', { exact: true }).fill('Como');
  await snap(page, '3-record-changed');
  await page.getByRole('button', { name: 'Salva' }).click();
  await expect(page.getByText('Modifiche salvate.')).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Archive from the icon next to the title; the question rises from the bottom.
  await page.getByRole('button', { name: 'Archivia' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await snap(page, '4-confirm');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Archivia' }).click();
  await expect(page.getByText(/Questa scheda è archiviata/)).toBeVisible();

  // The payment schedule as cards, and the overview's charts one under the other.
  await page.goto('/mercurio/invoicing/due-dates');
  await expect(page.getByText('Da incassare').first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectAccessible(page, 'phone-due-dates');
  await page.screenshot({ path: 'screens/readme-phone-due-dates.png' });
  await page.goto('/mercurio/');
  await expect(page.getByText('Da incassare per ritardo')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await snap(page, '5-overview');
});

test('@phone a receipt recorded from the phone, the stock as cards', async ({ page }) => {
  const state = JSON.parse(readFileSync(resolve(import.meta.dirname, '.state.json'), 'utf8')) as {
    warehousePhone: { code: string };
  };
  const code = `PH-${randomInt(100_000, 1_000_000)}`;
  await activateAndEnter(page, state.warehousePhone.code);
  const go = async (name: string) => {
    await page.getByRole('button', { name: 'Apri il menu' }).click();
    const panel = page.getByRole('dialog', { name: 'Menu principale' });
    await panel.getByRole('link', { name }).click();
    await expect(panel).toBeHidden();
  };

  await go('Magazzini');
  await page.getByRole('button', { name: 'Nuovo magazzino' }).click();
  await page.getByLabel('Codice').fill('SEDE');
  await page.getByLabel('Nome').fill('Magazzino della sede');
  await page.getByRole('button', { name: 'Salva' }).click();
  await expect(page.getByText('Magazzino della sede')).toBeVisible();

  await go('Articoli');
  await page.getByRole('link', { name: 'Nuovo articolo' }).click();
  await page.getByLabel('Codice', { exact: true }).fill(code);
  await page.getByLabel('Descrizione').fill('Articolo dal telefono');
  await page.getByRole('button', { name: 'Salva' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(code) })).toBeVisible();

  // The receipt: lines as cards, Record at the bottom of the screen.
  await go('Movimenti');
  await page.getByRole('link', { name: 'Nuovo carico' }).click();
  await page.getByLabel('Causale').selectOption({ label: 'Giacenza iniziale' });
  const item = page.getByRole('combobox', { name: /Riga 1/ });
  await item.click();
  await item.fill(code);
  await page.getByRole('option', { name: new RegExp(code) }).click();
  await page.getByLabel(/Quantità/).fill('3');
  await expectNoHorizontalScroll(page);
  await snap(page, '5-new-receipt');
  await page.getByRole('button', { name: 'Registra' }).click();
  await expect(page.getByRole('heading', { name: /^Documento CA-/ })).toBeVisible();

  await go('Giacenze');
  await expect(page.getByRole('link', { name: code })).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await snap(page, '6-stock');
});

test('@phone a purchase order written and received from the phone', async ({ page }) => {
  const state = JSON.parse(readFileSync(resolve(import.meta.dirname, '.state.json'), 'utf8')) as {
    ordersPhone: { code: string };
  };
  const run = randomInt(100_000, 1_000_000);
  const code = `PO-${run}`;
  const supplier = `Fornitore Telefono ${run} Srl`;
  await activateAndEnter(page, state.ordersPhone.code);
  const go = async (name: string) => {
    await page.getByRole('button', { name: 'Apri il menu' }).click();
    const panel = page.getByRole('dialog', { name: 'Menu principale' });
    await panel.getByRole('link', { name }).click();
    await expect(panel).toBeHidden();
  };

  await go('Magazzini');
  await page.getByRole('button', { name: 'Nuovo magazzino' }).click();
  await page.getByLabel('Codice').fill('SEDE');
  await page.getByLabel('Nome').fill('Magazzino della sede');
  await page.getByRole('button', { name: 'Salva' }).click();
  await expect(page.getByText('Magazzino della sede')).toBeVisible();

  await go('Articoli');
  await page.getByRole('link', { name: 'Nuovo articolo' }).click();
  await page.getByLabel('Codice', { exact: true }).fill(code);
  await page.getByLabel('Descrizione').fill('Articolo ordinato dal telefono');
  await page.getByRole('button', { name: 'Salva' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(code) })).toBeVisible();

  await go('Clienti e fornitori');
  await page.getByRole('link', { name: 'Nuovo soggetto' }).click();
  await page.getByLabel('Ragione sociale').fill(supplier);
  await page.getByLabel('Partita IVA').fill(newVat());
  await page.getByRole('checkbox', { name: 'Fornitore', exact: true }).check();
  await page.getByRole('button', { name: 'Salva' }).click();
  await expect(page.getByRole('heading', { name: supplier })).toBeVisible();

  // The order: header and a line as a card, the buttons at the bottom of the screen.
  await go('Ordini fornitori');
  await page.getByRole('link', { name: 'Nuovo ordine' }).click();
  const party = page.getByRole('combobox', { name: 'Fornitore' });
  await party.click();
  await party.fill(String(run));
  await page.getByRole('option', { name: new RegExp(supplier) }).click();
  const item = page.getByRole('combobox', { name: /Riga 1/ });
  await item.click();
  await item.fill(code);
  await page.getByRole('option', { name: new RegExp(code) }).click();
  await page.getByLabel(/Quantità/).fill('8');
  await page.getByLabel('Prezzo').fill('2,5');
  await expectNoHorizontalScroll(page);
  await snap(page, '7-new-order');
  await page.getByRole('button', { name: 'Salva e conferma' }).click();
  await expect(page.getByRole('heading', { name: /^Ordine OF-/ })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await snap(page, '8-order');

  // Received at the gate: the quantity is proposed, Record at the bottom.
  await page.getByRole('link', { name: 'Ricevi' }).click();
  await expect(page.getByLabel(/Arrivata/)).toHaveValue('8');
  await page.getByLabel(/Arrivata/).fill('5');
  await expectNoHorizontalScroll(page);
  await snap(page, '9-receive');
  await page.getByRole('button', { name: 'Registra la ricezione' }).click();
  await expect(page.getByText('Ricevuto in parte', { exact: true })).toBeVisible();

  await go('Ordini fornitori');
  await expect(page.getByRole('table')).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await snap(page, '10-orders');
});

// The platform area on a phone (phase 8a), with the operator of the demo seed: the customers as
// cards, a customer's page in one column.
test('@phone the platform area: customers as cards, a customer in one column', async ({ page }) => {
  await signInAs(page, 'operatore@example.com', /^Clienti$/);
  // Test runs add customers of their own: search, so the demo one is on the first page.
  await page.getByLabel('Cerca per nome o identificativo').fill('rossi');
  await expect(page.getByRole('link', { name: 'Gruppo Rossi' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await snap(page, 'platform-1-list');

  await page.getByRole('link', { name: 'Gruppo Rossi' }).click();
  await expect(page.getByRole('heading', { name: 'Gruppo Rossi' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Amministratori' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectAccessible(page, 'platform customer on a phone');
  await snap(page, 'platform-2-tenant');
});

test('@tablet icons-only sidebar, the table without secondary columns', async ({ page }) => {
  await signInAs(page, 'marco.verdi@example.com');
  await expect(page.getByRole('navigation', { name: 'Menu principale' })).toBeVisible();
  await page.getByRole('link', { name: 'Articoli' }).click();

  await expect(page.getByRole('columnheader', { name: /Codice/ })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'U.M.' })).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await snap(page, '1-list');

  // The whole menu opens over the content.
  await page.getByRole('button', { name: 'Apri il menu' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Menu principale' }).getByText('Anagrafiche'),
  ).toBeVisible();
  await snap(page, '2-menu');

  // The orders of the demo company, as a table that fits.
  await page
    .getByRole('dialog', { name: 'Menu principale' })
    .getByRole('link', { name: 'Ordini clienti' })
    .click();
  await expect(page.getByRole('link', { name: /^OC-/ }).first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  await snap(page, '3-orders');
});

test('@desktop the sidebar and the list on a desktop', async ({ page }) => {
  await signInAs(page, 'giorgio.bianchi@example.com');
  await page.getByRole('link', { name: 'Clienti e fornitori' }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await snap(page, '1-list');

  // Collapsed to icons and opened again from the same button.
  const toggle = page.getByRole('button', { name: 'Riduci o espandi il menu' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await snap(page, '2-collapsed');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('link', { name: 'Clienti e fornitori' })).toBeVisible();
});

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
