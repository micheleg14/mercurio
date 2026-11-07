import { NestFactory } from '@nestjs/core';
import { CliModule } from '../src/cli/cli.module.js';
import type { CliIo } from '../src/cli/commands.js';
import { runCli } from '../src/cli/run-cli.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { hashActivationCode } from '../src/modules/identity/activation-code.js';
import { adminClient, deleteTenantsAndUsers, uniqueSuffix } from './support/database.js';

// The terminal commands end to end, in-process: same code as `node dist/cli.js`, connected
// as the owner role (DATABASE_ADMIN_URL), output captured.
describe('terminal commands (e2e)', () => {
  let admin: PrismaClient;
  const suffix = uniqueSuffix();
  const slug = `cli-${suffix}`;
  const email = (name: string) => `${name}.${suffix}@example.com`;

  async function cli(...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const audit: Record<string, unknown>[] = [];
    const io: CliIo = {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      audit: (event) => audit.push(event),
    };
    const code = await runCli(argv, io, () =>
      NestFactory.createApplicationContext(CliModule, { logger: false }),
    );
    return { code, out: out.join('\n'), err: err.join('\n'), audit };
  }

  /** The activation code printed by a command (43 base64url characters on their own line). */
  const printedCode = (out: string) => /^ {2}([A-Za-z0-9_-]{43})$/m.exec(out)?.[1];

  beforeAll(() => {
    admin = adminClient();
  });

  afterAll(async () => {
    const tenants = await admin.tenant.findMany({ where: { slug: { startsWith: slug } } });
    const users = await admin.user.findMany({
      where: { email: { endsWith: `.${suffix}@example.com` } },
    });
    await deleteTenantsAndUsers(
      admin,
      tenants.map((t) => t.id),
      users.map((u) => u.id),
    );
    await admin.$disconnect();
  });

  it('prints help without touching the database', async () => {
    const res = await cli('help');

    expect(res.code).toBe(0);
    expect(res.out).toContain('create-tenant');
    expect(res.out).toContain('list-tenants');
  });

  it('rejects unknown commands, unknown options and missing options as usage errors', async () => {
    expect((await cli('drop-everything')).code).toBe(2);
    expect((await cli('remove-user', '--tenant', slug, '--force')).code).toBe(2);
    const missing = await cli('add-user', '--tenant', slug, '--email', email('x'));
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('Missing: --name, --role, --companies');
  });

  it('creates a tenant with company, modules and administrator, showing the code once', async () => {
    const res = await cli(
      'create-tenant',
      '--name',
      'Cli Test',
      '--slug',
      slug,
      '--modules',
      'warehouse',
      '--company-name',
      'Cli Srl',
      '--vat',
      'IT12345678903',
      '--admin-email',
      email('Anna'),
      '--admin-name',
      'Anna',
    );

    expect(res.code).toBe(0);
    expect(res.out).toContain(`Tenant ${slug} created`);
    expect(res.out).toContain('modules: registry, warehouse');
    const code = printedCode(res.out);
    expect(code).toBeDefined();
    const user = await admin.user.findUniqueOrThrow({
      where: { email: email('anna') },
      include: { activationTokens: true },
    });
    expect(user.activationTokens.map((t) => t.tokenHash)).toEqual([hashActivationCode(code!)]);
    // The audit record says what happened, never the code.
    expect(res.audit).toEqual([
      expect.objectContaining({ command: 'create-tenant', tenant: slug, admin: email('anna') }),
    ]);
    expect(JSON.stringify(res.audit)).not.toContain(code);
  });

  it('adds a company and a person limited to it, named by VAT number', async () => {
    expect(
      (
        await cli(
          'add-company',
          '--tenant',
          slug,
          '--name',
          'Cli Logistica Srl',
          '--vat',
          '00000000018',
        )
      ).code,
    ).toBe(0);

    const res = await cli(
      'add-user',
      '--tenant',
      slug,
      '--email',
      email('marco'),
      '--name',
      'Marco',
      '--role',
      'warehouse_keeper',
      '--companies',
      '00000000018',
    );

    expect(res.code).toBe(0);
    expect(printedCode(res.out)).toBeDefined();
    const list = await cli('list-tenants');
    expect(list.out).toContain(`${email('marco')}  WAREHOUSE_KEEPER  [ACTIVE]  00000000018`);
  });

  it('refuses rule violations with exit code 1 and the error code', async () => {
    const dependency = await cli(
      'set-modules',
      '--tenant',
      slug,
      '--disable',
      'warehouse',
      '--enable',
      'orders',
    );
    expect(dependency).toMatchObject({ code: 1 });
    expect(dependency.err).toContain('MODULE_REQUIRED_BY_OTHER');

    const foreignCompany = await cli(
      'add-user',
      '--tenant',
      slug,
      '--email',
      email('x'),
      '--name',
      'X',
      '--role',
      'READ_ONLY',
      '--companies',
      '99999999990',
    );
    expect(foreignCompany.code).toBe(1);
    expect(foreignCompany.err).toContain('COMPANY_NOT_IN_TENANT');

    const unknownTenant = await cli(
      'remove-user',
      '--tenant',
      `nobody-${suffix}`,
      '--email',
      email('x'),
    );
    expect(unknownTenant.err).toContain('TENANT_NOT_FOUND');
  });

  it('removes a person and issues a new code that replaces the old one', async () => {
    expect((await cli('remove-user', '--tenant', slug, '--email', email('marco'))).code).toBe(0);
    expect((await cli('list-tenants')).out).toContain(
      `${email('marco')}  WAREHOUSE_KEEPER  [REMOVED]`,
    );

    const issued = await cli('issue-code', '--email', email('marco'));
    expect(issued.code).toBe(0);
    const tokens = await admin.activationToken.findMany({
      where: { user: { email: email('marco') } },
    });
    expect(tokens.map((t) => t.tokenHash)).toEqual([hashActivationCode(printedCode(issued.out)!)]);
  });
  // The first platform operator is born here, at installation (docs/adr/0038).
  it('grants, lists and revokes platform operators', async () => {
    const unknown = await cli('grant-operator', '--email', email('nobody'));
    expect(unknown.code).not.toBe(0);
    expect(unknown.err).toContain('--name');

    const granted = await cli('grant-operator', '--email', email('opera'), '--name', 'Opera Tore');
    expect(granted.code).toBe(0);
    const code = printedCode(granted.out);
    const user = await admin.user.findUniqueOrThrow({ where: { email: email('opera') } });
    expect(
      await admin.activationToken.count({ where: { tokenHash: hashActivationCode(code!) } }),
    ).toBe(1);
    expect(granted.audit).toEqual([{ command: 'grant-operator', email: email('opera') }]);

    const twice = await cli('grant-operator', '--email', email('opera'));
    expect(twice.code).not.toBe(0);
    expect(twice.err).toContain('ALREADY_PLATFORM_OPERATOR');

    expect((await cli('list-operators')).out).toMatch(
      new RegExp(`${email('opera').replace(/\./g, '\\.')}  Opera Tore  granted \\S+  active`),
    );

    const revoked = await cli(
      'revoke-operator',
      '--email',
      email('opera'),
      '--reason',
      'Ha cambiato ruolo',
    );
    expect(revoked.code).toBe(0);
    expect(revoked.out).toContain('revoke-sessions');
    expect((await cli('list-operators')).out).toContain('(Ha cambiato ruolo)');
    expect(
      (await cli('revoke-operator', '--email', email('opera'), '--reason', 'x')).err,
    ).toContain('NOT_PLATFORM_OPERATOR');

    // Granted again later: a new row, the old one stays as history.
    expect((await cli('grant-operator', '--email', email('opera'))).code).toBe(0);
    const grants = await admin.platformOperator.findMany({ where: { userId: user.id } });
    expect(grants.filter((g) => g.revokedAt === null)).toHaveLength(1);
    expect(grants).toHaveLength(2);
    const events = await admin.authEvent.findMany({
      where: { userId: user.id },
      orderBy: { at: 'asc' },
    });
    expect(events.map((e) => e.type)).toEqual([
      'OPERATOR_GRANTED',
      'OPERATOR_REVOKED',
      'OPERATOR_GRANTED',
    ]);
  });
});
