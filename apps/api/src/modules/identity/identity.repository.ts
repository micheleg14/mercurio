import { Injectable } from '@nestjs/common';
import type { MembershipRole, Prisma, UserStatus } from '../../generated/prisma/client.js';
import type { DbClient } from '../../prisma/index.js';

/** What app_find_or_create_person tells about an identity. */
export interface PersonLookup {
  userId: string;
  created: boolean;
  status: UserStatus;
  activated: boolean;
}

/** What app_tenant_member_states tells about a member of the current tenant. */
export interface MemberState {
  userId: string;
  activated: boolean;
  otherTenants: boolean;
  lastSeenAt: Date | null;
}

export type IssueCodeOutcome = 'OK' | 'NOT_MEMBER' | 'ALREADY_ACTIVATED' | 'OTHER_TENANTS';

const ROLE_FIELDS = { id: true, name: true, permissions: true, archivedAt: true } as const;

/** A membership with what the services need of it, read one relation at a time (B39). */
export interface LoadedMembership {
  id: string;
  tenantId: string;
  userId: string;
  role: MembershipRole | null;
  customRoleId: string | null;
  status: 'ACTIVE' | 'REMOVED';
  allCompanies: boolean;
  version: number;
  createdAt: Date;
  user: { email: string; name: string };
  companies: { companyId: string }[];
  customRole: { id: string; name: string; permissions: string[]; archivedAt: Date | null } | null;
}

/**
 * The only code that touches the identity tables (B2, B3). Queries on memberships always
 * filter by tenant explicitly, as in TenancyRepository: the owner role used by terminal
 * commands is not restricted by Row-Level Security.
 */
@Injectable()
export class IdentityRepository {
  findUserByEmail(db: DbClient, email: string) {
    return db.user.findUnique({ where: { email } });
  }

  findUserById(db: DbClient, id: string) {
    return db.user.findUnique({ where: { id } });
  }

  /**
   * The identity with this email, created when there is none, through a privileged function: the
   * API role cannot read people outside its tenant nor insert them (docs/adr/0037).
   */
  async findOrCreatePerson(
    db: DbClient,
    data: { id: string; email: string; name: string },
  ): Promise<PersonLookup> {
    const [row] = await db.$queryRaw<
      { user_id: string; created: boolean; status: UserStatus; activated: boolean }[]
    >`SELECT user_id, created, status, activated
      FROM app_find_or_create_person(${data.id}::uuid, ${data.email}, ${data.name})`;
    return {
      userId: row!.user_id,
      created: row!.created,
      status: row!.status,
      activated: row!.activated,
    };
  }

  /** The person's active memberships, in every tenant (policy own_memberships). */
  listActiveMemberships(db: DbClient, userId: string) {
    return db.membership.findMany({
      where: { userId, status: 'ACTIVE' },
      include: { customRole: { select: { id: true, name: true } } },
    });
  }

