import { Test } from '@nestjs/testing';
import { AppConfigModule } from '../src/config/config.module.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { MODULE_KEYS } from '../src/modules/tenancy/module-catalog.js';
import { PrismaModule, type DbClient, UserDatabase } from '../src/prisma/index.js';
import {
  adminClient,
  createWorld,
  deleteTenantsAndUsers,
  deleteWorld,
  uniqueSuffix,
  type World,
} from './support/database.js';

// The platform operator's functions (docs/adr/0038), called as the API role (mercurio_app) the way
// the API calls them: Row-Level Security and grants really apply. What matters most is the first
// block: nobody but an active operator gets anything out of them, even calling them directly.
describe('platform operator functions (e2e)', () => {
  let admin: PrismaClient;
  let users: UserDatabase;
  let world: World;
  let close: () => Promise<void>;
  let operator: string;
  let revoked: string;
  const createdTenants: string[] = [];
  const createdUsers: string[] = [];
  const suffix = uniqueSuffix();
  const expires = new Date(Date.now() + 7 * 86_400_000);

  beforeAll(async () => {
    admin = adminClient();
    world = await createWorld(admin);
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule],
    }).compile();
    await moduleRef.init();
    users = moduleRef.get(UserDatabase);
    close = () => moduleRef.close();

    const person = (key: string) =>
      admin.user.create({ data: { email: `${key}-${suffix}@example.com`, name: key } });
    operator = (await person('operator')).id;
    revoked = (await person('revoked')).id;
    createdUsers.push(operator, revoked);
    await admin.platformOperator.create({ data: { userId: operator } });
    await admin.platformOperator.create({
      data: { userId: revoked, revokedAt: new Date(), revokeReason: 'left' },
    });
  });

  afterAll(async () => {
    await close?.();
    await deleteTenantsAndUsers(admin, createdTenants, createdUsers);
    if (world) await deleteWorld(admin, world);
    await admin.$disconnect();
  });

  const as = <T>(userId: string, work: (tx: DbClient) => Promise<T>) => users.runAs(userId, work);

  async function createTenant(
    userId: string,
    input: { slug: string; email?: string; modules?: string[] },
  ) {
    const [row] = await as(
      userId,
      (tx) =>
        tx.$queryRaw<
          {
            outcome: string;
            tenant_id: string | null;
            membership_id: string | null;
            user_id: string | null;
            identity_created: boolean;
          }[]
        >`SELECT * FROM app_platform_create_tenant(
          ${`Cliente ${input.slug}`}, ${input.slug}, 'Cliente Srl', '01234567890', NULL, 'IT',
          ${input.modules ?? ['registry', 'warehouse']}::text[],
          ${input.email ?? `admin-${input.slug}@example.com`}, 'Prima Admin',
          ${`hash-${input.slug}`}, ${expires}::timestamptz)`,
    );
    if (row?.tenant_id) createdTenants.push(row.tenant_id);
    if (row?.user_id && row.identity_created) createdUsers.push(row.user_id);
    return row!;
  }

  const version = async (tenantId: string) =>
    (await admin.tenant.findUniqueOrThrow({ where: { id: tenantId } })).version;

  describe('only an active operator', () => {
    const calls: Record<string, (tx: DbClient) => Promise<unknown>> = {
      list: (tx) => tx.$queryRaw`SELECT * FROM app_platform_list_tenants(NULL, NULL, 10, 0)`,
      get: (tx) => tx.$queryRaw`SELECT app_platform_get_tenant(${world.tenants.a}::uuid)`,
      events: (tx) =>
        tx.$queryRaw`SELECT * FROM app_platform_tenant_events(${world.tenants.a}::uuid, 10, 0)`,
      create: (tx) =>
        tx.$queryRaw`SELECT * FROM app_platform_create_tenant('X', ${`x-${suffix}`}, 'X Srl',
          '01234567890', NULL, 'IT', ARRAY['registry'], 'x@example.com', 'X', 'h', now())`,
      modules: (tx) =>
        tx.$queryRaw`SELECT * FROM app_platform_set_modules(${world.tenants.a}::uuid, 1,
          ARRAY['registry'])`,
      rename: (tx) =>
        tx.$queryRaw`SELECT * FROM app_platform_rename_tenant(${world.tenants.a}::uuid, 1, 'X')`,
      status: (tx) =>
        tx.$queryRaw`SELECT * FROM app_platform_set_tenant_status(${world.tenants.a}::uuid, 1,
          'SUSPENDED', 'x')`,
      admin: (tx) =>
        tx.$queryRaw`SELECT * FROM app_platform_add_admin(${world.tenants.a}::uuid,
          'x@example.com', 'X', true, 'h', now())`,
      code: (tx) =>
        tx.$queryRaw`SELECT app_platform_issue_admin_code(${world.tenants.a}::uuid,
          ${world.users.u}::uuid, 'h', now())`,
    };

    it.each(Object.keys(calls))('%s: refused to a tenant administrator', async (name) => {
      await expect(as(world.users.u, calls[name]!)).rejects.toThrow(/NOT_PLATFORM_OPERATOR/);
    });

    it.each(Object.keys(calls))('%s: refused to a revoked operator', async (name) => {
      await expect(as(revoked, calls[name]!)).rejects.toThrow(/NOT_PLATFORM_OPERATOR/);
    });

    it('nothing changed in the tenant the refused calls named', async () => {
      const tenant = await admin.tenant.findUniqueOrThrow({ where: { id: world.tenants.a } });
      expect(tenant).toMatchObject({ name: 'Test a', status: 'ACTIVE', version: 1 });
      expect(await admin.tenantModule.count({ where: { tenantId: world.tenants.a } })).toBe(1);
      expect(
        await admin.auditEvent.count({ where: { tenantId: world.tenants.a, source: 'PLATFORM' } }),
      ).toBe(0);
    });

    it('a person knows whether they are an operator, and sees no other grant', async () => {
      const check = (userId: string) =>
        as(userId, async (tx) => {
          const [row] = await tx.$queryRaw<{ active: boolean }[]>`
            SELECT app_platform_operator_active() AS active`;
          return { active: row!.active, grants: await tx.platformOperator.count() };
        });

      expect(await check(operator)).toEqual({ active: true, grants: 1 });
      expect(await check(revoked)).toEqual({ active: false, grants: 1 });
      expect(await check(world.users.u)).toEqual({ active: false, grants: 0 });
    });

    it('the API role cannot grant itself the role, nor call the internal helpers', async () => {
      await expect(
        as(world.users.u, (tx) => tx.platformOperator.create({ data: { userId: world.users.u } })),
      ).rejects.toThrow();
      for (const helper of [
        'mercurio_uuid_v7()',
        'mercurio_module_keys()',
        'mercurio_platform_assert_operator()',
      ]) {
        await expect(as(operator, (tx) => tx.$queryRawUnsafe(`SELECT ${helper}`))).rejects.toThrow(
          /permission denied/,
        );
      }
    });
  });

  describe('creating a tenant', () => {
    it('makes the tenant, its company, modules and first administrator with a code', async () => {
      const slug = `nuovo-${suffix}`;
      const row = await createTenant(operator, { slug });

      expect(row).toMatchObject({ outcome: 'OK', identity_created: true });
      const tenant = await admin.tenant.findUniqueOrThrow({
        where: { id: row.tenant_id! },
        include: { companies: true, modules: true, memberships: true },
      });
      expect(tenant.slug).toBe(slug);
      expect(tenant.companies.map((c) => c.vatNumber)).toEqual(['01234567890']);
      expect(tenant.modules.map((m) => m.moduleKey).sort()).toEqual(['registry', 'warehouse']);
      expect(tenant.memberships).toEqual([
        expect.objectContaining({ userId: row.user_id, role: 'ADMIN', allCompanies: true }),
      ]);
      expect(await admin.activationToken.findMany({ where: { userId: row.user_id! } })).toEqual([
        expect.objectContaining({ tokenHash: `hash-${slug}` }),
      ]);

      // One transaction, so the same time for all three: compared without order.
      const events = await admin.auditEvent.findMany({ where: { tenantId: row.tenant_id! } });
      expect(events.map((e) => [e.type, e.source, e.actorUserId]).sort()).toEqual([
        ['ACTIVATION_CODE_ISSUED', 'PLATFORM', operator],
        ['MEMBER_ADDED', 'PLATFORM', operator],
        ['TENANT_CREATED', 'PLATFORM', operator],
      ]);
      expect(JSON.stringify(events)).not.toContain(`hash-${slug}`);
    });

    it('keeps an identity that already exists, without a code', async () => {
      const email = (await admin.user.findUniqueOrThrow({ where: { id: world.users.w } })).email;
      const row = await createTenant(operator, { slug: `consulente-${suffix}`, email });

      expect(row).toMatchObject({ outcome: 'OK', identity_created: false, user_id: world.users.w });
      expect(await admin.activationToken.count({ where: { userId: world.users.w } })).toBe(0);
    });

    it('refuses a slug in use, and modules outside the catalog or without registry', async () => {
      const slug = `doppio-${suffix}`;
      await createTenant(operator, { slug });

      expect((await createTenant(operator, { slug })).outcome).toBe('SLUG_EXISTS');
      await expect(
        createTenant(operator, { slug: `a-${suffix}`, modules: ['registry', 'payroll'] }),
      ).rejects.toThrow(/INVALID_MODULES/);
      await expect(
        createTenant(operator, { slug: `b-${suffix}`, modules: ['warehouse'] }),
      ).rejects.toThrow(/INVALID_MODULES/);
    });
  });

  describe('governing a tenant', () => {
    let tenantId: string;

    beforeAll(async () => {
      tenantId = (await createTenant(operator, { slug: `governo-${suffix}` })).tenant_id!;
    });

    it('changes modules at the version seen, and records what changed', async () => {
      const set = (v: number, modules: string[]) =>
        as(
          operator,
          (tx) =>
            tx.$queryRaw<{ outcome: string; version: number }[]>`
            SELECT * FROM app_platform_set_modules(${tenantId}::uuid, ${v}, ${modules}::text[])`,
        );
      const v = await version(tenantId);

      expect(await set(v, ['registry', 'warehouse', 'orders'])).toEqual([
        { outcome: 'OK', version: v + 1 },
      ]);
      expect(await set(v, ['registry'])).toEqual([{ outcome: 'EDIT_CONFLICT', version: v + 1 }]);
      // The same list again: nothing to record, the version stays.
      expect(await set(v + 1, ['registry', 'warehouse', 'orders'])).toEqual([
        { outcome: 'OK', version: v + 1 },
      ]);
      const event = await admin.auditEvent.findFirstOrThrow({
        where: { tenantId, type: 'MODULES_CHANGED' },
      });
      expect(event.details).toEqual({
        modules: ['orders', 'registry', 'warehouse'],
        enabled: ['orders'],
        disabled: [],
      });
    });

    it('renames without touching the slug', async () => {
      const v = await version(tenantId);
      const [row] = await as(
        operator,
        (tx) =>
          tx.$queryRaw<{ outcome: string }[]>`
          SELECT * FROM app_platform_rename_tenant(${tenantId}::uuid, ${v}, 'Nome nuovo')`,
      );

      expect(row!.outcome).toBe('OK');
      const tenant = await admin.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      expect(tenant).toMatchObject({ name: 'Nome nuovo', slug: `governo-${suffix}` });
    });

    it('suspends and reactivates with a reason', async () => {
      const status = async (s: 'ACTIVE' | 'SUSPENDED', reason: string) => {
        const v = await version(tenantId);
        const [row] = await as(
          operator,
          (tx) =>
            tx.$queryRaw<{ outcome: string }[]>`
            SELECT * FROM app_platform_set_tenant_status(${tenantId}::uuid, ${v},
              ${s}::tenant_status, ${reason})`,
        );
        return row!.outcome;
      };

      expect(await status('SUSPENDED', '   ')).toBe('REASON_REQUIRED');
      expect(await status('ACTIVE', 'già attivo')).toBe('STATUS_UNCHANGED');
      expect(await status('SUSPENDED', 'Contratto scaduto')).toBe('OK');
      expect(await admin.tenant.findUniqueOrThrow({ where: { id: tenantId } })).toMatchObject({
        status: 'SUSPENDED',
        statusReason: 'Contratto scaduto',
      });
      expect(await status('ACTIVE', 'Rinnovato')).toBe('OK');
      const types = await admin.auditEvent.findMany({
        where: { tenantId, type: { in: ['TENANT_SUSPENDED', 'TENANT_REACTIVATED'] } },
        orderBy: [{ at: 'asc' }, { id: 'asc' }],
      });
      expect(types.map((e) => [e.type, e.details])).toEqual([
        ['TENANT_SUSPENDED', { reason: 'Contratto scaduto' }],
        ['TENANT_REACTIVATED', { reason: 'Rinnovato' }],
      ]);
    });
  });

  describe('administrators', () => {
    const addAdmin = (tenantId: string, email: string, promote = false) =>
      as(operator, async (tx) => {
        const [row] = await tx.$queryRaw<
          {
            outcome: string;
            user_id: string | null;
            identity_created: boolean;
            member_role: string | null;
          }[]
        >`SELECT * FROM app_platform_add_admin(${tenantId}::uuid, ${email}, 'Nuova Admin',
            ${promote}, ${`hash-${email}`}, ${expires}::timestamptz)`;
        if (row?.user_id && row.identity_created) createdUsers.push(row.user_id);
        return row!;
      });
    const emailOf = async (id: string) =>
      (await admin.user.findUniqueOrThrow({ where: { id } })).email;

    it('adds a new identity as administrator, with a code', async () => {
      const row = await addAdmin(world.tenants.c, `nuova-admin-${suffix}@example.com`);

      expect(row).toMatchObject({ outcome: 'ADDED', identity_created: true });
      expect(await admin.activationToken.count({ where: { userId: row.user_id! } })).toBe(1);
    });

    it('promotes a member with another role only once confirmed', async () => {
      const email = await emailOf(world.users.u);

      expect(await addAdmin(world.tenants.b, email)).toMatchObject({
        outcome: 'NEEDS_PROMOTION',
        member_role: 'READ_ONLY',
      });
      expect(
        await admin.membership.findUniqueOrThrow({ where: { id: world.memberships.ub } }),
      ).toMatchObject({ role: 'READ_ONLY' });

      expect(await addAdmin(world.tenants.b, email, true)).toMatchObject({ outcome: 'PROMOTED' });
      expect(
        await admin.membership.findUniqueOrThrow({
          where: { id: world.memberships.ub },
          include: { companies: true },
        }),
      ).toMatchObject({ role: 'ADMIN', allCompanies: true, companies: [] });
      expect(await addAdmin(world.tenants.b, email)).toMatchObject({ outcome: 'ALREADY_ADMIN' });
    });

    it('issues a new code only to an administrator never activated who works nowhere else', async () => {
      const issue = (tenantId: string, userId: string) =>
        as(operator, async (tx) => {
          const [row] = await tx.$queryRaw<{ outcome: string }[]>`
            SELECT app_platform_issue_admin_code(${tenantId}::uuid, ${userId}::uuid,
              ${`code-${userId}`}, ${expires}::timestamptz) AS outcome`;
          return row!.outcome;
        });
      const pending = await addAdmin(world.tenants.c, `in-attesa-${suffix}@example.com`);
      await admin.credential.create({ data: { userId: world.users.v, passwordHash: 'x' } });

      expect(await issue(world.tenants.c, pending.user_id!)).toBe('OK');
      expect(await issue(world.tenants.b, world.users.v)).toBe('ALREADY_ACTIVATED');
      // U is administrator of A and, since the promotion above, of B too.
      expect(await issue(world.tenants.a, world.users.u)).toBe('OTHER_TENANTS');
      expect(await issue(world.tenants.c, world.users.u)).toBe('NOT_ADMIN');
      expect(
        await admin.activationToken.findMany({
          where: { userId: pending.user_id!, usedAt: null },
        }),
      ).toEqual([expect.objectContaining({ tokenHash: `code-${pending.user_id}` })]);
    });
  });

  describe('what the operator reads', () => {
    it('lists tenants with configuration data only', async () => {
      const rows = await as(
        operator,
        (tx) =>
          tx.$queryRaw<Record<string, unknown>[]>`
          SELECT * FROM app_platform_list_tenants(${`test-a-`}, NULL, 50, 0)`,
      );
      const a = rows.find((r) => r.id === world.tenants.a);

      expect(Object.keys(a!).sort()).toEqual([
        'companies',
        'created_at',
        'id',
        'modules',
        'name',
        'people',
        'slug',
        'status',
        'total',
      ]);
      expect(a).toMatchObject({ modules: ['registry'], companies: 1, people: 1 });
    });

    it('shows a tenant: companies by name and VAT, administrators, a count of the others', async () => {
      const [row] = await as(
        operator,
        (tx) =>
          tx.$queryRaw<{ tenant: Record<string, unknown> }[]>`
          SELECT app_platform_get_tenant(${world.tenants.b}::uuid) AS tenant`,
      );
      const tenant = row!.tenant;

      expect(Object.keys((tenant.companies as object[])[0]!).sort()).toEqual([
        'country',
        'id',
        'legalName',
        'vatNumber',
      ]);
      expect((tenant.admins as { userId: string }[]).map((a) => a.userId).sort()).toEqual(
        [world.users.u, world.users.v].sort(),
      );
      expect(tenant.otherPeople).toBe(0);
      const [missing] = await as(
        operator,
        (tx) =>
          tx.$queryRaw<{ tenant: unknown }[]>`
          SELECT app_platform_get_tenant(${'0198a000-0000-7000-8000-00000000dead'}::uuid) AS tenant`,
      );
      expect(missing!.tenant).toBeNull();
    });

    it("lists only the operators' actions in a tenant's history", async () => {
      await admin.auditEvent.create({
        data: { tenantId: world.tenants.b, source: 'API', type: 'PARTY_CREATED' },
      });
      const events = await as(
        operator,
        (tx) =>
          tx.$queryRaw<{ type: string; actor_name: string }[]>`
          SELECT * FROM app_platform_tenant_events(${world.tenants.b}::uuid, 50, 0)`,
      );

      expect(events.map((e) => e.type)).toEqual(['MEMBER_UPDATED']);
      expect(events[0]!.actor_name).toBe('operator');
    });
  });

  describe('helpers', () => {
    it('the SQL module keys are those of the catalog', async () => {
      const [row] = await admin.$queryRaw<{ keys: string[] }[]>`
        SELECT mercurio_module_keys() AS keys`;
      expect([...row!.keys].sort()).toEqual([...MODULE_KEYS].sort());
    });

    it('ids made in SQL are UUID version 7, in time order', async () => {
      const rows = await admin.$queryRaw<{ id: string }[]>`
        SELECT mercurio_uuid_v7()::text AS id FROM generate_series(1, 3)`;
      for (const { id } of rows) {
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      }
      const ms = Number.parseInt(rows[0]!.id.replace(/-/g, '').slice(0, 12), 16);
      expect(Math.abs(ms - Date.now())).toBeLessThan(60_000);
    });
  });
});
