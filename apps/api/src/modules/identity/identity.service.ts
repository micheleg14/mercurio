import { HttpStatus, Injectable } from '@nestjs/common';
import type { MembershipRole, TenantRole } from '../../generated/prisma/client.js';
import { type DbClient, isUniqueViolation } from '../../prisma/index.js';
import { DomainException } from '../../shared/errors/index.js';
import { normalizeName } from '../../shared/text.js';
import { uuidv7 } from '../../shared/uuid.js';
import { assertVersion, editConflict } from '../../shared/versioning.js';
import { TenancyService } from '../tenancy/index.js';
import { newActivationCode } from './activation-code.js';
import type { CompanyAccess } from './company-access.js';
import { normalizeEmail } from './email.js';
import { IdentityRepository, type MemberState } from './identity.repository.js';
import {
  BUILTIN_ROLES,
  type CustomRoleInput,
  isBuiltinRole,
  membershipPermissions,
  normalizeCustomRole,
  type RoleChoice,
  type RoleRef,
  roleRefOf,
} from './roles.js';

export const ROLES = BUILTIN_ROLES;

export interface MemberInput {
  tenantId: string;
  email: string;
  name: string;
  /**
   * The role to give: a built-in key or the name of a custom role as people type it in commands,
   * or an exact choice from the interface.
   */
  role: string | RoleChoice;
  /** "all", or the ids of the companies the member can reach. */
  companies: 'all' | readonly string[];
}

/** Who asks for a change from the interface: their own membership is out of reach. */
export interface Actor {
  userId: string;
}

/** What a tenant administrator sees of a member. */
export interface MemberView {
  membershipId: string;
  userId: string;
  email: string;
  name: string;
  role: RoleRef;
  allCompanies: boolean;
  companyIds: string[];
  status: 'ACTIVE' | 'REMOVED';
  /** Activated their account (password and two-factor). */
  activated: boolean;
  /** Whether a new activation code can be issued from the interface. */
  canIssueCode: boolean;
  lastSeenAt: Date | null;
  version: number;
  createdAt: Date;
}

/**
 * Public service of the identity module (B3): people, their memberships in tenants and the
 * companies they can reach, and the roles a tenant defines. Methods take the database client so a
 * caller can combine modules in one transaction (creating a tenant with its first administrator,
 * or recording the audit event of a change).
 */
@Injectable()
export class IdentityService {
  constructor(
    private readonly repository: IdentityRepository,
    private readonly tenancy: TenancyService,
  ) {}

  /**
   * Adds a person to a tenant. One identity per email across tenants (S4): an existing one is
   * reused and only gets a new membership; a removed membership is reactivated. No activation
   * code here: the caller issues it, through the path its role allows (issueActivationCode for
   * terminal commands, issueMemberActivationCode for the interface).
   */
  async addMember(db: DbClient, input: MemberInput) {
    const email = normalizeEmail(input.email);
    const { label, ...role } = await this.resolveRole(db, input.tenantId, input.role);
    const { allCompanies, companyIds } = await this.companiesOf(
      db,
      input.tenantId,
      input.companies,
    );

    const person = await this.repository.findOrCreatePerson(db, {
      id: uuidv7(),
      email,
      name: normalizeName(input.name),
    });
    if (person.status !== 'ACTIVE') {
      throw new DomainException('USER_DISABLED', HttpStatus.CONFLICT, { detail: email });
    }

    const existing = await this.repository.findMembership(db, input.tenantId, person.userId);
    if (existing?.status === 'ACTIVE') {
      throw new DomainException('MEMBERSHIP_EXISTS', HttpStatus.CONFLICT, {
        detail: email,
        errors: [{ field: 'email', code: 'MEMBERSHIP_EXISTS' }],
      });
    }
    const membership = existing
      ? await this.repository.updateMembership(db, input.tenantId, existing.id, {
          ...role,
          allCompanies,
          status: 'ACTIVE',
        })
      : await this.repository.createMembership(db, {
          tenantId: input.tenantId,
          userId: person.userId,
          ...role,
          allCompanies,
        });
    await this.repository.replaceMembershipCompanies(db, input.tenantId, membership.id, companyIds);

    return {
      userId: person.userId,
      email,
      membershipId: membership.id,
      /** The role as the audit log and the terminal show it: a built-in key or a custom name. */
      role: label,
      identityCreated: person.created,
      /** An identity that existed but was never activated, in this tenant only, can get a code. */
      activated: person.activated,
      reactivated: Boolean(existing),
    };
  }

