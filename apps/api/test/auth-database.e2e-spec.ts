import { Test } from '@nestjs/testing';
import { AppConfigModule } from '../src/config/config.module.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaModule, PrismaService, TenantDatabase, UserDatabase } from '../src/prisma/index.js';
import { adminClient, createWorld, deleteWorld, type World } from './support/database.js';

// What the database itself guarantees about the sign-in tables, tested as the API role
// (mercurio_app) so that Row-Level Security and grants really apply. See docs/adr/0012, 0015.
describe('sign-in tables (e2e)', () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let users: UserDatabase;
  let tenants: TenantDatabase;
  let world: World;
  let close: () => Promise<void>;
  const hash = (label: string) => `${label}-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    admin = adminClient();
    world = await createWorld(admin);
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    users = moduleRef.get(UserDatabase);
    tenants = moduleRef.get(TenantDatabase);
    close = () => moduleRef.close();

    for (const userId of [world.users.u, world.users.v]) {
      await admin.credential.create({ data: { userId, passwordHash: 'hash' } });
      await admin.recoveryCode.create({ data: { userId, codeHash: hash('rc') } });
      await admin.session.create({
        data: {
          userId,
          refreshHash: hash('refresh'),
          absoluteExpiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      await admin.authEvent.create({ data: { userId, type: 'LOGIN_SUCCEEDED' } });
    }
    await admin.auditEvent.createMany({
      data: [world.tenants.a, world.tenants.b].map((tenantId) => ({
        tenantId,
        source: 'CLI' as const,
        type: 'TENANT_CREATED',
      })),
    });
  });

  afterAll(async () => {
    await close?.();
    if (world) await deleteWorld(admin, world);
    await admin.$disconnect();
  });

  describe('SECURITY DEFINER functions', () => {
    it('are exactly the reviewed ones, with a fixed search_path and closed to everyone else', async () => {
      const functions = await admin.$queryRaw<
        { name: string; config: string[] | null; acl: string | null }[]
      >`
        SELECT p.proname AS name, p.proconfig AS config, p.proacl::text AS acl
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef
        ORDER BY p.proname`;

      // A new SECURITY DEFINER function must be added here on purpose, after review (B28).
      expect(functions.map((f) => f.name)).toEqual([
        'app_activate_account',
        'app_find_login_subject',
        'app_find_or_create_person',
        'app_issue_activation_code',
        'app_platform_add_admin',
        'app_platform_create_tenant',
        'app_platform_get_tenant',
        'app_platform_issue_admin_code',
        'app_platform_list_tenants',
        'app_platform_rename_tenant',
        'app_platform_set_modules',
        'app_platform_set_tenant_status',
        'app_platform_tenant_events',
        'app_rotate_session',
        'app_tenant_member_states',
      ]);
      for (const fn of functions) {
        expect(fn.config).toContain('search_path=pg_catalog, public');
        // Not executable by PUBLIC ("=X/owner" in the ACL) but by the API role.
        expect(fn.acl).not.toMatch(/(^|,|\{)=X/);
        expect(fn.acl).toContain('mercurio_app=X');
      }
    });

    it('return only what the caller needs', async () => {
      const [found] = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT * FROM app_find_login_subject('nobody@example.com')`;
      const email = (await admin.user.findUniqueOrThrow({ where: { id: world.users.u } })).email;
      const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
        SELECT user_id, status::text AS status FROM app_find_login_subject(${email.toUpperCase()})`;

      expect(found).toBeUndefined();
      expect(rows).toEqual([{ user_id: world.users.u, status: 'ACTIVE' }]);
    });
  });

  describe('a person sees only their own rows', () => {
    it('credentials, recovery codes, sessions and security events', async () => {
      const own = await users.runAs(world.users.u, async (tx) => ({
        credentials: await tx.credential.findMany(),
        recoveryCodes: await tx.recoveryCode.findMany(),
        sessions: await tx.session.findMany(),
        events: await tx.authEvent.findMany(),
      }));

      for (const rows of Object.values(own)) {
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => (r as { userId: string }).userId === world.users.u)).toBe(true);
      }
    });

    it('nothing at all without a person in the context', async () => {
      expect(await prisma.credential.findMany()).toEqual([]);
      expect(await prisma.recoveryCode.findMany()).toEqual([]);
      expect(await prisma.session.findMany()).toEqual([]);
      expect(await prisma.authEvent.findMany()).toEqual([]);
    });

    it("cannot change another person's rows", async () => {
      const changed = await users.runAs(world.users.u, async (tx) => ({
        credentials: await tx.credential.updateMany({
          where: { userId: world.users.v },
          data: { failedAttempts: 99 },
        }),
        sessions: await tx.session.updateMany({
          where: { userId: world.users.v },
          data: { revokedAt: new Date() },
        }),
      }));

      expect(changed.credentials.count).toBe(0);
      expect(changed.sessions.count).toBe(0);
    });

    it('cannot write a row for somebody else, nor read back an anonymous event', async () => {
      await expect(
        users.runAs(world.users.u, (tx) =>
          tx.authEvent.createMany({ data: [{ userId: world.users.v, type: 'LOGIN_FAILED' }] }),
        ),
      ).rejects.toThrow();
      await expect(
        users.runAs(world.users.u, (tx) =>
          tx.session.create({
            data: {
              userId: world.users.v,
              refreshHash: hash('x'),
              absoluteExpiresAt: new Date(),
            },
          }),
        ),
      ).rejects.toThrow();

      // An event about nobody can be written by anyone, but nobody can read it.
      await prisma.authEvent.createMany({ data: [{ userId: null, type: 'LOGIN_FAILED' }] });
      const readable = await users.runAs(world.users.u, (tx) => tx.authEvent.findMany());
      expect(readable.every((e) => e.userId === world.users.u)).toBe(true);
      await admin.$transaction([
        admin.$executeRaw`SET LOCAL session_replication_role = replica`,
        admin.authEvent.deleteMany({ where: { userId: null } }),
      ]);
    });
  });

  describe('the API role cannot reach what only a function may change', () => {
    it('refresh hashes, the credentials of a new person and activation codes', async () => {
      await expect(
        users.runAs(
          world.users.u,
          (tx) =>
            tx.$executeRaw`UPDATE sessions SET refresh_hash = 'stolen' WHERE user_id = ${world.users.u}::uuid`,
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        users.runAs(world.users.u, (tx) =>
          tx.credential.create({ data: { userId: world.users.w, passwordHash: 'x' } }),
        ),
      ).rejects.toThrow();
      await expect(prisma.activationToken.findMany()).rejects.toThrow(/permission denied/);
    });
  });

  describe('the audit log is append-only', () => {
    it('refuses updates and deletes, for the API role and for the owner', async () => {
      const event = await admin.auditEvent.findFirstOrThrow({
        where: { tenantId: world.tenants.a },
      });
      const authEvent = await admin.authEvent.findFirstOrThrow({
        where: { userId: world.users.u },
      });

      await expect(
        admin.auditEvent.update({ where: { id: event.id }, data: { type: 'TENANT_RENAMED' } }),
      ).rejects.toThrow(/append-only/);
      await expect(admin.auditEvent.delete({ where: { id: event.id } })).rejects.toThrow(
        /append-only/,
      );
      await expect(admin.authEvent.delete({ where: { id: authEvent.id } })).rejects.toThrow(
        /append-only/,
      );
      await expect(
        tenants.runAs({ tenantId: world.tenants.a, userId: world.users.u }, (tx) =>
          tx.auditEvent.updateMany({ data: { type: 'EDITED' } }),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        tenants.runAs({ tenantId: world.tenants.a, userId: world.users.u }, (tx) =>
          tx.auditEvent.deleteMany(),
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it("keeps one tenant's events from another, in reading and in writing", async () => {
      const seenByA = await tenants.runAs({ tenantId: world.tenants.a }, (tx) =>
        tx.auditEvent.findMany(),
      );
      expect(seenByA.length).toBeGreaterThan(0);
      expect(seenByA.every((e) => e.tenantId === world.tenants.a)).toBe(true);

      await expect(
        tenants.runAs({ tenantId: world.tenants.a }, (tx) =>
          tx.auditEvent.createMany({
            data: [{ tenantId: world.tenants.b, source: 'API', type: 'MEMBER_ADDED' }],
          }),
        ),
      ).rejects.toThrow();
      expect(await prisma.auditEvent.findMany()).toEqual([]);
    });
  });
});
