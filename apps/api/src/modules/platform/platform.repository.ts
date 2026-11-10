import { Injectable } from '@nestjs/common';
import type { TenantStatus } from '../../generated/prisma/client.js';
import type { DbClient } from '../../prisma/index.js';

/** A tenant as app_platform_get_tenant returns it (JSON: dates as text). */
export interface PlatformTenantRow {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  statusReason: string | null;
  statusChangedAt: string | null;
  version: number;
  createdAt: string;
  modules: string[];
  companies: { id: string; legalName: string; vatNumber: string; country: string }[];
  admins: {
    membershipId: string;
    userId: string;
    name: string;
    email: string;
    activated: boolean;
    otherTenants: boolean;
    lastSeenAt: string | null;
  }[];
  otherPeople: number;
}

export interface PlatformTenantListRow {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  modules: string[];
  companies: number;
  people: number;
  created_at: Date;
  total: bigint;
}

export interface PlatformEventRow {
  id: string;
  type: string;
  actor_name: string | null;
  subject_type: string | null;
  subject_id: string | null;
  details: Record<string, unknown> | null;
  at: Date;
  total: bigint;
}

type Versioned = { outcome: string; version: number | null };

/** A person as app_platform_find_person returns it (JSON: dates as text). */
export interface PlatformPersonRow {
  userId: string;
  name: string;
  email: string;
  status: 'ACTIVE' | 'DISABLED';
  activated: boolean;
  operator: boolean;
  lastSeenAt: string | null;
  memberships: {
    tenantId: string;
    tenantName: string;
    slug: string;
    tenantStatus: TenantStatus;
    role: string | null;
    customRole: string | null;
  }[];
}

export interface PlatformOperatorRow {
  grant_id: string;
  user_id: string;
  name: string;
  email: string;
  activated: boolean;
  other_tenants: boolean;
  last_seen_at: Date | null;
  granted_at: Date;
  granted_by_name: string | null;
  revoked_at: Date | null;
  revoked_by_name: string | null;
  revoke_reason: string | null;
}

type Code = { hash: string; expiresAt: Date };

/**
 * The platform module's only way to the data (docs/adr/0038): every method calls one
 * app_platform_* function, which checks the operator and touches only what it must. No query here
 * names a table.
 */
@Injectable()
export class PlatformRepository {
  listTenants(
    db: DbClient,
    filter: { search?: string; status?: TenantStatus; take: number; skip: number },
  ) {
    return db.$queryRaw<PlatformTenantListRow[]>`
      SELECT * FROM app_platform_list_tenants(
        ${filter.search ?? null}, ${filter.status ?? null}::tenant_status, ${filter.take}::integer,
        ${filter.skip}::integer)`;
  }

  async getTenant(db: DbClient, id: string): Promise<PlatformTenantRow | null> {
    const [row] = await db.$queryRaw<{ tenant: PlatformTenantRow | null }[]>`
      SELECT app_platform_get_tenant(${id}::uuid) AS tenant`;
    return row?.tenant ?? null;
  }

  listEvents(db: DbClient, tenantId: string, page: { take: number; skip: number }) {
    return db.$queryRaw<PlatformEventRow[]>`
      SELECT * FROM app_platform_tenant_events(
        ${tenantId}::uuid, ${page.take}::integer, ${page.skip}::integer)`;
  }

  async createTenant(
    db: DbClient,
    data: {
      name: string;
      slug: string;
      company: { legalName: string; vatNumber: string; taxCode: string | null; country: string };
      modules: readonly string[];
      admin: { email: string; name: string };
      code: { hash: string; expiresAt: Date };
    },
  ) {
    const [row] = await db.$queryRaw<
      {
        outcome: 'OK' | 'SLUG_EXISTS';
        tenant_id: string | null;
        user_id: string | null;
        identity_created: boolean;
      }[]
    >`SELECT outcome, tenant_id, user_id, identity_created FROM app_platform_create_tenant(
        ${data.name}, ${data.slug},
        ${data.company.legalName}, ${data.company.vatNumber}, ${data.company.taxCode},
        ${data.company.country},
        ${[...data.modules]}::text[],
        ${data.admin.email}, ${data.admin.name}, ${data.code.hash},
        ${data.code.expiresAt}::timestamptz)`;
    return row!;
  }

  async setModules(db: DbClient, id: string, version: number, modules: readonly string[]) {
    const [row] = await db.$queryRaw<Versioned[]>`
      SELECT * FROM app_platform_set_modules(${id}::uuid, ${version}::integer, ${[...modules]}::text[])`;
    return row!;
  }

  async renameTenant(db: DbClient, id: string, version: number, name: string) {
    const [row] = await db.$queryRaw<Versioned[]>`
      SELECT * FROM app_platform_rename_tenant(${id}::uuid, ${version}::integer, ${name})`;
    return row!;
  }