  /**
   * Changes the role or the companies of a member. Refused on oneself (another administrator
   * does it) and when it would leave the tenant without an active administrator.
   */
  async updateMember(
    db: DbClient,
    tenantId: string,
    actor: Actor,
    membershipId: string,
    change: { version: number; role?: RoleChoice; companies?: 'all' | readonly string[] },
  ) {
    const current = await this.requireMember(db, tenantId, membershipId);
    assertVersion(current, change.version);
    if (current.status !== 'ACTIVE') {
      throw new DomainException('MEMBERSHIP_NOT_FOUND', HttpStatus.NOT_FOUND);
    }
    this.refuseSelf(actor, current.userId);

    const resolved = change.role ? await this.resolveRole(db, tenantId, change.role) : undefined;
    const role = resolved
      ? { role: resolved.role, customRoleId: resolved.customRoleId }
      : undefined;
    const companies = change.companies
      ? await this.companiesOf(db, tenantId, change.companies)
      : undefined;
    if (current.role === 'ADMIN' && role && role.role !== 'ADMIN') {
      await this.assertAnotherAdmin(db, tenantId, current.id);
    }

    const updated = await this.repository.updateMembershipAtVersion(
      db,
      tenantId,
      membershipId,
      change.version,
      { ...role, ...(companies ? { allCompanies: companies.allCompanies } : {}) },
    );
    if (!updated) throw editConflict();
    if (companies) {
      await this.repository.replaceMembershipCompanies(
        db,
        tenantId,
        membershipId,
        companies.companyIds,
      );
    }
    const after = await this.requireMember(db, tenantId, membershipId);
    return {
      before: describeMembership(current),
      after: describeMembership(after),
      email: current.user.email,
    };
  }

  /**
   * Whoever creates a company and reaches only listed companies gets the new one in their list:
   * otherwise they would create a company they cannot open. It widens nothing they could do,
   * so it is not a change of oneself. Returns whether the list changed.
   */
  async grantCreatedCompany(db: DbClient, tenantId: string, userId: string, companyId: string) {
    const membership = await this.repository.findMembership(db, tenantId, userId);
    if (!membership || membership.status !== 'ACTIVE' || membership.allCompanies) return false;
    await this.repository.addMembershipCompany(db, tenantId, membership.id, companyId);
    return true;
  }

  /** Removes a person from a tenant by membership (interface). Same rules as updateMember. */
  async removeMemberById(
    db: DbClient,
    tenantId: string,
    actor: Actor,
    membershipId: string,
    version: number,
  ) {
    const current = await this.requireMember(db, tenantId, membershipId);
    assertVersion(current, version);
    if (current.status !== 'ACTIVE') {
      throw new DomainException('MEMBERSHIP_NOT_FOUND', HttpStatus.NOT_FOUND);
    }
    this.refuseSelf(actor, current.userId);
    if (current.role === 'ADMIN') await this.assertAnotherAdmin(db, tenantId, current.id);
    await this.repository.updateMembership(db, tenantId, current.id, { status: 'REMOVED' });
    return { userId: current.userId, membershipId: current.id, email: current.user.email };
  }