  /** The membership with its companies and custom role; the user is not loaded. */
  async findMembershipWithCompanies(db: DbClient, tenantId: string, userId: string) {
    const membership = await db.membership.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      include: { companies: { select: { companyId: true } } },
    });
    if (!membership) return null;
    const customRole = membership.customRoleId
      ? await db.tenantRole.findUnique({
          where: { tenantId_id: { tenantId, id: membership.customRoleId } },
          select: ROLE_FIELDS,
        })
      : null;
    return { ...membership, customRole };
  }

  findMembership(db: DbClient, tenantId: string, userId: string) {
    return db.membership.findUnique({ where: { tenantId_userId: { tenantId, userId } } });
  }

  async findMembershipById(
    db: DbClient,
    tenantId: string,
    id: string,
  ): Promise<LoadedMembership | null> {
    const [membership] = await this.loadMembers(db, { tenantId, id });
    return membership ?? null;
  }

  createMembership(
    db: DbClient,
    data: {
      tenantId: string;
      userId: string;
      role: MembershipRole | null;
      customRoleId: string | null;
      allCompanies: boolean;
    },
  ) {
    return db.membership.create({ data });
  }

  updateMembership(
    db: DbClient,
    tenantId: string,
    id: string,
    data: {
      role?: MembershipRole | null;
      customRoleId?: string | null;
      allCompanies?: boolean;
      status?: 'ACTIVE' | 'REMOVED';
    },
  ) {
    return db.membership.update({
      where: { tenantId_id: { tenantId, id } },
      data: { ...data, version: { increment: 1 } },
    });
  }

  /** Like updateMembership, only if nobody saved in between (B29). Null when the version moved. */
  async updateMembershipAtVersion(
    db: DbClient,
    tenantId: string,
    id: string,
    version: number,
    data: { role?: MembershipRole | null; customRoleId?: string | null; allCompanies?: boolean },
  ) {
    const [updated] = await db.membership.updateManyAndReturn({
      where: { tenantId, id, version },
      data: { ...data, version: { increment: 1 } },
    });
    return updated ?? null;
  }

  /**
   * Locks the active administrators of a tenant, so two changes that each leave "another" admin
   * cannot run side by side and leave none. Returns their membership ids.
   */
  async lockActiveAdmins(db: DbClient, tenantId: string): Promise<string[]> {
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM memberships
      WHERE tenant_id = ${tenantId}::uuid AND role = 'ADMIN' AND status = 'ACTIVE'
      ORDER BY id
      FOR UPDATE`;
    return rows.map((r) => r.id);
  }

  /** The companies listed for a membership become exactly `companyIds`. */
  async replaceMembershipCompanies(
    db: DbClient,
    tenantId: string,
    membershipId: string,
    companyIds: readonly string[],
  ) {
    await db.membershipCompany.deleteMany({ where: { tenantId, membershipId } });
    await db.membershipCompany.createMany({
      data: companyIds.map((companyId) => ({ tenantId, membershipId, companyId })),
    });
  }

  addMembershipCompany(db: DbClient, tenantId: string, membershipId: string, companyId: string) {
    return db.membershipCompany.create({ data: { tenantId, membershipId, companyId } });
  }

  listMembers(
    db: DbClient,
    tenantId: string,
    where: Prisma.MembershipWhereInput = {},
  ): Promise<LoadedMembership[]> {
    return this.loadMembers(db, { tenantId, ...where });
  }

  /** Memberships with user, companies and custom role: one query per relation, in sequence (B39). */
  private async loadMembers(
    db: DbClient,
    where: Prisma.MembershipWhereInput,
  ): Promise<LoadedMembership[]> {
    const memberships = await db.membership.findMany({ where, orderBy: { createdAt: 'asc' } });
    if (memberships.length === 0) return [];
    const ids = memberships.map((m) => m.id);
    const users = await db.user.findMany({
      where: { id: { in: memberships.map((m) => m.userId) } },
      select: { id: true, email: true, name: true },
    });
    const links = await db.membershipCompany.findMany({
      where: { membershipId: { in: ids } },
      select: { membershipId: true, companyId: true },
    });
    const roleIds = [
      ...new Set(memberships.flatMap((m) => (m.customRoleId ? [m.customRoleId] : []))),
    ];
    const roles = roleIds.length
      ? await db.tenantRole.findMany({ where: { id: { in: roleIds } }, select: ROLE_FIELDS })
      : [];
    const userOf = new Map(users.map((u) => [u.id, u]));
    const roleOf = new Map(roles.map((r) => [r.id, r]));
    return memberships.map((m) => ({
      ...m,
      user: userOf.get(m.userId) ?? { email: '', name: '' },
      companies: links
        .filter((l) => l.membershipId === m.id)
        .map((l) => ({ companyId: l.companyId })),
      customRole: m.customRoleId ? (roleOf.get(m.customRoleId) ?? null) : null,
    }));
  }

  /** Activation state and last use of the members of the current tenant (privileged function). */
  async memberStates(db: DbClient): Promise<Map<string, MemberState>> {
    const rows = await db.$queryRaw<
      { user_id: string; activated: boolean; other_tenants: boolean; last_seen_at: Date | null }[]
    >`SELECT user_id, activated, other_tenants, last_seen_at FROM app_tenant_member_states()`;
    return new Map(
      rows.map((r) => [
        r.user_id,
        {
          userId: r.user_id,
          activated: r.activated,
          otherTenants: r.other_tenants,
          lastSeenAt: r.last_seen_at,
        },
      ]),
    );
  }

  /** A new code replaces any unused one of the same user. Owner role only (terminal commands). */
  async replaceActivationToken(
    db: DbClient,
    data: { userId: string; tokenHash: string; expiresAt: Date },
  ) {
    await db.activationToken.deleteMany({ where: { userId: data.userId, usedAt: null } });
    await db.activationToken.create({ data });
  }

  /**
   * A code issued from the interface: the privileged function decides whether it is allowed,
   * whatever the API checked before (docs/adr/0037).
   */
  async issueMemberActivationToken(
    db: DbClient,
    data: { id: string; userId: string; tokenHash: string; expiresAt: Date },
  ): Promise<IssueCodeOutcome> {
    const [row] = await db.$queryRaw<{ outcome: IssueCodeOutcome }[]>`
      SELECT app_issue_activation_code(
        ${data.id}::uuid, ${data.userId}::uuid, ${data.tokenHash}, ${data.expiresAt}::timestamptz
      ) AS outcome`;
    return row!.outcome;
  }

  // --- Custom roles -------------------------------------------------------------------------

  listRoles(db: DbClient, tenantId: string, archived = false) {
    return db.tenantRole.findMany({
      where: { tenantId, archivedAt: archived ? { not: null } : null },
      orderBy: { name: 'asc' },
      include: { _count: { select: { memberships: { where: { status: 'ACTIVE' } } } } },
    });
  }

  findRole(db: DbClient, tenantId: string, id: string) {
    return db.tenantRole.findUnique({
      where: { tenantId_id: { tenantId, id } },
      include: { _count: { select: { memberships: { where: { status: 'ACTIVE' } } } } },
    });
  }

  findActiveRoleByName(db: DbClient, tenantId: string, name: string) {
    return db.tenantRole.findFirst({
      where: { tenantId, archivedAt: null, name: { equals: name, mode: 'insensitive' } },
    });
  }

  createRole(
    db: DbClient,
    data: {
      tenantId: string;
      name: string;
      description: string | null;
      permissions: string[];
      basedOn: MembershipRole | null;
    },
  ) {
    return db.tenantRole.create({ data });
  }

  async updateRoleAtVersion(
    db: DbClient,
    tenantId: string,
    id: string,
    version: number,
    data: Prisma.TenantRoleUpdateManyMutationInput,
  ) {
    const [updated] = await db.tenantRole.updateManyAndReturn({
      where: { tenantId, id, version },
      data: { ...data, version: { increment: 1 } },
    });
    return updated ?? null;
  }

  /** Active members holding a custom role, locked so nobody gets it while it is archived. */
  async lockRoleHolders(db: DbClient, tenantId: string, roleId: string): Promise<number> {
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM memberships
      WHERE tenant_id = ${tenantId}::uuid AND custom_role_id = ${roleId}::uuid AND status = 'ACTIVE'
      FOR UPDATE`;
    return rows.length;
  }

  /** Locks a custom role, so a membership cannot get it while it is being archived. */
  async lockRole(db: DbClient, tenantId: string, roleId: string) {
    const rows = await db.$queryRaw<{ name: string; archived_at: Date | null }[]>`
      SELECT name, archived_at FROM tenant_roles
      WHERE tenant_id = ${tenantId}::uuid AND id = ${roleId}::uuid
      FOR UPDATE`;
    return rows[0] ?? null;
  }

  // --- Platform operators -------------------------------------------------------------------

  /** The open grant of a person, if any. Owner role (terminal commands). */
  findOpenOperatorGrant(db: DbClient, userId: string) {
    return db.platformOperator.findFirst({ where: { userId, revokedAt: null } });
  }

  createOperatorGrant(db: DbClient, data: { userId: string; grantedBy?: string }) {
    return db.platformOperator.create({ data: { userId: data.userId, grantedBy: data.grantedBy } });
  }

  revokeOperatorGrant(db: DbClient, id: string, data: { revokedBy?: string; reason: string }) {
    return db.platformOperator.update({
      where: { id },
      data: { revokedAt: new Date(), revokedBy: data.revokedBy, revokeReason: data.reason },
    });
  }

  /** Every grant, open and revoked, with the person: for the terminal. */
  listOperatorGrants(db: DbClient) {
    return db.platformOperator.findMany({
      orderBy: [{ grantedAt: 'asc' }, { id: 'asc' }],
      include: { user: { select: { email: true, name: true } } },
    });
  }

  /** Whether the person in the context (app.user_id) holds an open operator grant. */
  async isPlatformOperator(db: DbClient): Promise<boolean> {
    const [row] = await db.$queryRaw<{ active: boolean }[]>`
      SELECT app_platform_operator_active() AS active`;
    return row?.active === true;
  }
}
