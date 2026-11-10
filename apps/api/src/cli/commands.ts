import { HttpStatus, type INestApplicationContext } from '@nestjs/common';
import type { ParseArgsOptionsConfig } from 'node:util';
import { AuditService } from '../modules/audit/index.js';
import { AuthService } from '../modules/auth/index.js';
import { IdentityService } from '../modules/identity/index.js';
import { InvoicingService } from '../modules/invoicing/index.js';
import { RegistryService } from '../modules/registry/index.js';
import { MODULE_KEYS, TenancyService } from '../modules/tenancy/index.js';
import { OrdersService } from '../modules/orders/index.js';
import { WarehouseService } from '../modules/warehouse/index.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from '../prisma/index.js';
import { DomainException } from '../shared/errors/index.js';
import { isCalendarDate } from '../shared/dates.js';
import { keptMembers, resetDemo } from './demo-reset.js';
import {
  DEMO_OPERATOR,
  DEMO_PASSWORD,
  DEMO_SLUGS,
  DEMO_TOTP_SECRET,
  type SeedSummary,
  seedDemo,
} from './seed-demo.js';

/** Where a command writes: human-readable lines, and one audit event per completed command. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** Structured record of what was done. Never contains activation codes. */
  audit(event: Record<string, unknown>): void;
}

/** Option values; boolean flags arrive as 'true' (see runCli). */
type Values = Record<string, string | undefined>;

interface Services {
  config: AppConfig;
  prisma: PrismaService;
  tenancy: TenancyService;
  identity: IdentityService;
  audit: AuditService;
  auth: AuthService;
  registry: RegistryService;
  warehouse: WarehouseService;
  orders: OrdersService;
  invoicing: InvoicingService;
}

export interface Command {
  summary: string;
  options: ParseArgsOptionsConfig;
  required: string[];
  run(services: Services, values: Values, io: CliIo): Promise<void>;
}

const text = { type: 'string' } as const;

/** The demo seed is one transaction: everything or nothing, however long it takes. */
export const SEED_TRANSACTION = { timeout: 300_000 } as const;
/** Deleting the demo and writing it again: one transaction, so a failure keeps the old data. */
const RESET_TRANSACTION = { timeout: 600_000 } as const;

/** "a, b,c" → ["a", "b", "c"] */
function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** The demo goes into production only on purpose. */
function assertDemoAllowed(config: AppConfig, v: Values): void {
  if (config.isProduction && v['allow-production'] !== 'true') {
    throw new DomainException('DEMO_IN_PRODUCTION', HttpStatus.CONFLICT, {
      detail: 'add --allow-production to write demo data in a production database on purpose',
    });
  }
}

/** --today: the last day of the demo's history, YYYY-MM-DD (default today). */
function demoToday(v: Values): string | undefined {
  const today = v.today;
  if (today !== undefined && !isCalendarDate(today)) {
    throw new DomainException('VALIDATION_FAILED', HttpStatus.BAD_REQUEST, {
      detail: '--today must be a date, YYYY-MM-DD',
    });
  }
  return today;
}

function demoServices(s: Services) {
  const { tenancy, identity, registry, warehouse, orders, invoicing } = s;
  return { tenancy, identity, registry, warehouse, orders, invoicing };
}

/** Outside production the demo people can sign in; in production they activate with a code. */
async function demoCredentials(
  s: Services,
  tx: Parameters<AuthService['setDemoCredentials']>[0],
  userIds: readonly string[],
) {
  if (s.config.isProduction) return;
  for (const userId of userIds) {
    await s.auth.setDemoCredentials(tx, userId, {
      password: DEMO_PASSWORD,
      totpSecret: DEMO_TOTP_SECRET,
    });
  }
}