  /** Removes a person from a tenant by email (terminal). The identity and history stay (B10). */
  async removeMember(db: DbClient, input: { tenantId: string; email: string }) {
    const user = await this.repository.findUserByEmail(db, normalizeEmail(input.email));
    const membership = user && (await this.repository.findMembership(db, input.tenantId, user.id));
    if (!membership || membership.status !== 'ACTIVE') {
      throw new DomainException('MEMBERSHIP_NOT_FOUND', HttpStatus.NOT_FOUND, {
        detail: input.email,
      });
    }
    if (membership.role === 'ADMIN') {
      await this.assertAnotherAdmin(db, input.tenantId, membership.id);
    }
    await this.repository.updateMembership(db, input.tenantId, membership.id, {
      status: 'REMOVED',
    });
    return { userId: user!.id, membershipId: membership.id };
  }

  /** The members of the current tenant as an administrator sees them, oldest first. */
  async listMemberViews(
    db: DbClient,
    tenantId: string,
    filter: { includeRemoved?: boolean } = {},
  ): Promise<MemberView[]> {
    // One query after the other: a transaction runs one query at a time (pg@9).
    const members = await this.repository.listMembers(
      db,
      tenantId,
      filter.includeRemoved ? {} : { status: 'ACTIVE' },
    );
    const states = await this.repository.memberStates(db);
    return members.map((m) => toView(m, states.get(m.userId)));
  }

  async getMemberView(db: DbClient, tenantId: string, membershipId: string): Promise<MemberView> {
    const member = await this.requireMember(db, tenantId, membershipId);
    const states = await this.repository.memberStates(db);
    return toView(member, states.get(member.userId));
  }

  /** The person with this email; fails when there is none. For terminal commands. */
  async requireUserByEmail(db: DbClient, email: string) {
    const user = await this.repository.findUserByEmail(db, normalizeEmail(email));
    if (!user) throw new DomainException('USER_NOT_FOUND', HttpStatus.NOT_FOUND, { detail: email });
    return user;
  }

  /** The person behind an id: used by the auth module to check they can still sign in. */
  getUser(db: DbClient, userId: string) {
    return this.repository.findUserById(db, userId);
  }

  /**
   * Whether the person of the database context is a platform operator (docs/adr/0038). Read on
   * every request to a platform route: a revocation takes effect at once.
   */
  isPlatformOperator(db: DbClient): Promise<boolean> {
    return this.repository.isPlatformOperator(db);
  }

  /**
   * Makes a person a platform operator (terminal commands, owner role). An unknown email becomes
   * a new identity when a name is given; the caller then issues its activation code. One open
   * grant per person: granting twice is refused.
   */
  async grantPlatformOperator(db: DbClient, input: { email: string; name?: string }) {
    const email = normalizeEmail(input.email);
    const existing = await this.repository.findUserByEmail(db, email);
    if (!existing && !input.name) {
      throw new DomainException('USER_NOT_FOUND', HttpStatus.NOT_FOUND, {
        detail: `${email}: add --name to create the identity`,
      });
    }
    const person = await this.repository.findOrCreatePerson(db, {
      id: uuidv7(),
      email,
      name: normalizeName(input.name ?? existing!.name),
    });
    if (person.status !== 'ACTIVE') {
      throw new DomainException('USER_DISABLED', HttpStatus.CONFLICT, { detail: email });
    }
    if (await this.repository.findOpenOperatorGrant(db, person.userId)) {
      throw new DomainException('ALREADY_PLATFORM_OPERATOR', HttpStatus.CONFLICT, {
        detail: email,
      });
    }
    const grant = await this.repository.createOperatorGrant(db, { userId: person.userId });
    return { grantId: grant.id, userId: person.userId, email, identityCreated: person.created };
  }

  /** The person is an operator afterwards: granted if they were not (the demo seed). */
  async ensurePlatformOperator(db: DbClient, input: { email: string; name: string }) {
    const user = await this.repository.findUserByEmail(db, normalizeEmail(input.email));
    if (user && (await this.repository.findOpenOperatorGrant(db, user.id))) {
      return { userId: user.id, granted: false };
    }
    const grant = await this.grantPlatformOperator(db, input);
    return { userId: grant.userId, granted: true };
  }

