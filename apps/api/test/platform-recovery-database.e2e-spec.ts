import { Test } from '@nestjs/testing';
import { AppConfigModule } from '../src/config/config.module.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaModule, type DbClient, UserDatabase } from '../src/prisma/index.js';
import {
  adminClient,
  createWorld,
  deleteTenantsAndUsers,
  deleteWorld,
  uniqueSuffix,
  type World,
} from './support/database.js';

// The functions of phase 8b (docs/adr/0039), called as the API role the way the API calls them:
// companies, the search for a person, account recovery and operators. As in phase 8a, the first
// block matters most: nobody but an active operator gets anything out of them.
describe('platform recovery and operator functions (e2e)', () => {
  let admin: PrismaClient;
  let users: UserDatabase;
  let world: World;
  let close: () => Promise<void>;
  let operator: string;
  let revoked: string;
  const createdUsers: string[] = [];
  const suffix = uniqueSuffix();
  const expires = new Date(Date.now() + 86_400_000);

  const person = async (key: string) => {
    const user = await admin.user.create({
      data: { email: `${key}-${suffix}@example.com`, name: key },
    });
    createdUsers.push(user.id);
    return user.id;
  };
  const grant = (userId: string) => admin.platformOperator.create({ data: { userId } });
  const emailOf = async (id: string) =>
    (await admin.user.findUniqueOrThrow({ where: { id } })).email;

  beforeAll(async () => {
    admin = adminClient();
    world = await createWorld(admin);
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule],
    }).compile();
    await moduleRef.init();
    users = moduleRef.get(UserDatabase);
    close = () => moduleRef.close();

    operator = await person('operator');
    revoked = await person('revoked');
    await grant(operator);
    await admin.platformOperator.create({
      data: { userId: revoked, revokedAt: new Date(), revokeReason: 'left' },
    });
  });

  afterAll(async () => {
    await close?.();
    await deleteTenantsAndUsers(admin, [], createdUsers);
    if (world) await deleteWorld(admin, world);
    await admin.$disconnect();
  });

  const as = <T>(userId: string, work: (tx: DbClient) => Promise<T>) => users.runAs(userId, work);
  const outcome = async (userId: string, query: (tx: DbClient) => Promise<{ o: string }[]>) =>
    (await as(userId, query))[0]!.o;

  describe('only an active operator', () => {
    const calls: Record<string, (tx: DbClient) => Promise<unknown>> = {
      company: (tx) =>
        tx.$queryRaw`SELECT * FROM app_platform_add_company(${world.tenants.a}::uuid, 'X Srl',
          '09999999999', NULL, 'IT')`,
      find: (tx) => tx.$queryRaw`SELECT app_platform_find_person('u@example.com')`,
      recovery: (tx) =>
        tx.$queryRaw`SELECT app_platform_issue_recovery_code(${world.users.u}::uuid, 'x', 'h',
          now())`,
      list: (tx) => tx.$queryRaw`SELECT * FROM app_platform_list_operators()`,
      grant: (tx) =>
        tx.$queryRaw`SELECT * FROM app_platform_grant_operator('x@example.com', 'X', true, 'h',
          now())`,
      revoke: (tx) =>
        tx.$queryRaw`SELECT app_platform_revoke_operator(${operator}::uuid, 'x', true)`,
      code: (tx) =>
        tx.$queryRaw`SELECT app_platform_issue_operator_code(${operator}::uuid, 'h', now())`,
    };

    it.each(Object.keys(calls))('%s: refused to a tenant administrator', async (name) => {
      await expect(as(world.users.u, calls[name]!)).rejects.toThrow(/NOT_PLATFORM_OPERATOR/);
    });

    it.each(Object.keys(calls))('%s: refused to a revoked operator', async (name) => {
      await expect(as(revoked, calls[name]!)).rejects.toThrow(/NOT_PLATFORM_OPERATOR/);
    });

    it('nothing changed for the refused calls', async () => {
      expect(await admin.company.count({ where: { tenantId: world.tenants.a } })).toBe(1);
      expect(await admin.activationToken.count({ where: { userId: world.users.u } })).toBe(0);
      expect(await admin.user.count({ where: { email: 'x@example.com' } })).toBe(0);
      expect(
        await admin.platformOperator.count({ where: { userId: operator, revokedAt: null } }),
      ).toBe(1);
      expect(
        await admin.auditEvent.count({ where: { tenantId: world.tenants.a, source: 'PLATFORM' } }),
      ).toBe(0);
    });
  });

  describe('companies', () => {
    const add = (tenantId: string, vat: string) =>
      as(
        operator,
        (tx) =>
          tx.$queryRaw<{ outcome: string; company_id: string | null }[]>`
          SELECT * FROM app_platform_add_company(${tenantId}::uuid, 'Nuova Srl', ${vat}, NULL,
            'IT')`,
      ).then((rows) => rows[0]!);

    it('adds a company without changing the tenant version, even when suspended', async () => {
      await admin.tenant.update({ where: { id: world.tenants.c }, data: { status: 'SUSPENDED' } });
      const before = await admin.tenant.findUniqueOrThrow({ where: { id: world.tenants.c } });

      const row = await add(world.tenants.c, '00000000005');

      expect(row.outcome).toBe('OK');
      const after = await admin.tenant.findUniqueOrThrow({ where: { id: world.tenants.c } });
      expect(after.version).toBe(before.version);
      expect(
        await admin.company.findUniqueOrThrow({ where: { id: row.company_id! } }),
      ).toMatchObject({ tenantId: world.tenants.c, legalName: 'Nuova Srl' });
      const event = await admin.auditEvent.findFirstOrThrow({
        where: { tenantId: world.tenants.c, type: 'COMPANY_ADDED' },
      });
      expect(event).toMatchObject({
        source: 'PLATFORM',
        actorUserId: operator,
        subjectId: row.company_id,
        details: { legalName: 'Nuova Srl', vatNumber: '00000000005' },
      });
      await admin.tenant.update({ where: { id: world.tenants.c }, data: { status: 'ACTIVE' } });
    });

    it('refuses a VAT number already in the tenant, and an unknown tenant', async () => {
      expect((await add(world.tenants.b, '00000000002')).outcome).toBe('VAT_EXISTS');
      expect((await add('0198a000-0000-7000-8000-00000000dead', '00000000006')).outcome).toBe(
        'NOT_FOUND',
      );
      expect(await admin.company.count({ where: { tenantId: world.tenants.b } })).toBe(2);
    });
  });

  describe('finding a person', () => {
    const find = async (email: string) =>
      (
        await as(
          operator,
          (tx) =>
            tx.$queryRaw<{ person: Record<string, unknown> | null }[]>`
            SELECT app_platform_find_person(${email}) AS person`,
        )
      )[0]!.person;

    it('by exact email, whatever the case, with where they work and nothing else', async () => {
      const email = await emailOf(world.users.u);
      const person = await find(`  ${email.toUpperCase()} `);

      expect(Object.keys(person!).sort()).toEqual([
        'activated',
        'email',
        'lastSeenAt',
        'memberships',
        'name',
        'operator',
        'status',
        'userId',
      ]);
      expect(person).toMatchObject({ userId: world.users.u, activated: false, operator: false });
      expect(person!.memberships).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tenantId: world.tenants.a, role: 'ADMIN' }),
          expect.objectContaining({ tenantId: world.tenants.b, role: 'READ_ONLY' }),
        ]),
      );
    });

    it('never a partial match', async () => {
      const email = await emailOf(world.users.u);
      expect(await find(email.slice(0, -4))).toBeNull();
      expect(await find('%')).toBeNull();
    });
  });

  describe('recovering an account', () => {
    let target: string;

    const recover = (userId: string, reason = 'Telefono perso', by = operator) =>
      outcome(
        by,
        (tx) =>
          tx.$queryRaw<{ o: string }[]>`
          SELECT app_platform_issue_recovery_code(${userId}::uuid, ${reason},
            ${`recovery-${userId}`}, ${expires}::timestamptz) AS o`,
      );

    beforeAll(async () => {
      // A person working in A and C, with an account, an open session and recovery codes.
      target = await person('target');
      await admin.membership.createMany({
        data: [
          { tenantId: world.tenants.a, userId: target, role: 'READ_ONLY', allCompanies: true },
          { tenantId: world.tenants.c, userId: target, role: 'ADMIN', allCompanies: true },
        ],
      });
      await admin.credential.create({ data: { userId: target, passwordHash: 'x' } });
      await admin.session.create({
        data: {
          userId: target,
          refreshHash: `refresh-${suffix}`,
          absoluteExpiresAt: new Date(Date.now() + 86_400_000),
        },
      });
    });

    it('is refused without a reason, for oneself, an operator, a pending account, or nobody', async () => {
      const pending = await person('pending');
      await admin.membership.create({
        data: { tenantId: world.tenants.a, userId: pending, role: 'READ_ONLY', allCompanies: true },
      });
      const loner = await person('loner');
      await admin.credential.create({ data: { userId: loner, passwordHash: 'x' } });
      const colleague = await person('colleague');
      await grant(colleague);
      await admin.credential.create({ data: { userId: colleague, passwordHash: 'x' } });

      expect(await recover(target, '  ')).toBe('REASON_REQUIRED');
      expect(await recover(operator)).toBe('SELF');
      expect(await recover(colleague)).toBe('IS_OPERATOR');
      expect(await recover(pending)).toBe('NOT_ACTIVATED');
      expect(await recover(loner)).toBe('NO_MEMBERSHIP');
      expect(await recover('0198a000-0000-7000-8000-00000000dead')).toBe('NOT_FOUND');
      expect(
        await admin.activationToken.count({
          where: { userId: { in: [target, pending, loner, colleague] } },
        }),
      ).toBe(0);
    });

    it('closes the sessions now and tells the person and every tenant of theirs', async () => {
      expect(await recover(target)).toBe('OK');

      expect(await admin.session.count({ where: { userId: target, revokedAt: null } })).toBe(0);
      // Password and authenticator stay until the code is used.
      expect(await admin.credential.count({ where: { userId: target } })).toBe(1);
      expect(await admin.activationToken.findMany({ where: { userId: target } })).toEqual([
        expect.objectContaining({ tokenHash: `recovery-${target}`, usedAt: null }),
      ]);
      const own = await admin.authEvent.findFirstOrThrow({
        where: { userId: target, type: 'ACCOUNT_RECOVERY_ISSUED' },
      });
      expect(own.details).toMatchObject({ by: operator, reason: 'Telefono perso', sessions: 1 });

      const events = await admin.auditEvent.findMany({
        where: { type: 'MEMBER_RECOVERY_ISSUED', actorUserId: operator },
      });
      expect(events.map((e) => e.tenantId).sort()).toEqual(
        [world.tenants.a, world.tenants.c].sort(),
      );
      for (const event of events) {
        expect(event.source).toBe('PLATFORM');
        expect(event.details).toMatchObject({ email: await emailOf(target) });
        // Neither the reason nor the code reaches the tenants.
        expect(JSON.stringify(event.details)).not.toMatch(/Telefono|recovery-/);
      }
    });

    it('a second recovery replaces the code not used yet', async () => {
      expect(await recover(target, 'Di nuovo')).toBe('OK');
      expect(await admin.activationToken.count({ where: { userId: target, usedAt: null } })).toBe(
        1,
      );
    });
  });

  describe('operators', () => {
    const grantRow = (email: string, name: string | null, confirm = false) =>
      as(operator, async (tx) => {
        const [row] = await tx.$queryRaw<
          {
            outcome: string;
            user_id: string | null;
            identity_created: boolean;
            tenants: { name: string; slug: string }[] | null;
          }[]
        >`SELECT * FROM app_platform_grant_operator(${email}, ${name}, ${confirm},
            ${`grant-${email}`}, ${expires}::timestamptz)`;
        if (row?.user_id && row.identity_created) createdUsers.push(row.user_id);
        return row!;
      });
    const revoke = (target: string, by: string, close = false, reason = 'Ha cambiato lavoro') =>
      outcome(
        by,
        (tx) =>
          tx.$queryRaw<{ o: string }[]>`
          SELECT app_platform_revoke_operator(${target}::uuid, ${reason}, ${close}) AS o`,
      );
    const issueCode = (target: string) =>
      outcome(
        operator,
        (tx) =>
          tx.$queryRaw<{ o: string }[]>`
          SELECT app_platform_issue_operator_code(${target}::uuid, ${`op-code-${target}`},
            ${expires}::timestamptz) AS o`,
      );

    it('grants a new identity with a code; a new email needs a name', async () => {
      const email = `nuovo-op-${suffix}@example.com`;
      expect((await grantRow(email, '  ')).outcome).toBe('NAME_REQUIRED');

      const row = await grantRow(email, 'Nuovo Operatore');

      expect(row).toMatchObject({ outcome: 'GRANTED', identity_created: true });
      expect(
        await admin.platformOperator.findFirstOrThrow({ where: { userId: row.user_id! } }),
      ).toMatchObject({ grantedBy: operator, revokedAt: null });
      expect(await admin.activationToken.count({ where: { userId: row.user_id! } })).toBe(1);
      const types = await admin.authEvent.findMany({ where: { userId: row.user_id! } });
      expect(types.map((e) => e.type).sort()).toEqual([
        'ACTIVATION_CODE_ISSUED',
        'OPERATOR_GRANTED',
      ]);
      expect((await grantRow(email, null)).outcome).toBe('ALREADY_OPERATOR');
    });

    it('asks to confirm a person who works for tenants, then grants without a code', async () => {
      const email = await emailOf(world.users.w);

      const first = await grantRow(email, null);
      expect(first.outcome).toBe('NEEDS_CONFIRMATION');
      expect(first.tenants).toEqual([expect.objectContaining({ slug: expect.any(String) })]);
      expect(await admin.platformOperator.count({ where: { userId: world.users.w } })).toBe(0);

      expect(await grantRow(email, null, true)).toMatchObject({
        outcome: 'GRANTED',
        identity_created: false,
      });
      expect(await admin.activationToken.count({ where: { userId: world.users.w } })).toBe(0);
    });

    it('lists open and revoked grants, with who gave them', async () => {
      const rows = await as(
        operator,
        (tx) =>
          tx.$queryRaw<{ user_id: string; granted_by_name: string | null; revoked_at: Date }[]>`
          SELECT * FROM app_platform_list_operators()`,
      );
      expect(rows.find((r) => r.user_id === world.users.w)).toMatchObject({
        granted_by_name: 'operator',
        revoked_at: null,
      });
      expect(rows.find((r) => r.user_id === revoked)?.revoked_at).toBeInstanceOf(Date);
    });

    it('issues a code only to an operator not activated who works nowhere', async () => {
      const pending = (await grantRow(`attesa-op-${suffix}@example.com`, 'In Attesa')).user_id!;

      expect(await issueCode(pending)).toBe('OK');
      expect(await issueCode(world.users.w)).toBe('OTHER_TENANTS');
      expect(await issueCode(world.users.v)).toBe('NOT_OPERATOR');
      await admin.credential.create({ data: { userId: pending, passwordHash: 'x' } });
      expect(await issueCode(pending)).toBe('ALREADY_ACTIVATED');
    });

    it('revokes another operator with a reason, never oneself', async () => {
      const target = await person('to-revoke');
      await grant(target);
      await admin.session.create({
        data: {
          userId: target,
          refreshHash: `refresh-op-${suffix}`,
          absoluteExpiresAt: new Date(Date.now() + 86_400_000),
        },
      });

      expect(await revoke(target, operator, false, ' ')).toBe('REASON_REQUIRED');
      expect(await revoke(operator, operator)).toBe('SELF');
      expect(await revoke(world.users.v, operator)).toBe('NOT_OPERATOR');
      expect(await revoke(target, operator)).toBe('OK');
      // Without the box, the sessions stay: the person may work in a tenant.
      expect(await admin.session.count({ where: { userId: target, revokedAt: null } })).toBe(1);
      expect(
        await admin.platformOperator.findFirstOrThrow({ where: { userId: target } }),
      ).toMatchObject({ revokedBy: operator, revokeReason: 'Ha cambiato lavoro' });
      expect(await revoke(target, operator)).toBe('NOT_OPERATOR');
    });

    it('closes the sessions too when asked', async () => {
      const target = await person('compromised');
      await grant(target);
      await admin.session.create({
        data: {
          userId: target,
          refreshHash: `refresh-comp-${suffix}`,
          absoluteExpiresAt: new Date(Date.now() + 86_400_000),
        },
      });

      expect(await revoke(target, operator, true, 'Account compromesso')).toBe('OK');
      expect(await admin.session.count({ where: { userId: target, revokedAt: null } })).toBe(0);
      const event = await admin.authEvent.findFirstOrThrow({
        where: { userId: target, type: 'OPERATOR_REVOKED' },
      });
      expect(event.details).toMatchObject({
        by: operator,
        reason: 'Account compromesso',
        sessionsClosed: true,
        sessions: 1,
      });
    });

    it('two operators revoking each other at the same moment: only the first succeeds', async () => {
      const first = await person('race-1');
      const second = await person('race-2');
      await grant(first);
      await grant(second);

      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let firstRevoked!: () => void;
      const revokedInFirst = new Promise<void>((resolve) => (firstRevoked = resolve));

      // The first revocation keeps its transaction open after revoking, holding the locks.
      const one = as(first, async (tx) => {
        const [row] = await tx.$queryRaw<{ o: string }[]>`
          SELECT app_platform_revoke_operator(${second}::uuid, 'corsa', false) AS o`;
        firstRevoked();
        await held;
        return row!.o;
      });
      await revokedInFirst;
      const two = revoke(first, second).then(
        (o) => o,
        (error: Error) => error.message,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();

      expect(await one).toBe('OK');
      expect(await two).toMatch(/NOT_PLATFORM_OPERATOR/);
      expect(
        await admin.platformOperator.count({ where: { userId: first, revokedAt: null } }),
      ).toBe(1);
    });
  });
});
