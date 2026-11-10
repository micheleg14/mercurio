import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type TenantStatus } from '../../generated/prisma/client.js';
import { type DbClient, UserDatabase } from '../../prisma/index.js';
import { DomainException } from '../../shared/errors/index.js';
import { type Page, skipAndTake } from '../../shared/pagination.js';
import { editConflict } from '../../shared/versioning.js';
import { escapeLike, normalizeName } from '../../shared/text.js';
import {
  AuthContextService,
  AuthService,
  type RequestMeta,
  type StepUpAction,
} from '../auth/index.js';
import { newActivationCode, normalizeEmail, RECOVERY_CODE_DAYS } from '../identity/index.js';
import {
  applyModuleChange,
  MODULE_CATALOG,
  MODULE_KEYS,
  type ModuleKey,
  parseModuleKeys,
  TenancyService,
} from '../tenancy/index.js';
import type {
  AddAdminDto,
  AddedAdminDto,
  GrantedOperatorDto,
  GrantOperatorDto,
  NewCompanyDto,
  PlatformOperatorDto,
  PlatformPersonDto,
  RecoveryCodeRequestDto,
  RevokeOperatorDto,
  CreatedTenantDto,
  CreateTenantDto,
  PlatformActivationCodeDto,
  PlatformEventDto,
  PlatformModuleDto,
  PlatformTenantDto,
  PlatformTenantsQuery,
  PlatformTenantSummaryDto,
} from './platform.dto.js';
import {
  type PlatformOperatorRow,
  type PlatformPersonRow,
  PlatformRepository,
  type PlatformTenantRow,
} from './platform.repository.js';

const tenantNotFound = () => new DomainException('TENANT_NOT_FOUND', HttpStatus.NOT_FOUND);

/**
 * Use cases of the platform operator (docs/adr/0038). Each runs in the context of the person
 * only (no tenant), whatever tenant the session has chosen, and reaches the data through the
 * app_platform_* functions. The rules are those of tenancy and identity, applied here before the
 * call: the functions recheck only the boundary.
 */
@Injectable()
export class PlatformService {
  constructor(
    private readonly contexts: AuthContextService,
    private readonly users: UserDatabase,
    private readonly repository: PlatformRepository,
    private readonly tenancy: TenancyService,
    private readonly auth: AuthService,
  ) {}

  /** The module catalog with its dependencies both ways, in catalog order. */
  modules(): PlatformModuleDto[] {
    return MODULE_KEYS.map((key) => ({
      key,
      requires: [...MODULE_CATALOG[key].requires],
      requiredBy: MODULE_KEYS.filter((other) =>
        (MODULE_CATALOG[other].requires as readonly string[]).includes(key),
      ),
      alwaysOn: MODULE_CATALOG[key].alwaysOn,
    }));
  }

