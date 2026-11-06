import { randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { deleteTenantData } from '../../src/cli/demo-reset.js';
import { PrismaClient } from '../../src/generated/prisma/client.js';

/**
 * Client with the owner role (DATABASE_ADMIN_URL), which bypasses Row-Level Security: tests use
 * it only to prepare and remove data, never to check what the API can see.
 */
export function adminClient(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_ADMIN_URL! }),
  });
}

/**
 * Three tenants and three people, enough to prove isolation in every direction:
 * - U is ADMIN in A (all companies) and READ_ONLY in B (only B's first company);
 * - V is a member of B only; W is a member of C only.
 * Names carry a random suffix, so test files running in parallel never collide.
 */
export interface World {
  tenants: { a: string; b: string; c: string };
  companies: { a: string; b: string; b2: string; c: string };
  users: { u: string; v: string; w: string };
  memberships: { ua: string; ub: string; vb: string; wc: string };
}

export async function createWorld(admin: PrismaClient): Promise<World> {
  const suffix = randomBytes(4).toString('hex');
  const tenant = (key: string) =>
    admin.tenant.create({ data: { name: `Test ${key}`, slug: `test-${key}-${suffix}` } });
  const company = (tenantId: string, name: string, vatNumber: string) =>
    admin.company.create({ data: { tenantId, legalName: name, vatNumber } });
  const user = (key: string) =>
    admin.user.create({ data: { email: `${key}-${suffix}@example.com`, name: key.toUpperCase() } });

  const [a, b, c] = [await tenant('a'), await tenant('b'), await tenant('c')];
  const companies = {
    a: (await company(a.id, 'A Srl', '00000000001')).id,
    b: (await company(b.id, 'B Srl', '00000000002')).id,
    b2: (await company(b.id, 'B Logistica Srl', '00000000003')).id,
    c: (await company(c.id, 'C Srl', '00000000004')).id,
  };
  const [u, v, w] = [await user('u'), await user('v'), await user('w')];

  const membership = (
    tenantId: string,
    userId: string,
    role: 'ADMIN' | 'READ_ONLY',
    allCompanies: boolean,
  ) => admin.membership.create({ data: { tenantId, userId, role, allCompanies } });
  const ua = await membership(a.id, u.id, 'ADMIN', true);
  const ub = await membership(b.id, u.id, 'READ_ONLY', false);
  const vb = await membership(b.id, v.id, 'ADMIN', true);
  const wc = await membership(c.id, w.id, 'ADMIN', true);
  await admin.membershipCompany.create({
    data: { tenantId: b.id, membershipId: ub.id, companyId: companies.b },
  });
  await admin.tenantModule.createMany({
    data: [a, b, c].map((t) => ({ tenantId: t.id, moduleKey: 'registry' })),
  });

  return {
    tenants: { a: a.id, b: b.id, c: c.id },
    companies,
    users: { u: u.id, v: v.id, w: w.id },
    memberships: { ua: ua.id, ub: ub.id, vb: vb.id, wc: wc.id },
  };
}

/** Removes everything createWorld created, children first. */
export async function deleteWorld(admin: PrismaClient, world: World): Promise<void> {
  await deleteTenantsAndUsers(admin, Object.values(world.tenants), Object.values(world.users));
}

/** Removes tenants (with everything inside them) and users created by a test. */
export async function deleteTenantsAndUsers(
  admin: PrismaClient,
  tenantIds: readonly string[],
  userIds: readonly string[],
): Promise<void> {
  const userId = { in: [...userIds] };
  // The tenants with the same list as reset-demo, then the people. The audit tables refuse
  // deletes (append-only trigger): in this transaction the owner turns triggers off for itself,
  // which no API role can do.
  await admin.$transaction((tx) => deleteTenantData(tx, tenantIds), { timeout: 60_000 });
  await admin.$transaction([
    admin.$executeRaw`SET LOCAL session_replication_role = replica`,
    admin.auditEvent.deleteMany({ where: { actorUserId: userId } }),
    admin.authEvent.deleteMany({ where: { userId } }),
  ]);
  await admin.session.deleteMany({ where: { userId } });
  await admin.recoveryCode.deleteMany({ where: { userId } });
  await admin.credential.deleteMany({ where: { userId } });
  await admin.membershipCompany.deleteMany({ where: { membership: { userId } } });
  await admin.membership.deleteMany({ where: { userId } });
  await admin.activationToken.deleteMany({ where: { userId } });
  await admin.platformOperator.deleteMany({
    where: { OR: [{ userId }, { grantedBy: userId }, { revokedBy: userId }] },
  });
  await admin.user.deleteMany({ where: { id: userId } });
}

/** A UUID version 7 (B7), as a client makes one for a new document (B33). */
export { uuidv7 } from '../../src/shared/uuid.js';

/** A random suffix for names, so test files running in parallel never collide. */
export function uniqueSuffix(): string {
  return randomBytes(4).toString('hex');
}
