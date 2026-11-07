import { HttpStatus, Injectable } from '@nestjs/common';
import type { Company } from '../../generated/prisma/client.js';
import type { DbClient } from '../../prisma/index.js';
import { DomainException } from '../../shared/errors/index.js';
import { normalizeName } from '../../shared/text.js';
import { changedFields, definedOnly, editConflict } from '../../shared/versioning.js';
import { normalizeCountry, normalizeTaxCode, normalizeVatNumber } from './company-identifiers.js';
import { type CompanyProfileInput, normalizeCompanyProfile, profileOf } from './company-profile.js';
import { applyModuleChange, type ModuleKey, parseModuleKeys } from './module-catalog.js';
import { TenancyRepository } from './tenancy.repository.js';
import { normalizeSlug } from './tenant-slug.js';

export interface CompanyInput {
  legalName: string;
  vatNumber: string;
  taxCode?: string;
  country?: string;
}

export interface NewTenantInput {
  name: string;
  slug: string;
  modules: readonly string[];
  company: CompanyInput;
}

/**
 * Public service of the tenancy module (B3): tenants, their companies and enabled modules.
 * Methods take the database client so a caller can combine several modules in one transaction.
 */
@Injectable()
export class TenancyService {
  constructor(private readonly repository: TenancyRepository) {}

  /**
   * The data of a new tenant, checked and normalized, without writing anything: name, slug, first
   * company and modules (registry always added, dependencies required). The terminal writes it
   * with createTenant, the platform operator through the database (docs/adr/0038): same rules.
   */
  prepareTenant(input: NewTenantInput) {
    return {
      name: normalizeName(input.name),
      slug: normalizeSlug(input.slug),
      company: this.normalizeCompany(input.company),
      modules: applyModuleChange([], { enable: parseModuleKeys(input.modules) }),
    };
  }

  /** A tenant name as it is stored (the platform operator renames tenants). */
  normalizeTenantName(name: string): string {
    return normalizeName(name);
  }

  /** A new tenant with its first company and the chosen modules (registry is always added). */
  async createTenant(db: DbClient, input: NewTenantInput) {
    const { modules, company, ...names } = this.prepareTenant(input);
    const tenant = await this.repository.createTenant(db, names);
    const created = await this.repository.createCompany(db, { tenantId: tenant.id, ...company });
    await this.repository.replaceModules(db, tenant.id, modules);
    return { tenant, company: created, modules };
  }

  async addCompany(db: DbClient, tenantSlug: string, input: CompanyInput) {
    const tenant = await this.requireTenant(db, tenantSlug);
    return this.repository.createCompany(db, {
      tenantId: tenant.id,
      ...this.normalizeCompany(input),
    });
  }

  /**
   * A company added from the interface, with the id the client chose (B33): sending the same
   * company again returns it instead of failing, a different one with that id is refused.
   */
  async addCompanyToTenant(
    db: DbClient,
    tenantId: string,
    input: CompanyInput & { id: string },
  ): Promise<{ company: Company; created: boolean }> {
    const data = this.normalizeCompany(input);
    const existing = await this.repository.findCompany(db, input.id);
    if (existing) {
      const same =
        existing.tenantId === tenantId &&
        existing.legalName === data.legalName &&
        existing.vatNumber === data.vatNumber &&
        (existing.taxCode ?? undefined) === (data.taxCode ?? undefined) &&
        existing.country === data.country;
      if (!same) throw new DomainException('COMPANY_ID_REUSED', HttpStatus.CONFLICT);
      return { company: existing, created: false };
    }
    const company = await this.repository.createCompany(db, { id: input.id, tenantId, ...data });
    return { company, created: true };
  }

  /** Enables and disables modules, refusing any result that breaks a dependency. */
  async setModules(
    db: DbClient,
    tenantSlug: string,
    change: { enable?: readonly string[]; disable?: readonly string[] },
  ): Promise<ModuleKey[]> {
    const tenant = await this.requireTenant(db, tenantSlug);
    const current = await this.repository.listModules(db, tenant.id);
    const modules = applyModuleChange(current, {
      enable: parseModuleKeys(change.enable ?? []),
      disable: parseModuleKeys(change.disable ?? []),
    });
    await this.repository.replaceModules(db, tenant.id, modules);
    return modules;
  }