  async list(query: PlatformTenantsQuery): Promise<Page<PlatformTenantSummaryDto>> {
    const { skip, take } = skipAndTake(query);
    const search = query.q?.trim();
    const rows = await this.run((tx) =>
      this.repository.listTenants(tx, {
        search: search ? escapeLike(search) : undefined,
        status: query.status,
        skip,
        take,
      }),
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        status: r.status,
        modules: sortModules(r.modules),
        companies: r.companies,
        people: r.people,
        createdAt: r.created_at.toISOString(),
      })),
      total: Number(rows[0]?.total ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  get(id: string): Promise<PlatformTenantDto> {
    return this.run((tx) => this.requireTenant(tx, id));
  }

  async events(id: string, page: { page: number; pageSize: number }) {
    const rows = await this.run(async (tx) => {
      await this.requireTenant(tx, id);
      return this.repository.listEvents(tx, id, skipAndTake(page));
    });
    return {
      items: rows.map((e): PlatformEventDto => ({
        id: e.id,
        type: e.type,
        actorName: e.actor_name,
        subjectType: e.subject_type,
        subjectId: e.subject_id,
        details: e.details,
        at: e.at.toISOString(),
      })),
      total: Number(rows[0]?.total ?? 0),
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  /** A new tenant with its first company, modules and administrator, in one transaction. */
  async create(dto: CreateTenantDto): Promise<CreatedTenantDto> {
    const tenant = this.tenancy.prepareTenant(dto);
    const admin = { email: normalizeEmail(dto.admin.email), name: normalizeName(dto.admin.name) };
    // Made before knowing whether it is needed: the function keeps it only for a new identity.
    const activation = newActivationCode();
    return this.run(async (tx) => {
      const created = await this.withDisabledUser(() =>
        this.repository.createTenant(tx, {
          ...tenant,
          company: { ...tenant.company, taxCode: tenant.company.taxCode ?? null },
          admin,
          code: { hash: activation.hash, expiresAt: activation.expiresAt },
        }),
      );
      if (created.outcome === 'SLUG_EXISTS') {
        throw new DomainException('TENANT_SLUG_EXISTS', HttpStatus.CONFLICT, {
          detail: tenant.slug,
          errors: [{ field: 'slug', code: 'TENANT_SLUG_EXISTS' }],
        });
      }
      return {
        tenant: await this.requireTenant(tx, created.tenant_id!),
        activation: created.identity_created ? codeDto(activation) : null,
        existingAccount: !created.identity_created,
      };
    });
  }

  /** The modules the tenant must have afterwards, checked with their dependencies. */
  setModules(id: string, version: number, wanted: readonly string[]): Promise<PlatformTenantDto> {
    const keys = parseModuleKeys(wanted);
    return this.run(async (tx) => {
      const current = await this.requireTenant(tx, id);
      const have = current.modules as ModuleKey[];
      const modules = applyModuleChange(have, {
        enable: keys.filter((k) => !have.includes(k)),
        disable: have.filter((k) => !keys.includes(k)),
      });
      versioned(await this.repository.setModules(tx, id, version, modules));
      return this.requireTenant(tx, id);
    });
  }

  rename(id: string, version: number, name: string): Promise<PlatformTenantDto> {
    const normalized = this.tenancy.normalizeTenantName(name);
    return this.run(async (tx) => {
      versioned(await this.repository.renameTenant(tx, id, version, normalized));
      return this.requireTenant(tx, id);
    });
  }

  setStatus(
    id: string,
    status: TenantStatus,
    version: number,
    reason: string,
  ): Promise<PlatformTenantDto> {
    return this.run(async (tx) => {
      versioned(await this.repository.setStatus(tx, id, version, status, reason));
      return this.requireTenant(tx, id);
    });
  }

  /** An administrator for a tenant: a new identity gets a code, a known one keeps its account. */
  async addAdmin(id: string, dto: AddAdminDto): Promise<AddedAdminDto> {
    const email = normalizeEmail(dto.email);
    const name = normalizeName(dto.name);
    const activation = newActivationCode();
    return this.run(async (tx) => {
      const added = await this.withDisabledUser(() =>
        this.repository.addAdmin(tx, id, {
          email,
          name,
          promote: dto.promote === true,
          code: { hash: activation.hash, expiresAt: activation.expiresAt },
        }),
      );
      switch (added.outcome) {
        case 'NOT_FOUND':
          throw tenantNotFound();
        case 'ALREADY_ADMIN':
          throw new DomainException('ALREADY_ADMIN', HttpStatus.CONFLICT, {
            errors: [{ field: 'email', code: 'ALREADY_ADMIN' }],
          });
        case 'NEEDS_PROMOTION':
          // The interface asks for confirmation, showing the current role, and sends promote.
          throw new DomainException('ADMIN_PROMOTION_REQUIRED', HttpStatus.CONFLICT, {
            detail: added.member_role ?? undefined,
          });
      }
      return {
        tenant: await this.requireTenant(tx, id),
        activation: added.identity_created ? codeDto(activation) : null,
        existingAccount: !added.identity_created,
        promoted: added.outcome === 'PROMOTED',
      };
    });
  }

  /** A new code for an administrator who has not activated their account (docs/adr/0037). */
  async issueAdminCode(id: string, userId: string): Promise<PlatformActivationCodeDto> {
    const activation = newActivationCode();
    const outcome = await this.run(async (tx) => {
      await this.requireTenant(tx, id);
      return this.repository.issueAdminCode(tx, id, userId, activation);
    });
    if (outcome === 'NOT_ADMIN') {
      throw new DomainException('MEMBERSHIP_NOT_FOUND', HttpStatus.NOT_FOUND);
    }
    if (outcome !== 'OK') {
      throw new DomainException('ACTIVATION_NOT_ALLOWED', HttpStatus.CONFLICT, { detail: outcome });
    }
    return codeDto(activation);
  }

  // --- Phase 8b (docs/adr/0039) ----------------------------------------------------------------

  /**
   * A further company, with the rules of the tenant administrator. The tenant version does not
   * change; sending it twice finds the VAT number taken and adds nothing.
   */
  addCompany(id: string, dto: NewCompanyDto): Promise<PlatformTenantDto> {
    const company = this.tenancy.prepareCompany(dto);
    return this.run(async (tx) => {
      const added = await this.repository.addCompany(tx, id, {
        ...company,
        taxCode: company.taxCode ?? null,
      });
      if (added.outcome === 'NOT_FOUND') throw tenantNotFound();
      if (added.outcome === 'VAT_EXISTS') {
        throw new DomainException('COMPANY_VAT_TAKEN', HttpStatus.CONFLICT, {
          errors: [{ field: 'vatNumber', code: 'COMPANY_VAT_TAKEN' }],
        });
      }
      return this.requireTenant(tx, id);
    });
  }

  /** The person with exactly this email, and whether a recovery can be issued for them. */
  async findPerson(email: string): Promise<PlatformPersonDto> {
    const self = this.contexts.require().userId;
    const row = await this.run((tx) => this.repository.findPerson(tx, email));
    if (!row) throw new DomainException('PERSON_NOT_FOUND', HttpStatus.NOT_FOUND);
    return toPersonDto(row, self);
  }

  /**
   * A recovery code for an activated account, after a fresh one-time code of the operator. The
   * person's sessions close now; the code lasts a day and is shown once.
   */
  issueRecoveryCode(
    userId: string,
    dto: RecoveryCodeRequestDto,
    meta: RequestMeta,
  ): Promise<PlatformActivationCodeDto> {
    const activation = newActivationCode(new Date(), RECOVERY_CODE_DAYS);
    return this.withStepUp(dto.totpCode, 'ACCOUNT_RECOVERY', meta, async (tx) => {
      const outcome = await this.repository.issueRecoveryCode(tx, userId, dto.reason, activation);
      switch (outcome) {
        case 'OK':
          return codeDto(activation);
        case 'NOT_FOUND':
          throw new DomainException('PERSON_NOT_FOUND', HttpStatus.NOT_FOUND);
        case 'REASON_REQUIRED':
          throw reasonRequired();
        default:
          throw new DomainException('RECOVERY_NOT_ALLOWED', HttpStatus.CONFLICT, {
            detail: outcome,
          });
      }
    });
  }

  async listOperators(): Promise<PlatformOperatorDto[]> {
    const self = this.contexts.require().userId;
    const rows = await this.run((tx) => this.repository.listOperators(tx));
    return rows.map((r) => toOperatorDto(r, self));
  }

  /** A new operator: a new identity gets a code, a known one keeps its account. */
  grantOperator(dto: GrantOperatorDto, meta: RequestMeta): Promise<GrantedOperatorDto> {
    const email = normalizeEmail(dto.email);
    const name = dto.name?.trim() ? normalizeName(dto.name) : null;
    const activation = newActivationCode();
    return this.withStepUp(dto.totpCode, 'OPERATOR_GRANT', meta, async (tx) => {
      const granted = await this.repository.grantOperator(tx, {
        email,
        name,
        confirm: dto.confirmExisting === true,
        code: activation,
      });
      switch (granted.outcome) {
        case 'NAME_REQUIRED':
          throw new DomainException('INVALID_NAME', HttpStatus.BAD_REQUEST, {
            errors: [{ field: 'name', code: 'REQUIRED' }],
          });
        case 'USER_DISABLED':
          throw new DomainException('USER_DISABLED', HttpStatus.CONFLICT, {
            errors: [{ field: 'email', code: 'USER_DISABLED' }],
          });
        case 'ALREADY_OPERATOR':
          throw new DomainException('OPERATOR_ALREADY', HttpStatus.CONFLICT, {
            errors: [{ field: 'email', code: 'OPERATOR_ALREADY' }],
          });
        case 'NEEDS_CONFIRMATION':
          // The interface lists the tenants, asks for confirmation and sends confirmExisting.
          throw new DomainException('OPERATOR_EXISTING_MEMBER', HttpStatus.CONFLICT, {
            detail: (granted.tenants ?? []).map((t) => t.name).join(', '),
          });
      }
      return {
        userId: granted.user_id!,
        activation: granted.identity_created ? codeDto(activation) : null,
        existingAccount: !granted.identity_created,
      };
    });
  }

  /** Revokes another operator, effective at their next request. */
  async revokeOperator(userId: string, dto: RevokeOperatorDto, meta: RequestMeta): Promise<void> {
    await this.withStepUp(dto.totpCode, 'OPERATOR_REVOKE', meta, async (tx) => {
      const outcome = await this.repository.revokeOperator(
        tx,
        userId,
        dto.reason,
        dto.closeSessions === true,
      );
      switch (outcome) {
        case 'OK':
          return;
        case 'REASON_REQUIRED':
          throw reasonRequired();
        case 'SELF':
          throw new DomainException('OPERATOR_SELF_REVOKE', HttpStatus.CONFLICT);
        case 'NOT_OPERATOR':
          throw new DomainException('NOT_AN_OPERATOR', HttpStatus.NOT_FOUND);
        case 'LAST_OPERATOR':
          throw new DomainException('LAST_OPERATOR', HttpStatus.CONFLICT);
      }
    });
  }

  /** A new activation code for an operator who has not activated their account. */
  async issueOperatorCode(userId: string): Promise<PlatformActivationCodeDto> {
    const activation = newActivationCode();
    const outcome = await this.run((tx) =>
      this.repository.issueOperatorCode(tx, userId, activation),
    );
    if (outcome === 'NOT_OPERATOR') {
      throw new DomainException('NOT_AN_OPERATOR', HttpStatus.NOT_FOUND);
    }
    if (outcome !== 'OK') {
      throw new DomainException('ACTIVATION_NOT_ALLOWED', HttpStatus.CONFLICT, { detail: outcome });
    }
    return codeDto(activation);
  }

  // ---------------------------------------------------------------------------------------------

  /**
   * Runs an action that cannot be undone after checking a fresh one-time code of the operator,
   * in one transaction: an action refused by its function gives the code back (rollback), while
   * a wrong code is committed as a failure before answering 403 (never 401, which the interface
   * reads as an expired session).
   */
  private async withStepUp<T>(
    code: string | undefined,
    action: StepUpAction,
    meta: RequestMeta,
    work: (tx: DbClient) => Promise<T>,
  ): Promise<T> {
    if (!code?.trim()) throw invalidTotp();
    const userId = this.contexts.require().userId;
    const result = await this.run(async (tx) => {
      const check = await this.auth.verifyStepUp(tx, userId, code, action, meta);
      if (check !== 'OK') return { check };
      return { check, value: await work(tx) };
    });
    if (result.check === 'LOCKED') {
      throw new DomainException('ACCOUNT_LOCKED', HttpStatus.FORBIDDEN);
    }
    if (result.check === 'INVALID') throw invalidTotp();
    return (result as { value: T }).value;
  }

  /** The context of the person only: no tenant, whatever the session has chosen. */
  private run<T>(work: (tx: DbClient) => Promise<T>): Promise<T> {
    return this.users.runAs(this.contexts.require().userId, work);
  }

  private async requireTenant(tx: DbClient, id: string): Promise<PlatformTenantDto> {
    const row = await this.repository.getTenant(tx, id);
    if (!row) throw tenantNotFound();
    return toTenantDto(row);
  }

  /** A disabled identity is refused inside the function (it undoes everything): say so. */
  private async withDisabledUser<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.message.includes('USER_DISABLED')
      ) {
        throw new DomainException('USER_DISABLED', HttpStatus.CONFLICT, {
          errors: [{ field: 'email', code: 'USER_DISABLED' }],
        });
      }
      throw error;
    }
  }
}

