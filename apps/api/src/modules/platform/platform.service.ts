import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type TenantStatus } from '../../generated/prisma/client.js';
import { type DbClient, UserDatabase } from '../../prisma/index.js';
import { DomainException } from '../../shared/errors/index.js';
import { type Page, skipAndTake } from '../../shared/pagination.js';
import { editConflict } from '../../shared/versioning.js';
import { escapeLike, normalizeName } from '../../shared/text.js';
import { AuthContextService } from '../auth/index.js';
import { newActivationCode, normalizeEmail } from '../identity/index.js';
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
  CreatedTenantDto,
  CreateTenantDto,
  PlatformActivationCodeDto,
  PlatformEventDto,
  PlatformModuleDto,
  PlatformTenantDto,
  PlatformTenantsQuery,
  PlatformTenantSummaryDto,
} from './platform.dto.js';
import { PlatformRepository, type PlatformTenantRow } from './platform.repository.js';

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

  // ---------------------------------------------------------------------------------------------

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