/** Outside production, the demo has a platform operator with the demo credentials too. */
async function demoOperator(s: Services, tx: Parameters<AuthService['setDemoCredentials']>[0]) {
  if (s.config.isProduction) return false;
  const operator = await s.identity.ensurePlatformOperator(tx, DEMO_OPERATOR);
  if (operator.granted) {
    await s.audit.recordAuthEvent(tx, {
      userId: operator.userId,
      type: 'OPERATOR_GRANTED',
      details: { by: 'seed-demo' },
    });
  }
  await s.auth.setDemoCredentials(tx, operator.userId, {
    password: DEMO_PASSWORD,
    totpSecret: DEMO_TOTP_SECRET,
  });
  return true;
}

function printDemo(
  io: CliIo,
  production: boolean,
  result: { tenants: SeedSummary[]; userIds: string[]; today: string; missing: readonly string[] },
) {
  for (const tenant of result.tenants) {
    if (!tenant.created) {
      io.out(
        `Demo tenant ${tenant.slug}: already present, left as it is (reset-demo starts again)`,
      );
      continue;
    }
    io.out(
      `Demo tenant ${tenant.slug}: ${tenant.companies} companies, ${tenant.members} people, ` +
        `${tenant.parties} parties, ${tenant.items} items; history up to ${result.today}: ` +
        `${tenant.documents} stock documents, ${tenant.orders} orders, ${tenant.invoices} invoices and credit notes`,
    );
  }
  if (result.missing.length > 0) {
    io.out(`Not shown by this history: ${result.missing.join(', ')}`);
  }
  if (result.userIds.length === 0) return;
  if (production) {
    io.out('Fictitious data. No credentials were created: people activate with a code.');
  } else {
    io.out(`Fictitious data. Every demo person signs in with the password ${DEMO_PASSWORD}`);
    io.out(`and the authenticator secret ${DEMO_TOTP_SECRET} (add it to any authenticator app).`);
    io.out(`The platform operator ${DEMO_OPERATOR.email} signs in the same way.`);
  }
}

function printActivation(io: CliIo, activation: { code: string; expiresAt: Date }, email: string) {
  io.out('');
  io.out(`Activation code for ${email} (valid until ${activation.expiresAt.toISOString()}):`);
  io.out(`  ${activation.code}`);
  io.out('Shown only once and stored only as a hash: hand it over privately.');
}

