import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Appends the Italian VAT check digit, so the numbers pass the API's validation. */
function vat(first10: string): string {
  let sum = 0;
  first10.split('').forEach((char, i) => {
    const digit = Number(char) * (i % 2 === 0 ? 1 : 2);
    sum += digit > 9 ? digit - 9 : digit;
  });
  return first10 + String((10 - (sum % 10)) % 10);
}

const apiDir = resolve(import.meta.dirname, '../../api');

/** Runs a terminal command of the API, as the platform operator would. */
function cli(...args: string[]): string {
  return execFileSync('node', ['--env-file-if-exists=../../.env', 'dist/cli.js', ...args], {
    cwd: apiDir,
    encoding: 'utf8',
  });
}

/**
 * The fictitious demo (seed-demo, which also gives the demo people a known password and
 * authenticator secret outside production), used by the registry test. Then two fictitious
 * tenants made with the real terminal commands. The person is ADMIN of the first
 * (two companies) and READ_ONLY in the second, and receives an activation code, exactly as a new
 * customer would. Names are unique per run, so the database never needs cleaning between runs.
 */
export default function globalSetup(): void {
  // Adds only what is missing, so it can run against a database that already has the demo.
  cli('seed-demo');

  const run = randomBytes(3).toString('hex');
  const email = `browser-${run}@example.com`;
  const first = { slug: `browser-a-${run}`, name: `Browser Alfa ${run}` };
  const second = { slug: `browser-b-${run}`, name: `Browser Beta ${run}` };

  const created = cli(
    'create-tenant',
    ...['--name', first.name, '--slug', first.slug, '--modules', 'registry,warehouse'],
    ...['--company-name', 'Alfa Srl', '--vat', vat('0274651096')],
    ...['--admin-email', email, '--admin-name', 'Prova Browser'],
  );
  cli(
    'add-company',
    '--tenant',
    first.slug,
    '--name',
    'Alfa Logistica Srl',
    '--vat',
    vat('0381927364'),
  );
  cli(
    'create-tenant',
    ...['--name', second.name, '--slug', second.slug, '--modules', 'registry'],
    ...['--company-name', 'Beta Snc', '--vat', vat('0519283746')],
    ...['--admin-email', `browser-admin-${run}@example.com`, '--admin-name', 'Altro Admin'],
  );
  cli(
    'add-user',
    ...['--tenant', second.slug, '--email', email, '--name', 'Prova Browser'],
    ...['--role', 'READ_ONLY', '--companies', 'all'],
  );

  const code = activationCode(created);

  // The warehouse, from the desktop and from a phone: one new tenant each, with its own
  // administrator, so the two tests never spend the same one-time code.
  const warehouseTenant = (key: string, vatFirst10: string, modules = 'registry,warehouse') => {
    const admin = `browser-${key}-${run}@example.com`;
    const output = cli(
      'create-tenant',
      ...['--name', `Browser Magazzino ${key} ${run}`, '--slug', `browser-${key}-${run}`],
      ...['--modules', modules],
      ...['--company-name', `Magazzino ${key} Srl`, '--vat', vat(vatFirst10)],
      ...['--admin-email', admin, '--admin-name', `Magazziniere ${key}`],
    );
    return { email: admin, code: activationCode(output) };
  };

  writeFileSync(
    resolve(import.meta.dirname, '.state.json'),
    JSON.stringify({
      email,
      code,
      first: first.name,
      second: second.name,
      warehouseDesktop: warehouseTenant('wd', '0612345678'),
      warehousePhone: warehouseTenant('wp', '0723456789'),
      // Orders, likewise: one tenant for the desktop flow, one for the phone.
      ordersDesktop: warehouseTenant('od', '0834567890', 'registry,warehouse,orders'),
      ordersPhone: warehouseTenant('op', '0945678901', 'registry,warehouse,orders'),
      // Invoicing, from shipments of orders.
      invoicingDesktop: warehouseTenant('id', '1056789012', 'registry,warehouse,orders,invoicing'),
      // People, roles and companies (phase 7): an administrator who sets up their customer.
      members: warehouseTenant('mb', '1167890123', 'registry,warehouse'),
      // The platform operator (phase 8a), granted from the terminal as at installation.
      operator: platformOperator(run),
      // Phase 8b: another operator, and a customer whose administrator will lose access.
      recoveryOperator: platformOperator(`rc-${run}`),
      recoveryTenant: {
        slug: `browser-rc-${run}`,
        ...warehouseTenant('rc', '1278901234', 'registry,warehouse'),
      },
    }),
  );
}

/** A new platform operator with its activation code, as `grant-operator` prints it. */
function platformOperator(run: string) {
  const email = `browser-operator-${run}@example.com`;
  const output = cli('grant-operator', '--email', email, '--name', 'Operatrice Browser');
  return { email, code: activationCode(output) };
}

/** The activation code printed by create-tenant (shown once, as to an operator). */
function activationCode(output: string): string {
  const code = /^ {2}([A-Za-z0-9_-]{43})$/m.exec(output)?.[1];
  if (!code) throw new Error(`No activation code in the output of create-tenant:\n${output}`);
  return code;
}
