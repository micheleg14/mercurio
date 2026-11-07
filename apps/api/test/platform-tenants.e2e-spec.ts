import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { italianCheckDigit } from '../src/shared/italian-identifiers.js';
import { activate, activateWithCode, bearer, createTestApp } from './support/auth.js';
import {
  adminClient,
  createWorld,
  deleteTenantsAndUsers,
  uniqueSuffix,
  type World,
} from './support/database.js';

// A tenant born from the browser and governed by the platform operator (phase 8a, docs/adr/0038),
// through the API and seen from the tenant's side too.
describe('tenants from the platform area (e2e)', () => {
  let app: NestExpressApplication;
  let admin: PrismaClient;
  let world: World;
  const suffix = uniqueSuffix();
  const extraUsers: string[] = [];
  const extraTenants: string[] = [];
  let operator: string;
  const http = () => request(app.getHttpServer());
  const as = (who: string) => ({
    get: (url: string) => http().get(`/api${url}`).set(bearer(who)),
    post: (url: string, body: object = {}) => http().post(`/api${url}`).set(bearer(who)).send(body),
    put: (url: string, body: object) => http().put(`/api${url}`).set(bearer(who)).send(body),
    patch: (url: string, body: object) => http().patch(`/api${url}`).set(bearer(who)).send(body),
  });
  const email = (name: string) => `${name}-${suffix}@example.com`;
  let counter = 0;
  const newVat = () => {
    const first10 =
      (Number.parseInt(suffix, 16) % 1e6).toString().padStart(6, '3') +
      String(++counter).padStart(4, '0');
    return first10 + italianCheckDigit(first10);
  };

  async function createTenant(body: Partial<Record<string, unknown>> = {}) {
    const slug = `verdi-${suffix}-${++counter}`;
    const res = await as(operator).post('/platform/tenants', {
      name: 'Gruppo Verdi',
      slug,
      modules: ['registry', 'warehouse'],
      company: { legalName: 'Verdi Srl', vatNumber: newVat() },
      admin: { email: email(`laura${counter}`), name: 'Laura Verdi' },
      ...body,
    });
    if (res.body.tenant?.id) extraTenants.push(res.body.tenant.id);
    return res;
  }

  beforeAll(async () => {
    admin = adminClient();
    world = await createWorld(admin);
    app = await createTestApp();
    const person = await admin.user.create({
      data: { email: email('operator'), name: 'Operatore' },
    });
    extraUsers.push(person.id);
    await admin.platformOperator.create({ data: { userId: person.id } });
    operator = (await activate(app, admin, person.id)).accessToken;
  });

  afterAll(async () => {
    await app?.close();
    // Everyone this file created has an email ending with its suffix.
    const created = await admin.user.findMany({
      where: { email: { endsWith: `-${suffix}@example.com` } },
    });
    if (world) {
      await deleteTenantsAndUsers(
        admin,
        [...Object.values(world.tenants), ...extraTenants],
        [...Object.values(world.users), ...extraUsers, ...created.map((u) => u.id)],
      );
    }
    await admin.$disconnect();
  });

  it('creates a tenant whose first administrator activates and finds the chosen modules', async () => {
    const res = await createTenant();

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      existingAccount: false,
      tenant: {
        name: 'Gruppo Verdi',
        status: 'ACTIVE',
        version: 1,
        modules: ['registry', 'warehouse'],
      },
    });
    expect(res.body.tenant.admins).toEqual([
      expect.objectContaining({ name: 'Laura Verdi', activated: false, canIssueCode: true }),
    ]);

    const signedIn = await activateWithCode(app, res.body.activation.code);
    expect(signedIn.tenantId).toBe(res.body.tenant.id);
    const me = await as(signedIn.accessToken).get('/auth/me').expect(200);
    expect(me.body).toMatchObject({
      modules: ['registry', 'warehouse'],
      role: { kind: 'builtin', key: 'ADMIN' },
      platformOperator: false,
    });

    // The tenant's own Activity shows what the operator did, without the operator's name.
    const activity = await as(signedIn.accessToken).get('/audit-events').expect(200);
    const created = activity.body.items.find((e: { type: string }) => e.type === 'TENANT_CREATED');
    expect(created).toMatchObject({ source: 'PLATFORM', actor: null });
  });

  it('keeps an existing identity: no code, the tenant appears among theirs', async () => {
    const existing = await admin.user.findUniqueOrThrow({ where: { id: world.users.w } });
    const res = await createTenant({ admin: { email: existing.email, name: 'ignored' } });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ existingAccount: true, activation: null });
    expect(res.body.tenant.admins[0]).toMatchObject({ userId: world.users.w, name: 'W' });
  });

  it('refuses a slug in use, wrong data and modules without what they need', async () => {
    const first = await createTenant();
    const again = await createTenant({ slug: first.body.tenant.slug });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      code: 'TENANT_SLUG_EXISTS',
      errors: [{ field: 'slug', code: 'TENANT_SLUG_EXISTS' }],
    });

    expect((await createTenant({ slug: 'Not A Slug' })).body.code).toBe('INVALID_SLUG');
    expect((await createTenant({ modules: ['registry', 'orders'] })).status).toBe(409);
    expect((await createTenant({ modules: ['payroll'] })).body.code).toBe('UNKNOWN_MODULE');
    expect((await createTenant({ company: { legalName: 'X', vatNumber: '123' } })).status).toBe(
      400,
    );
  });

  it('lists tenants with search and status filter', async () => {
    const res = await as(operator)
      .get(`/platform/tenants?q=verdi-${suffix}&pageSize=100`)
      .expect(200);

    expect(res.body.total).toBeGreaterThanOrEqual(2);
    expect(res.body.items.every((t: { slug: string }) => t.slug.includes(`verdi-${suffix}`))).toBe(
      true,
    );
    const none = await as(operator).get('/platform/tenants?q=%25').expect(200);
    expect(none.body.items.every((t: { name: string }) => t.name.includes('%'))).toBe(true);
    await as(operator).get('/platform/tenants?status=NOPE').expect(400);
  });

  describe('governing a tenant', () => {
    let id: string;
    let adminToken: string;
    let version: number;
    let company: string;

    beforeAll(async () => {
      const res = await createTenant();
      id = res.body.tenant.id;
      company = res.body.tenant.companies[0].id;
      version = res.body.tenant.version;
      adminToken = (await activateWithCode(app, res.body.activation.code)).accessToken;
    });

    it('turns modules on and off for the people of the tenant at once', async () => {
      await as(adminToken).get('/orders').set('X-Company-Id', company).expect(403);
      const on = await as(operator)
        .put(`/platform/tenants/${id}/modules`, {
          version,
          modules: ['registry', 'warehouse', 'orders'],
        })
        .expect(200);
      version = on.body.version;
      expect(on.body.modules).toEqual(['registry', 'warehouse', 'orders']);
      expect((await as(adminToken).get('/auth/me')).body.modules).toContain('orders');

      // Warehouse is needed by orders, and registry is always on.
      const broken = await as(operator).put(`/platform/tenants/${id}/modules`, {
        version,
        modules: ['registry', 'orders'],
      });
      expect(broken.status).toBe(409);
      const stale = await as(operator).put(`/platform/tenants/${id}/modules`, {
        version: version - 1,
        modules: ['registry', 'warehouse'],
      });
      expect(stale.body.code).toBe('EDIT_CONFLICT');
    });

    it('renames, keeping the slug', async () => {
      const before = (await as(operator).get(`/platform/tenants/${id}`).expect(200)).body;
      const res = await as(operator)
        .patch(`/platform/tenants/${id}`, { version, name: '  Verdi   Holding ' })
        .expect(200);
      version = res.body.version;

      expect(res.body).toMatchObject({ name: 'Verdi Holding', slug: before.slug });
    });

    it('suspends: the people of the tenant stop at their next request, then resume', async () => {
      const noReason = await as(operator).post(`/platform/tenants/${id}/suspend`, {
        version,
        reason: ' ',
      });
      expect(noReason.body.code).toBe('STATUS_REASON_REQUIRED');

      const suspended = await as(operator)
        .post(`/platform/tenants/${id}/suspend`, { version, reason: 'Contratto scaduto' })
        .expect(200);
      version = suspended.body.version;
      expect(suspended.body).toMatchObject({
        status: 'SUSPENDED',
        statusReason: 'Contratto scaduto',
      });
      expect((await as(adminToken).get('/parties')).body.code).toBe('TENANT_SUSPENDED');

      const again = await as(operator).post(`/platform/tenants/${id}/suspend`, {
        version,
        reason: 'x',
      });
      expect(again.body.code).toBe('TENANT_STATUS_UNCHANGED');

      const back = await as(operator)
        .post(`/platform/tenants/${id}/reactivate`, { version, reason: 'Rinnovato' })
        .expect(200);
      version = back.body.version;
      await as(adminToken).get('/parties').expect(200);
    });

    it('adds administrators and promotes a member only once confirmed', async () => {
      const added = await as(operator)
        .post(`/platform/tenants/${id}/admins`, { email: email('second'), name: 'Seconda Admin' })
        .expect(201);
      expect(added.body).toMatchObject({ existingAccount: false, promoted: false });
      expect(added.body.activation.code).toEqual(expect.any(String));

      // A colleague with another role, added by the tenant's administrator.
      await as(adminToken)
        .post('/members', {
          email: email('colleague'),
          name: 'Collega',
          role: { builtin: 'ACCOUNTANT' },
          allCompanies: true,
          companyIds: [],
        })
        .expect(201);
      const ask = await as(operator).post(`/platform/tenants/${id}/admins`, {
        email: email('colleague'),
        name: 'x',
      });
      expect(ask.body).toMatchObject({ code: 'ADMIN_PROMOTION_REQUIRED', detail: 'ACCOUNTANT' });
      const promoted = await as(operator)
        .post(`/platform/tenants/${id}/admins`, {
          email: email('colleague'),
          name: 'x',
          promote: true,
        })
        .expect(201);
      expect(promoted.body).toMatchObject({ promoted: true, activation: null });

      const twice = await as(operator).post(`/platform/tenants/${id}/admins`, {
        email: email('colleague'),
        name: 'x',
      });
      expect(twice.body.code).toBe('ALREADY_ADMIN');
    });

    it('issues a new code only to an administrator who has not activated', async () => {
      const tenant = (await as(operator).get(`/platform/tenants/${id}`).expect(200)).body;
      const pending = tenant.admins.find((a: { email: string }) => a.email === email('second'));
      const active = tenant.admins.find((a: { activated: boolean }) => a.activated);

      const code = await as(operator)
        .post(`/platform/tenants/${id}/admins/${pending.userId}/activation-code`)
        .expect(201);
      expect(code.body.code).toEqual(expect.any(String));
      const refused = await as(operator).post(
        `/platform/tenants/${id}/admins/${active.userId}/activation-code`,
      );
      expect(refused.body).toMatchObject({
        code: 'ACTIVATION_NOT_ALLOWED',
        detail: 'ALREADY_ACTIVATED',
      });
      const notAdmin = await as(operator).post(
        `/platform/tenants/${id}/admins/${world.users.u}/activation-code`,
      );
      expect(notAdmin.status).toBe(404);
    });

    it("keeps the history of the operators' actions, newest first", async () => {
      const res = await as(operator).get(`/platform/tenants/${id}/events?pageSize=100`).expect(200);
      const types = res.body.items.map((e: { type: string }) => e.type);

      expect(types).toEqual(
        expect.arrayContaining([
          'TENANT_CREATED',
          'MODULES_CHANGED',
          'TENANT_RENAMED',
          'TENANT_SUSPENDED',
          'TENANT_REACTIVATED',
          'MEMBER_UPDATED',
        ]),
      );
      // The colleague added by the tenant's administrator is not the operator's business.
      expect(
        res.body.items.filter((e: { type: string }) => e.type === 'MEMBER_ADDED'),
      ).toHaveLength(2);
      expect(res.body.items[0].actorName).toBe('Operatore');
      const ats = res.body.items.map((e: { at: string }) => e.at);
      expect([...ats].sort((x: string, y: string) => y.localeCompare(x))).toEqual(ats);
    });
  });

  it('answers 404 for a tenant that does not exist, and 400 for a bad id', async () => {
    const missing = '0198a000-0000-7000-8000-00000000dead';
    expect((await as(operator).get(`/platform/tenants/${missing}`)).status).toBe(404);
    expect((await as(operator).get(`/platform/tenants/${missing}/events`)).status).toBe(404);
    expect((await as(operator).get('/platform/tenants/not-a-uuid')).status).toBe(400);
  });
});