  async setStatus(db: DbClient, id: string, version: number, status: TenantStatus, reason: string) {
    const [row] = await db.$queryRaw<Versioned[]>`
      SELECT * FROM app_platform_set_tenant_status(
        ${id}::uuid, ${version}::integer, ${status}::tenant_status, ${reason})`;
    return row!;
  }

  async addAdmin(
    db: DbClient,
    id: string,
    data: {
      email: string;
      name: string;
      promote: boolean;
      code: { hash: string; expiresAt: Date };
    },
  ) {
    const [row] = await db.$queryRaw<
      {
        outcome: 'ADDED' | 'PROMOTED' | 'NEEDS_PROMOTION' | 'ALREADY_ADMIN' | 'NOT_FOUND';
        user_id: string | null;
        identity_created: boolean;
        member_role: string | null;
      }[]
    >`SELECT outcome, user_id, identity_created, member_role FROM app_platform_add_admin(
        ${id}::uuid, ${data.email}, ${data.name}, ${data.promote}, ${data.code.hash},
        ${data.code.expiresAt}::timestamptz)`;
    return row!;
  }

  async issueAdminCode(
    db: DbClient,
    id: string,
    userId: string,
    code: { hash: string; expiresAt: Date },
  ) {
    const [row] = await db.$queryRaw<
      { outcome: 'OK' | 'NOT_ADMIN' | 'ALREADY_ACTIVATED' | 'OTHER_TENANTS' }[]
    >`SELECT app_platform_issue_admin_code(
        ${id}::uuid, ${userId}::uuid, ${code.hash}, ${code.expiresAt}::timestamptz) AS outcome`;
    return row!.outcome;
  }

  // --- Phase 8b (docs/adr/0039) ----------------------------------------------------------------

  async addCompany(
    db: DbClient,
    tenantId: string,
    company: { legalName: string; vatNumber: string; taxCode: string | null; country: string },
  ) {
    const [row] = await db.$queryRaw<
      { outcome: 'OK' | 'NOT_FOUND' | 'VAT_EXISTS'; company_id: string | null }[]
    >`SELECT * FROM app_platform_add_company(${tenantId}::uuid, ${company.legalName},
        ${company.vatNumber}, ${company.taxCode}, ${company.country})`;
    return row!;
  }

  async findPerson(db: DbClient, email: string): Promise<PlatformPersonRow | null> {
    const [row] = await db.$queryRaw<{ person: PlatformPersonRow | null }[]>`
      SELECT app_platform_find_person(${email}) AS person`;
    return row?.person ?? null;
  }

  async issueRecoveryCode(db: DbClient, userId: string, reason: string, code: Code) {
    const [row] = await db.$queryRaw<
      {
        outcome:
          | 'OK'
          | 'NOT_FOUND'
          | 'REASON_REQUIRED'
          | 'SELF'
          | 'IS_OPERATOR'
          | 'NOT_ACTIVATED'
          | 'NO_MEMBERSHIP';
      }[]
    >`SELECT app_platform_issue_recovery_code(${userId}::uuid, ${reason}, ${code.hash},
        ${code.expiresAt}::timestamptz) AS outcome`;
    return row!.outcome;
  }

  listOperators(db: DbClient) {
    return db.$queryRaw<PlatformOperatorRow[]>`SELECT * FROM app_platform_list_operators()`;
  }

  async grantOperator(
    db: DbClient,
    data: { email: string; name: string | null; confirm: boolean; code: Code },
  ) {
    const [row] = await db.$queryRaw<
      {
        outcome:
          'GRANTED' | 'NAME_REQUIRED' | 'USER_DISABLED' | 'ALREADY_OPERATOR' | 'NEEDS_CONFIRMATION';
        user_id: string | null;
        identity_created: boolean;
        tenants: { name: string; slug: string }[] | null;
      }[]
    >`SELECT * FROM app_platform_grant_operator(${data.email}, ${data.name}, ${data.confirm},
        ${data.code.hash}, ${data.code.expiresAt}::timestamptz)`;
    return row!;
  }

  async revokeOperator(db: DbClient, userId: string, reason: string, closeSessions: boolean) {
    const [row] = await db.$queryRaw<
      { outcome: 'OK' | 'REASON_REQUIRED' | 'SELF' | 'NOT_OPERATOR' | 'LAST_OPERATOR' }[]
    >`SELECT app_platform_revoke_operator(${userId}::uuid, ${reason}, ${closeSessions}) AS outcome`;
    return row!.outcome;
  }

  async issueOperatorCode(db: DbClient, userId: string, code: Code) {
    const [row] = await db.$queryRaw<
      { outcome: 'OK' | 'NOT_OPERATOR' | 'ALREADY_ACTIVATED' | 'OTHER_TENANTS' }[]
    >`SELECT app_platform_issue_operator_code(${userId}::uuid, ${code.hash},
        ${code.expiresAt}::timestamptz) AS outcome`;
    return row!.outcome;
  }
}