  /** Closes the open grant of a person; the row stays as history. */
  async revokePlatformOperator(db: DbClient, input: { email: string; reason: string }) {
    const email = normalizeEmail(input.email);
    const reason = input.reason.trim();
    if (!reason) throw new DomainException('STATUS_REASON_REQUIRED', HttpStatus.BAD_REQUEST);
    const user = await this.repository.findUserByEmail(db, email);
    const grant = user ? await this.repository.findOpenOperatorGrant(db, user.id) : null;
    if (!user || !grant) {
      throw new DomainException('NOT_PLATFORM_OPERATOR', HttpStatus.NOT_FOUND, { detail: email });
    }
    await this.repository.revokeOperatorGrant(db, grant.id, { reason });
    return { grantId: grant.id, userId: user.id, email };
  }

  listPlatformOperators(db: DbClient) {
    return this.repository.listOperatorGrants(db);
  }

  /** Tenants where the person is an active member, with their role there. */
  async listActiveMemberships(db: DbClient, userId: string) {
    const memberships = await this.repository.listActiveMemberships(db, userId);
    return memberships.map((m) => ({ tenantId: m.tenantId, role: roleRefOf(m) }));
  }

  /**
   * The person's active membership in a tenant with its role, permissions and the companies it
   * reaches, or null. Read on every request: removing someone, changing their role or the
   * permissions of their role takes effect immediately.
   */
  async getActiveMembership(db: DbClient, tenantId: string, userId: string) {
    const m = await this.repository.findMembershipWithCompanies(db, tenantId, userId);
    if (!m || m.status !== 'ACTIVE') return null;
    return {
      id: m.id,
      role: roleRefOf(m),
      permissions: membershipPermissions(m),
      access: {
        status: m.status,
        allCompanies: m.allCompanies,
        companyIds: m.companies.map((c) => c.companyId),
      } satisfies CompanyAccess,
    };
  }

  /**
   * A new one-time code for the user; any unused previous code stops working. Terminal commands
   * only (owner role): it also recovers an active account, which the interface never may.
   */
  async issueActivationCode(db: DbClient, userId: string) {
    const { code, hash, expiresAt } = newActivationCode();
    await this.repository.replaceActivationToken(db, { userId, tokenHash: hash, expiresAt });
    return { code, expiresAt };
  }

  /** Same as issueActivationCode, for a person named by email (terminal commands). */
  async issueActivationCodeFor(db: DbClient, email: string) {
    const user = await this.repository.findUserByEmail(db, normalizeEmail(email));
    if (!user) throw new DomainException('USER_NOT_FOUND', HttpStatus.NOT_FOUND, { detail: email });
    return { userId: user.id, email: user.email, ...(await this.issueActivationCode(db, user.id)) };
  }

  /**
   * A code issued by a tenant administrator: only for an identity never activated and that
   * belongs to no other tenant. The database function enforces it (docs/adr/0037).
   */
  async issueMemberActivationCode(db: DbClient, userId: string) {
    const { code, hash, expiresAt } = newActivationCode();
    const outcome = await this.repository.issueMemberActivationToken(db, {
      id: uuidv7(),
      userId,
      tokenHash: hash,
      expiresAt,
    });
    if (outcome === 'NOT_MEMBER') {
      throw new DomainException('MEMBERSHIP_NOT_FOUND', HttpStatus.NOT_FOUND);
    }
    if (outcome !== 'OK') {
      throw new DomainException('ACTIVATION_NOT_ALLOWED', HttpStatus.CONFLICT, {
        detail: outcome,
      });
    }
    return { code, expiresAt };
  }

  /** Every member of a tenant with email, name and role: for terminal commands. */
  async listMembers(db: DbClient, tenantId: string) {
    const members = await this.repository.listMembers(db, tenantId);
    return members.map((m) => ({
      email: m.user.email,
      name: m.user.name,
      role: roleLabel(roleRefOf(m)),
      status: m.status,
      access: {
        status: m.status,
        allCompanies: m.allCompanies,
        companyIds: m.companies.map((c) => c.companyId),
      } satisfies CompanyAccess,
    }));
  }