const invalidTotp = () =>
  new DomainException('INVALID_TOTP_CODE', HttpStatus.FORBIDDEN, {
    errors: [{ field: 'totpCode', code: 'INVALID_TOTP_CODE' }],
  });

const reasonRequired = () =>
  new DomainException('STATUS_REASON_REQUIRED', HttpStatus.BAD_REQUEST, {
    errors: [{ field: 'reason', code: 'REQUIRED' }],
  });

function versioned(result: { outcome: string }): void {
  switch (result.outcome) {
    case 'OK':
      return;
    case 'NOT_FOUND':
      throw tenantNotFound();
    case 'EDIT_CONFLICT':
      throw editConflict();
    case 'REASON_REQUIRED':
      throw new DomainException('STATUS_REASON_REQUIRED', HttpStatus.BAD_REQUEST, {
        errors: [{ field: 'reason', code: 'REQUIRED' }],
      });
    case 'STATUS_UNCHANGED':
      throw new DomainException('TENANT_STATUS_UNCHANGED', HttpStatus.CONFLICT);
    default:
      throw new Error(`Unexpected outcome ${result.outcome}`);
  }
}

/** Modules in catalog order, as everywhere in the interface. */
function sortModules(modules: readonly string[]): string[] {
  return MODULE_KEYS.filter((key) => modules.includes(key));
}