export const COMMANDS: Record<string, Command> = {
  'create-tenant': {
    summary: 'Create a tenant with its first company, modules and administrator',
    options: {
      name: text,
      slug: text,
      modules: text,
      'company-name': text,
      vat: text,
      'tax-code': text,
      country: text,
      'admin-email': text,
      'admin-name': text,
    },
    required: ['name', 'slug', 'modules', 'company-name', 'vat', 'admin-email', 'admin-name'],
    async run({ prisma, tenancy, identity, audit }, v, io) {
      // One transaction across both modules: the tenant exists with its admin, or not at all.
      const { created, admin } = await prisma.$transaction(async (tx) => {
        const created = await tenancy.createTenant(tx, {
          name: v.name!,
          slug: v.slug!,
          modules: list(v.modules),
          company: {
            legalName: v['company-name']!,
            vatNumber: v.vat!,
            taxCode: v['tax-code'],
            country: v.country,
          },
        });
        const admin = await identity.addMember(tx, {
          tenantId: created.tenant.id,
          email: v['admin-email']!,
          name: v['admin-name']!,
          role: 'ADMIN',
          companies: 'all',
        });
        // A new identity gets its code here, as the owner role: the same path as issue-code.
        const activation = admin.identityCreated
          ? await identity.issueActivationCode(tx, admin.userId)
          : undefined;
        // The audit events are part of the same transaction: no change without its record.
        await audit.recordTenantEvent(tx, {
          tenantId: created.tenant.id,
          source: 'CLI',
          type: 'TENANT_CREATED',
          subject: { type: 'tenant', id: created.tenant.id },
          details: { slug: created.tenant.slug, modules: created.modules },
        });
        await audit.recordTenantEvent(tx, {
          tenantId: created.tenant.id,
          source: 'CLI',
          type: 'MEMBER_ADDED',
          subject: { type: 'membership', id: admin.membershipId },
          details: { email: admin.email, role: 'ADMIN' },
        });
        return { created, admin: { ...admin, activation } };
      });

      io.out(`Tenant ${created.tenant.slug} created: ${created.tenant.name}`);
      io.out(`  company: ${created.company.legalName} (VAT ${created.company.vatNumber})`);
      io.out(`  modules: ${created.modules.join(', ')}`);
      io.out(
        `  admin:   ${admin.email}${admin.identityCreated ? '' : ' (existing identity, no new code)'}`,
      );
      if (admin.activation) printActivation(io, admin.activation, admin.email);
      io.audit({
        command: 'create-tenant',
        tenant: created.tenant.slug,
        modules: created.modules,
        admin: admin.email,
      });
    },
  },

  'add-company': {
    summary: 'Add a company to a tenant',
    options: { tenant: text, name: text, vat: text, 'tax-code': text, country: text },
    required: ['tenant', 'name', 'vat'],
    async run({ prisma, tenancy, audit }, v, io) {
      const company = await prisma.$transaction(async (tx) => {
        const tenant = await tenancy.requireTenant(tx, v.tenant!);
        const added = await tenancy.addCompany(tx, v.tenant!, {
          legalName: v.name!,
          vatNumber: v.vat!,
          taxCode: v['tax-code'],
          country: v.country,
        });
        await audit.recordTenantEvent(tx, {
          tenantId: tenant.id,
          source: 'CLI',
          type: 'COMPANY_ADDED',
          subject: { type: 'company', id: added.id },
          details: { vatNumber: added.vatNumber },
        });
        return added;
      });
      io.out(`Company ${company.legalName} (VAT ${company.vatNumber}) added to ${v.tenant}`);
      io.audit({ command: 'add-company', tenant: v.tenant, vat: company.vatNumber });
    },
  },

  'add-user': {
    summary: 'Add a person to a tenant (reusing their identity if it exists)',
    options: { tenant: text, email: text, name: text, role: text, companies: text },
    required: ['tenant', 'email', 'name', 'role', 'companies'],
    async run({ prisma, tenancy, identity, audit }, v, io) {
      const added = await prisma.$transaction(async (tx) => {
        const tenant = await tenancy.requireTenant(tx, v.tenant!);
        const companies =
          v.companies === 'all'
            ? 'all'
            : await tenancy.companyIdsByVat(tx, tenant.id, list(v.companies));
        const member = await identity.addMember(tx, {
          tenantId: tenant.id,
          email: v.email!,
          name: v.name!,
          role: v.role!,
          companies,
        });
        await audit.recordTenantEvent(tx, {
          tenantId: tenant.id,
          source: 'CLI',
          type: 'MEMBER_ADDED',
          subject: { type: 'membership', id: member.membershipId },
          details: { email: member.email, role: member.role },
        });
        const activation = member.identityCreated
          ? await identity.issueActivationCode(tx, member.userId)
          : undefined;
        return { ...member, activation };
      });
      const how = added.reactivated ? 'reactivated in' : 'added to';
      io.out(`${added.email} ${how} ${v.tenant} as ${added.role}`);
      if (!added.identityCreated) io.out('  existing identity: no new activation code');
      if (added.activation) printActivation(io, added.activation, added.email);
      io.audit({
        command: 'add-user',
        tenant: v.tenant,
        email: added.email,
        role: added.role,
        companies: v.companies,
      });
    },
  },

  'remove-user': {
    summary: 'Remove a person from a tenant (the identity and its history stay)',
    options: { tenant: text, email: text },
    required: ['tenant', 'email'],
    async run({ prisma, tenancy, identity, audit }, v, io) {
      await prisma.$transaction(async (tx) => {
        const tenant = await tenancy.requireTenant(tx, v.tenant!);
        const removed = await identity.removeMember(tx, { tenantId: tenant.id, email: v.email! });
        await audit.recordTenantEvent(tx, {
          tenantId: tenant.id,
          source: 'CLI',
          type: 'MEMBER_REMOVED',
          subject: { type: 'membership', id: removed.membershipId },
          details: { email: v.email!.trim().toLowerCase() },
        });
      });
      io.out(`${v.email} removed from ${v.tenant}`);
      io.audit({ command: 'remove-user', tenant: v.tenant, email: v.email });
    },
  },

  'set-modules': {
    summary: 'Enable or disable modules of a tenant, respecting their dependencies',
    options: { tenant: text, enable: text, disable: text },
    required: ['tenant'],
    async run({ prisma, tenancy, audit }, v, io) {
      const modules = await prisma.$transaction(async (tx) => {
        const tenant = await tenancy.requireTenant(tx, v.tenant!);
        const enabled = await tenancy.setModules(tx, v.tenant!, {
          enable: list(v.enable),
          disable: list(v.disable),
        });
        await audit.recordTenantEvent(tx, {
          tenantId: tenant.id,
          source: 'CLI',
          type: 'MODULES_CHANGED',
          subject: { type: 'tenant', id: tenant.id },
          details: { modules: enabled },
        });
        return enabled;
      });
      io.out(`Modules of ${v.tenant}: ${modules.join(', ')}`);
      io.audit({ command: 'set-modules', tenant: v.tenant, modules });
    },
  },

  'issue-code': {
    summary:
      'Issue an activation code. For an account already activated it is a recovery: using it resets the password and the two-factor setup',
    options: { email: text },
    required: ['email'],
    async run({ prisma, identity, auth, audit }, v, io) {
      const { issued, recovery } = await prisma.$transaction(async (tx) => {
        const issued = await identity.issueActivationCodeFor(tx, v.email!);
        const recovery = await auth.hasCredentials(tx, issued.userId);
        if (recovery) {
          await audit.recordAuthEvent(tx, {
            userId: issued.userId,
            type: 'ACCOUNT_RECOVERY_ISSUED',
            details: { by: 'operator' },
          });
        }
        return { issued, recovery };
      });
      if (recovery) {
        io.out('This account is already active: this is a RECOVERY code.');
        io.out('Using it resets the password and the two-factor setup and closes every session.');
      }
      printActivation(io, issued, issued.email);
      io.audit({ command: 'issue-code', email: issued.email, recovery });
    },
  },

  'revoke-sessions': {
    summary: 'Sign a person out everywhere (emergency)',
    options: { email: text },
    required: ['email'],
    async run({ prisma, identity, auth }, v, io) {
      const closed = await prisma.$transaction(async (tx) => {
        const user = await identity.requireUserByEmail(tx, v.email!);
        return auth.revokeAllSessions(tx, user.id);
      });
      io.out(`${closed} session(s) of ${v.email} closed`);
      io.audit({ command: 'revoke-sessions', email: v.email, sessions: closed });
    },
  },

  'seed-demo': {
    summary:
      'Create the fictitious demo tenants that are missing, with twelve months of history up to --today (refused in production without --allow-production)',
    options: { 'allow-production': { type: 'boolean' }, today: text },
    required: [],
    async run(context, v, io) {
      assertDemoAllowed(context.config, v);
      const result = await context.prisma.$transaction(async (tx) => {
        const seeded = await seedDemo(tx, demoServices(context), { today: demoToday(v) });
        await demoCredentials(context, tx, seeded.userIds);
        await demoOperator(context, tx);
        return seeded;
      }, SEED_TRANSACTION);
      printDemo(io, context.config.isProduction, result);
      io.audit({
        command: 'seed-demo',
        today: result.today,
        tenants: result.tenants.filter((t) => t.created).map((t) => t.slug),
        documents: result.tenants.reduce((sum, t) => sum + t.documents, 0),
        orders: result.tenants.reduce((sum, t) => sum + t.orders, 0),
        invoices: result.tenants.reduce((sum, t) => sum + t.invoices, 0),
      });
    },
  },

  'reset-demo': {
    summary:
      'Delete the demo tenants and create them again with a fresh history up to --today; people outside the demo who belonged to them are put back (refused in production without --allow-production; --dry-run only lists)',
    options: {
      'allow-production': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      today: text,
    },
    required: [],
    async run(context, v, io) {
      assertDemoAllowed(context.config, v);
      const kept = await keptMembers(context.prisma);
      const tenants = await context.prisma.tenant.findMany({
        where: { slug: { in: [...DEMO_SLUGS] } },
        select: { slug: true },
      });
      io.out(
        `Demo tenants to delete: ${tenants.map((t) => t.slug).join(', ') || 'none'} (all their data)`,
      );
      io.out(
        kept.length === 0
          ? 'People outside the demo to put back: none'
          : `People outside the demo to put back: ${kept
              .map((k) => `${k.email} (${k.role} in ${k.slug})`)
              .join(', ')}`,
      );
      if (v['dry-run'] === 'true') {
        io.out('Dry run: nothing changed.');
        return;
      }
      const result = await context.prisma.$transaction(async (tx) => {
        const reset = await resetDemo(tx, demoServices(context), { today: demoToday(v) });
        await demoCredentials(context, tx, reset.userIds);
        await demoOperator(context, tx);
        return reset;
      }, RESET_TRANSACTION);
      printDemo(io, context.config.isProduction, result);
      io.audit({
        command: 'reset-demo',
        today: result.today,
        deleted: result.deleted,
        kept: result.kept.map((k) => `${k.email}@${k.slug}`),
        documents: result.tenants.reduce((sum, t) => sum + t.documents, 0),
        orders: result.tenants.reduce((sum, t) => sum + t.orders, 0),
        invoices: result.tenants.reduce((sum, t) => sum + t.invoices, 0),
      });
    },
  },

  'verify-stock': {
    summary:
      'Check that every stock balance equals the sum of its movements, and what it has reserved the sum of its reservations (reports, never fixes)',
    options: {},
    required: [],
    async run({ prisma, warehouse }, _v, io) {
      const differences = await warehouse.verifyStock(prisma);
      if (differences.length === 0) {
        io.out(
          'Stock is consistent: every balance equals the sum of its movements, and of its reservations.',
        );
        return;
      }
      for (const d of differences) {
        io.err(
          `tenant ${d.tenantId} warehouse ${d.warehouseId} item ${d.itemId}: balance ${d.balance.toString()}, movements ${d.movements.toString()}, reserved ${d.reserved.toString()}, reservations ${d.reservations.toString()}`,
        );
      }
      throw new DomainException('STOCK_INCONSISTENT', HttpStatus.CONFLICT, {
        detail: `${differences.length} balance(s) differ from their movements or reservations`,
      });
    },
  },

  'republish-fulfilments': {
    summary:
      'Publish again the shipments of sales orders of a tenant, for the modules that listen to them (invoicing); running it twice adds nothing',
    options: { tenant: text },
    required: ['tenant'],
    async run({ prisma, tenancy, orders }, v, io) {
      const published = await prisma.$transaction(async (tx) => {
        const tenant = await tenancy.requireTenant(tx, v.tenant!);
        return orders.republishFulfilments(tx, tenant.id);
      });
      io.out(`Shipments of ${v.tenant} published again: ${published}`);
      io.audit({ command: 'republish-fulfilments', tenant: v.tenant, published });
    },
  },

  'verify-invoicing': {
    summary:
      'Check that every due date is settled exactly by its payments and credit notes (reports, never fixes)',
    options: {},
    required: [],
    async run({ prisma, invoicing }, _v, io) {
      const differences = await invoicing.verify(prisma);
      if (differences.length === 0) {
        io.out(
          'Invoicing is consistent: every due date is settled by its payments and credit notes.',
        );
        return;
      }
      for (const d of differences) {
        io.err(
          `tenant ${d.tenantId} due date ${d.dueDateId}: settled ${d.settled.toString()}, allocated ${d.allocated.toString()}`,
        );
      }
      throw new DomainException('INVOICING_INCONSISTENT', HttpStatus.CONFLICT, {
        detail: `${differences.length} due date(s) differ from their payments and credit notes`,
      });
    },
  },

  'grant-operator': {
    summary:
      'Make a person a platform operator (the first one at installation); --name creates a new identity',
    options: { email: text, name: text },
    required: ['email'],
    async run({ prisma, identity, audit }, v, io) {
      const granted = await prisma.$transaction(async (tx) => {
        const grant = await identity.grantPlatformOperator(tx, { email: v.email!, name: v.name });
        const activation = grant.identityCreated
          ? await identity.issueActivationCode(tx, grant.userId)
          : undefined;
        await audit.recordAuthEvent(tx, {
          userId: grant.userId,
          type: 'OPERATOR_GRANTED',
          details: { by: 'terminal' },
        });
        return { ...grant, activation };
      });
      io.out(`${granted.email} is now a platform operator.`);
      if (!granted.identityCreated) io.out('Existing identity: they sign in as usual.');
      if (granted.activation) printActivation(io, granted.activation, granted.email);
      io.audit({ command: 'grant-operator', email: granted.email });
    },
  },

  'revoke-operator': {
    summary: 'Revoke a platform operator, effective at their next request',
    options: { email: text, reason: text },
    required: ['email', 'reason'],
    async run({ prisma, identity, audit }, v, io) {
      const revoked = await prisma.$transaction(async (tx) => {
        const grant = await identity.revokePlatformOperator(tx, {
          email: v.email!,
          reason: v.reason!,
        });
        await audit.recordAuthEvent(tx, {
          userId: grant.userId,
          type: 'OPERATOR_REVOKED',
          details: { by: 'terminal', reason: v.reason!.trim() },
        });
        return grant;
      });
      io.out(`${revoked.email} is no longer a platform operator.`);
      // Sessions belong to the person, who may work in tenants too: they stay open.
      io.out(
        `If the account is compromised, close its sessions too: revoke-sessions --email ${revoked.email}`,
      );
      io.audit({ command: 'revoke-operator', email: revoked.email });
    },
  },

  'list-operators': {
    summary: 'List platform operators, current and revoked',
    options: {},
    required: [],
    async run({ prisma, identity }, _v, io) {
      const grants = await identity.listPlatformOperators(prisma);
      if (grants.length === 0) io.out('No platform operators yet: grant-operator adds the first.');
      for (const g of grants) {
        const state = g.revokedAt
          ? `revoked ${g.revokedAt.toISOString()} (${g.revokeReason})`
          : 'active';
        io.out(`${g.user.email}  ${g.user.name}  granted ${g.grantedAt.toISOString()}  ${state}`);
      }
    },
  },

  'list-tenants': {
    summary: 'List tenants with their companies, modules and members',
    options: {},
    required: [],
    async run({ prisma, tenancy, identity }, _v, io) {
      const tenants = await tenancy.listTenants(prisma);
      if (tenants.length === 0) io.out('No tenants yet.');
      for (const tenant of tenants) {
        const vatById = new Map(tenant.companies.map((c) => [c.id, c.vatNumber]));
        io.out(`${tenant.slug}  ${tenant.name}  [${tenant.status}]`);
        const enabled = new Set(tenant.modules.map((m) => m.moduleKey));
        io.out(`  modules:   ${MODULE_KEYS.filter((key) => enabled.has(key)).join(', ')}`);
        for (const company of tenant.companies) {
          io.out(`  company:   ${company.legalName} (VAT ${company.vatNumber})`);
        }
        for (const member of await identity.listMembers(prisma, tenant.id)) {
          const reach = member.access.allCompanies
            ? 'all companies'
            : member.access.companyIds.map((id) => vatById.get(id)).join(', ');
          io.out(`  member:    ${member.email}  ${member.role}  [${member.status}]  ${reach}`);
        }
      }
    },
  },
};

export function resolveServices(app: INestApplicationContext): Services {
  return {
    config: app.get<AppConfig>(APP_CONFIG),
    prisma: app.get(PrismaService),
    tenancy: app.get(TenancyService),
    identity: app.get(IdentityService),
    audit: app.get(AuditService),
    auth: app.get(AuthService),
    registry: app.get(RegistryService),
    warehouse: app.get(WarehouseService),
    orders: app.get(OrdersService),
    invoicing: app.get(InvoicingService),
  };
}