  // --- Custom roles -------------------------------------------------------------------------

  listRoles(db: DbClient, tenantId: string) {
    return this.repository.listRoles(db, tenantId);
  }

  async getRole(db: DbClient, tenantId: string, id: string) {
    const role = await this.repository.findRole(db, tenantId, id);
    if (!role) throw new DomainException('ROLE_NOT_FOUND', HttpStatus.NOT_FOUND);
    return role;
  }

  /** Counts the active members of each built-in role, for the list of roles. */
  async builtinRoleCounts(db: DbClient, tenantId: string): Promise<Record<MembershipRole, number>> {
    const members = await this.repository.listMembers(db, tenantId, { status: 'ACTIVE' });
    const counts = Object.fromEntries(BUILTIN_ROLES.map((r) => [r, 0])) as Record<
      MembershipRole,
      number
    >;
    for (const m of members) if (m.role) counts[m.role] += 1;
    return counts;
  }

  async createRole(
    db: DbClient,
    tenantId: string,
    input: CustomRoleInput & { basedOn?: MembershipRole | null },
  ): Promise<TenantRole> {
    const data = normalizeCustomRole(input);
    try {
      return await this.repository.createRole(db, {
        tenantId,
        ...data,
        basedOn: input.basedOn ?? null,
      });
    } catch (error) {
      throw isUniqueViolation(error) ? roleNameTaken() : error;
    }
  }

  async updateRole(
    db: DbClient,
    tenantId: string,
    id: string,
    input: CustomRoleInput & { version: number },
  ) {
    const current = await this.getRole(db, tenantId, id);
    assertVersion(current, input.version);
    if (current.archivedAt) throw new DomainException('ARCHIVED', HttpStatus.CONFLICT);
    const data = normalizeCustomRole(input);
    try {
      const updated = await this.repository.updateRoleAtVersion(
        db,
        tenantId,
        id,
        input.version,
        data,
      );
      if (!updated) throw editConflict();
      return { before: current, after: updated };
    } catch (error) {
      throw isUniqueViolation(error) ? roleNameTaken() : error;
    }
  }

  /** Archives a custom role nobody holds (B31). Its name becomes free again. */
  async archiveRole(db: DbClient, tenantId: string, id: string, version: number) {
    const current = await this.getRole(db, tenantId, id);
    assertVersion(current, version);
    if (current.archivedAt) throw new DomainException('ALREADY_ARCHIVED', HttpStatus.CONFLICT);
    // Update first: the row lock makes a member being given this role finish before the count
    // below (resolveRole locks the role too), so the count sees them.
    const updated = await this.repository.updateRoleAtVersion(db, tenantId, id, version, {
      archivedAt: new Date(),
    });
    if (!updated) throw editConflict();
    if ((await this.repository.lockRoleHolders(db, tenantId, id)) > 0) {
      throw new DomainException('ROLE_IN_USE', HttpStatus.CONFLICT);
    }
    return updated;
  }

  // --- Helpers ------------------------------------------------------------------------------

  private async requireMember(db: DbClient, tenantId: string, membershipId: string) {
    const member = await this.repository.findMembershipById(db, tenantId, membershipId);
    if (!member) throw new DomainException('MEMBERSHIP_NOT_FOUND', HttpStatus.NOT_FOUND);
    return member;
  }

  private refuseSelf(actor: Actor, userId: string) {
    if (actor.userId === userId) {
      throw new DomainException('MEMBER_SELF_CHANGE', HttpStatus.CONFLICT);
    }
  }

  /** Refuses a change that would leave the tenant without an active administrator. */
  private async assertAnotherAdmin(db: DbClient, tenantId: string, membershipId: string) {
    const admins = await this.repository.lockActiveAdmins(db, tenantId);
    if (admins.filter((id) => id !== membershipId).length === 0) {
      throw new DomainException('LAST_ADMIN', HttpStatus.CONFLICT);
    }
  }