function codeDto(activation: { code: string; expiresAt: Date }): PlatformActivationCodeDto {
  return { code: activation.code, expiresAt: activation.expiresAt.toISOString() };
}

const iso = (value: string | null) => (value ? new Date(value).toISOString() : null);

function toTenantDto(row: PlatformTenantRow): PlatformTenantDto {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    statusReason: row.statusReason,
    statusChangedAt: iso(row.statusChangedAt),
    version: row.version,
    createdAt: iso(row.createdAt)!,
    modules: sortModules(row.modules),
    companies: row.companies,
    admins: row.admins.map((a) => ({
      membershipId: a.membershipId,
      userId: a.userId,
      name: a.name,
      email: a.email,
      activated: a.activated,
      canIssueCode: !a.activated && !a.otherTenants,
      lastSeenAt: iso(a.lastSeenAt),
    })),
    otherPeople: row.otherPeople,
  };
}

function toPersonDto(row: PlatformPersonRow, self: string): PlatformPersonDto {
  const isSelf = row.userId === self;
  // The same order as app_platform_issue_recovery_code, so the interface says what it would.
  const recoveryBlocked =
    row.status !== 'ACTIVE'
      ? 'DISABLED'
      : isSelf
        ? 'SELF'
        : row.operator
          ? 'IS_OPERATOR'
          : !row.activated
            ? 'NOT_ACTIVATED'
            : row.memberships.length === 0
              ? 'NO_MEMBERSHIP'
              : null;
  return {
    userId: row.userId,
    name: row.name,
    email: row.email,
    status: row.status,
    activated: row.activated,
    operator: row.operator,
    self: isSelf,
    lastSeenAt: iso(row.lastSeenAt),
    memberships: row.memberships.map((m) => ({
      tenantId: m.tenantId,
      tenantName: m.tenantName,
      slug: m.slug,
      tenantStatus: m.tenantStatus,
      role: m.role,
      customRole: m.customRole,
    })),
    recoveryBlocked,
  };
}

function toOperatorDto(row: PlatformOperatorRow, self: string): PlatformOperatorDto {
  return {
    grantId: row.grant_id,
    userId: row.user_id,
    name: row.name,
    email: row.email,
    activated: row.activated,
    canIssueCode: !row.revoked_at && !row.activated && !row.other_tenants,
    self: row.user_id === self,
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    grantedAt: row.granted_at.toISOString(),
    grantedByName: row.granted_by_name,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    revokedByName: row.revoked_by_name,
    revokeReason: row.revoke_reason,
  };
}
