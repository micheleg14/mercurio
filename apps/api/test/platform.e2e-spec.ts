import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { activate, bearer, createTestApp } from './support/auth.js';
import {
  adminClient,
  createWorld,
  deleteTenantsAndUsers,
  uniqueSuffix,
  type World,
} from './support/database.js';

// The platform area through the API (docs/adr/0038). U is ADMIN of A and READ_ONLY in B; the
// operator belongs to no tenant. The database functions are tested in platform-database.
describe('platform area (e2e)', () => {
  let app: NestExpressApplication;
  let admin: PrismaClient;
  let world: World;
  const suffix = uniqueSuffix();
  const extraUsers: string[] = [];
  let operatorId: string;
  const token: { operator: string; u: string; uInA: string } = {} as never;
  const http = () => request(app.getHttpServer());
  const get = (who: string, url: string) => http().get(`/api${url}`).set(bearer(who));

  beforeAll(async () => {
    admin = adminClient();
    world = await createWorld(admin);
    app = await createTestApp();
    const operator = await admin.user.create({
      data: { email: `operator-${suffix}@example.com`, name: 'Operatore' },
    });
    operatorId = operator.id;
    extraUsers.push(operatorId);
    await admin.platformOperator.create({ data: { userId: operatorId } });

    token.operator = (await activate(app, admin, operatorId)).accessToken;
    token.u = (await activate(app, admin, world.users.u)).accessToken;
    const chosen = await http()
      .post('/api/auth/tenant')
      .set(bearer(token.u))
      .send({ tenantId: world.tenants.a })
      .expect(200);
    token.uInA = chosen.body.accessToken;
  });

  afterAll(async () => {
    await app?.close();
    if (world) {
      await deleteTenantsAndUsers(admin, Object.values(world.tenants), [
        ...Object.values(world.users),
        ...extraUsers,
      ]);
    }
    await admin.$disconnect();
  });

  it('tells the interface who may open the area', async () => {
    const operator = await get(token.operator, '/auth/me').expect(200);
    const member = await get(token.uInA, '/auth/me').expect(200);

    expect(operator.body).toMatchObject({ platformOperator: true, tenant: null, tenants: [] });
    expect(member.body.platformOperator).toBe(false);
  });

  it('opens platform routes to an operator without a tenant', async () => {
    const res = await get(token.operator, '/platform/modules').expect(200);

    expect(res.body).toEqual(
      expect.arrayContaining([
        {
          key: 'registry',
          requires: [],
          requiredBy: ['warehouse', 'orders', 'invoicing'],
          alwaysOn: true,
        },
        { key: 'orders', requires: ['registry', 'warehouse'], requiredBy: [], alwaysOn: false },
      ]),
    );
  });

  it('refuses them to a tenant administrator, with or without a tenant chosen', async () => {
    for (const who of [token.u, token.uInA]) {
      const res = await get(who, '/platform/modules').expect(403);
      expect(res.body.code).toBe('NOT_PLATFORM_OPERATOR');
    }
    await http().get('/api/platform/modules').expect(401);
  });

  it('gives an operator who is no member nothing of a tenant', async () => {
    for (const url of ['/parties', '/stock', '/orders', '/invoices', '/members', '/audit-events']) {
      const res = await get(token.operator, url).set('X-Company-Id', world.companies.a);
      // Refused before any data is read: 401 from the module guard on module routes (it runs
      // first and needs a tenant), 403 TENANT_NOT_SELECTED from the permission guard otherwise.
      expect([401, 403]).toContain(res.status);
      expect(res.body.items).toBeUndefined();
    }
    const choose = await http()
      .post('/api/auth/tenant')
      .set(bearer(token.operator))
      .send({ tenantId: world.tenants.a });
    expect(choose.status).toBe(403);
  });

  it('works for an operator who is also a member, inside a tenant', async () => {
    const grant = await admin.platformOperator.create({ data: { userId: world.users.u } });
    try {
      await get(token.uInA, '/platform/modules').expect(200);
      expect((await get(token.uInA, '/auth/me').expect(200)).body.platformOperator).toBe(true);
    } finally {
      await admin.platformOperator.update({
        where: { id: grant.id },
        data: { revokedAt: new Date(), revokeReason: 'test' },
      });
    }
  });

  it('a revocation takes effect at the next request, with the same token', async () => {
    await get(token.operator, '/platform/modules').expect(200);
    await admin.platformOperator.updateMany({
      where: { userId: operatorId, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: 'test' },
    });

    const res = await get(token.operator, '/platform/modules').expect(403);
    expect(res.body.code).toBe('NOT_PLATFORM_OPERATOR');
    expect((await get(token.operator, '/auth/me').expect(200)).body.platformOperator).toBe(false);
  });
});