  /** The role columns for a choice, checking a custom role exists, is in use and stays so. */
  private async resolveRole(
    db: DbClient,
    tenantId: string,
    choice: string | RoleChoice,
  ): Promise<{ role: MembershipRole | null; customRoleId: string | null; label: string }> {
    if (typeof choice === 'string') {
      const key = choice.trim().toUpperCase().replace(/[-\s]/g, '_');
      if (isBuiltinRole(key)) return { role: key, customRoleId: null, label: key };
      const custom = await this.repository.findActiveRoleByName(db, tenantId, choice.trim());
      if (!custom) {
        throw new DomainException('INVALID_ROLE', HttpStatus.BAD_REQUEST, {
          detail: `expected one of ${BUILTIN_ROLES.join(', ')} or a custom role of the tenant`,
        });
      }
      choice = { customRoleId: custom.id };
    }
    if ('builtin' in choice) {
      if (!isBuiltinRole(choice.builtin)) {
        throw new DomainException('INVALID_ROLE', HttpStatus.BAD_REQUEST);
      }
      return { role: choice.builtin, customRoleId: null, label: choice.builtin };
    }
    const locked = await this.repository.lockRole(db, tenantId, choice.customRoleId);
    if (!locked || locked.archived_at) {
      throw new DomainException('ROLE_NOT_FOUND', HttpStatus.BAD_REQUEST, {
        errors: [{ field: 'role', code: 'ROLE_NOT_FOUND' }],
      });
    }
    return { role: null, customRoleId: choice.customRoleId, label: locked.name };
  }

  private async companiesOf(db: DbClient, tenantId: string, companies: 'all' | readonly string[]) {
    const allCompanies = companies === 'all';
    const companyIds = allCompanies ? [] : [...new Set(companies)];
    if (!allCompanies && companyIds.length === 0) {
      throw new DomainException('MEMBERSHIP_NEEDS_COMPANIES', HttpStatus.BAD_REQUEST, {
        errors: [{ field: 'companies', code: 'MEMBERSHIP_NEEDS_COMPANIES' }],
      });
    }
    await this.tenancy.assertCompaniesInTenant(db, tenantId, companyIds);
    return { allCompanies, companyIds };
  }
}

function roleNameTaken() {
  return new DomainException('ROLE_NAME_TAKEN', HttpStatus.CONFLICT, {
    errors: [{ field: 'name', code: 'ROLE_NAME_TAKEN' }],
  });
}

/** A role as terminal commands print it. */
export function roleLabel(role: RoleRef): string {
  return role.kind === 'builtin' ? role.key : role.name;
}

/** What changed in a membership, for the audit log: role and companies, never personal data. */
function describeMembership(m: {
  role: MembershipRole | null;
  customRole: { id: string; name: string } | null;
  allCompanies: boolean;
  companies: { companyId: string }[];
}) {
  return {
    role: roleLabel(roleRefOf(m)),
    companies: m.allCompanies ? 'all' : m.companies.map((c) => c.companyId).sort(),
  };
}

function toView(
  m: {
    id: string;
    userId: string;
    user: { email: string; name: string };
    role: MembershipRole | null;
    customRole: { id: string; name: string } | null;
    allCompanies: boolean;
    companies: { companyId: string }[];
    status: 'ACTIVE' | 'REMOVED';
    version: number;
    createdAt: Date;
  },
  state: MemberState | undefined,
): MemberView {
  const activated = state?.activated ?? false;
  return {
    membershipId: m.id,
    userId: m.userId,
    email: m.user.email,
    name: m.user.name,
    role: roleRefOf(m),
    allCompanies: m.allCompanies,
    companyIds: m.companies.map((c) => c.companyId),
    status: m.status,
    activated,
    canIssueCode: m.status === 'ACTIVE' && !activated && !(state?.otherTenants ?? false),
    lastSeenAt: state?.lastSeenAt ?? null,
    version: m.version,
    createdAt: m.createdAt,
  };
}