  enabledModules(db: DbClient, tenantId: string): Promise<ModuleKey[]> {
    return this.repository.listModules(db, tenantId);
  }

  /** A tenant by its slug, or null. */
  findTenantBySlug(db: DbClient, slug: string) {
    return this.repository.findTenantBySlug(db, normalizeSlug(slug));
  }

  async requireTenant(db: DbClient, slug: string) {
    const tenant = await this.repository.findTenantBySlug(db, normalizeSlug(slug));
    if (!tenant)
      throw new DomainException('TENANT_NOT_FOUND', HttpStatus.NOT_FOUND, { detail: slug });
    return tenant;
  }

  /** Fails unless every id is a company of the tenant: never link across tenants. */
  async assertCompaniesInTenant(db: DbClient, tenantId: string, ids: readonly string[]) {
    const unique = [...new Set(ids)];
    if ((await this.repository.countCompanies(db, tenantId, unique)) !== unique.length) {
      throw new DomainException('COMPANY_NOT_IN_TENANT', HttpStatus.BAD_REQUEST);
    }
  }

  /**
   * Ids of the tenant's companies with these VAT numbers (how people name companies in
   * commands). Fails if any is not a company of this tenant.
   */
  async companyIdsByVat(db: DbClient, tenantId: string, vatNumbers: readonly string[]) {
    const wanted = [...new Set(vatNumbers.map((vat) => vat.replace(/\s+/g, '').toUpperCase()))];
    // Italian numbers are stored without the IT prefix.
    const normalized = wanted.map((vat) => (/^IT\d{11}$/.test(vat) ? vat.slice(2) : vat));
    const found = await this.repository.findCompaniesByVat(db, tenantId, normalized);
    if (found.length !== normalized.length) {
      const missing = normalized.filter((vat) => !found.some((c) => c.vatNumber === vat));
      throw new DomainException('COMPANY_NOT_IN_TENANT', HttpStatus.BAD_REQUEST, {
        detail: missing.join(', '),
      });
    }
    return found.map((company) => company.id);
  }

  /** A tenant by id, or null. Inside a request, Row-Level Security shows only permitted tenants. */
  findTenant(db: DbClient, id: string) {
    return this.repository.findTenantById(db, id);
  }

  /** Name and status of the given tenants, for the "choose a tenant" step. */
  tenantsByIds(db: DbClient, ids: readonly string[]) {
    return this.repository.findTenantsByIds(db, ids);
  }

  /** Companies of a tenant, by name. */
  listCompanies(db: DbClient, tenantId: string) {
    return this.repository.listCompanies(db, tenantId);
  }

  /** A company of the current tenant (Row-Level Security), or a 404. */
  async getCompany(db: DbClient, companyId: string) {
    const company = await this.repository.findCompany(db, companyId);
    if (!company) throw new DomainException('COMPANY_NOT_FOUND', HttpStatus.NOT_FOUND);
    return company;
  }

  /**
   * Changes the invoice header data of a company (not its name or identifiers), at the version
   * it was read (B29). Only the fields sent change; returns the company and the names of the
   * changed fields, for the audit log.
   */
  async updateCompanyProfile(
    db: DbClient,
    companyId: string,
    version: number,
    changes: CompanyProfileInput,
  ) {
    const current = await this.getCompany(db, companyId);
    if (current.version !== version) throw editConflict();
    const before = profileOf(current);
    const after = normalizeCompanyProfile(current.country, { ...before, ...definedOnly(changes) });
    const fields = changedFields(before, after);
    if (fields.length === 0) return { company: current, fields };
    const updated = await this.repository.updateCompanyAtVersion(db, companyId, version, after);
    if (!updated) throw editConflict();
    return { company: updated, fields };
  }

  listTenants(db: DbClient) {
    return this.repository.listTenants(db);
  }

  private normalizeCompany(input: CompanyInput) {
    const country = normalizeCountry(input.country);
    return {
      legalName: normalizeName(input.legalName, 'INVALID_COMPANY_NAME'),
      vatNumber: normalizeVatNumber(country, input.vatNumber),
      taxCode: normalizeTaxCode(input.taxCode),
      country,
    };
  }
}
