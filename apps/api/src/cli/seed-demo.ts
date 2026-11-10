import type { IdentityService } from '../modules/identity/index.js';
import type { InvoicingService } from '../modules/invoicing/index.js';
import type { OrdersService } from '../modules/orders/index.js';
import type { PartyInput, RegistryService } from '../modules/registry/index.js';
import type { TenancyService } from '../modules/tenancy/index.js';
import type { WarehouseService } from '../modules/warehouse/index.js';
import type { DbClient } from '../prisma/index.js';
import { businessToday } from '../shared/dates.js';
import { italianCheckDigit, personalTaxCodeCheckChar } from '../shared/italian-identifiers.js';
import {
  type Feature,
  FEATURES,
  type HistoryItem,
  type Story,
  writeHistory,
} from './demo-history.js';

/**
 * Fictitious demo data (S2, S8; docs/conventions.md B21): two tenants that show both the
 * company and the tenant boundaries, with twelve months of history up to a reference day
 * (`demo-history.ts`). Emails use example.com, a domain reserved for examples (RFC 2606), and
 * VAT numbers and tax codes are made up with a valid check character.
 *
 * - rossi: two companies, one person per role, two people limited to one company; a registry
 *   with every kind of party (one archived, one abroad) and goods and services;
 * - bianchi: one company, its own admin, invoicing without orders;
 * - Paola Conti, a consultant, belongs to both tenants with a different role in each (S4).
 *
 * The command gives every demo person the same fictitious password and authenticator secret
 * (outside production), so the demo can be signed into.
 */
export const DEMO_PASSWORD = 'Demo-password-2026';
/** Base32 secret shared by all demo people: add it to any authenticator app to get the codes. */
export const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/** A demo party with the short name the history uses for it. */
type DemoParty = { key: string } & PartyInput & { archived?: boolean };

export const DEMO = {
  tenants: [
    {
      slug: 'rossi',
      name: 'Gruppo Rossi',
      modules: ['all'],
      companies: [
        { legalName: 'Rossi Srl', vatNumber: withCheckDigit('0274651096'), story: 'rossi-srl' },
        {
          legalName: 'Rossi Logistica Srl',
          vatNumber: withCheckDigit('0381927364'),
          story: 'rossi-logistica',
        },
      ],
      members: [
        { email: 'anna.rossi', name: 'Anna Rossi', role: 'ADMIN', companies: 'all' },
        { email: 'sara.neri', name: 'Sara Neri', role: 'ACCOUNTANT', companies: 'all' },
        { email: 'marco.verdi', name: 'Marco Verdi', role: 'WAREHOUSE_KEEPER', companies: [1] },
        { email: 'luca.gallo', name: 'Luca Gallo', role: 'READ_ONLY', companies: [0] },
        { email: 'paola.conti', name: 'Paola Conti', role: 'ACCOUNTANT', companies: 'all' },
        // A custom role (phase 7), and someone who has not activated the account yet: the
        // People page shows both, and offers a new code for the second.
        { email: 'elena.ferri', name: 'Elena Ferri', role: 'Commerciale', companies: 'all' },
        {
          email: 'giulia.moretti',
          name: 'Giulia Moretti',
          role: 'READ_ONLY',
          companies: [0],
          pending: true,
        },
      ],
      roles: [
        {
          name: 'Commerciale',
          description: 'Clienti e fornitori, ordini dei clienti, fatture in lettura',
          basedOn: 'ACCOUNTANT',
          permissions: [
            'parties:read',
            'parties:write',
            'items:read',
            'stock:read',
            'orders:read',
            'orders:write',
            'invoicing:read',
          ],
        },
      ],
      parties: [
        company('bruni', 'Ferramenta Bruni Srl', '0612345678', 'SRL', 'customer', {
          address: 'Via Torino 12',
          postalCode: '20123',
          city: 'Milano',
          province: 'MI',
          email: 'ordini@ferramenta-bruni.example.com',
          sdiCode: 'M5UXCR1',
          paymentTerms: '30FM',
          paymentMethod: 'MP05',
        }),
        company('edilnord', 'Edilnord Spa', '0723456789', 'SPA', 'both', {
          address: 'Via Bergamo 140',
          postalCode: '24047',
          city: 'Treviglio',
          province: 'BG',
          pecEmail: 'edilnord@pec.example.com',
          sdiCode: '0000000',
          paymentTerms: '30-60FM',
          paymentMethod: 'MP12',
        }),
        company('viteria', 'Viteria Lombarda Srl', '0834567890', 'SRL', 'supplier', {
          address: 'Via dei Mille 8',
          postalCode: '25122',
          city: 'Brescia',
          province: 'BS',
          phone: '030 123456',
        }),
        company('cementi', 'Cementi Bergamaschi Spa', '1490123456', 'SPA', 'supplier', {
          address: 'Via Cave 3',
          postalCode: '24030',
          city: 'Calusco d’Adda',
          province: 'BG',
        }),
        {
          key: 'marino',
          kind: 'SOLE_TRADER',
          isCustomer: true,
          isSupplier: false,
          legalName: 'Studio Tecnico Marino',
          firstName: 'Luca',
          lastName: 'Marino',
          vatNumber: withCheckDigit('0945678901'),
          taxCode: withCheckChar('MRNLCU79L04F704'),
          address: 'Via Lecco 7',
          postalCode: '20900',
          city: 'Monza',
          province: 'MB',
          sdiCode: 'KRRH6B9',
        },
        {
          key: 'ferri',
          kind: 'PRIVATE',
          isCustomer: true,
          isSupplier: false,
          firstName: 'Giulia',
          lastName: 'Ferri',
          taxCode: withCheckChar('FRRGLI85C52C933'),
          address: 'Via Milano 3',
          postalCode: '22100',
          city: 'Como',
          province: 'CO',
          email: 'giulia.ferri@example.com',
          sdiCode: '0000000',
          paymentTerms: 'RD',
          paymentMethod: 'MP08',
        },
        {
          key: 'lario',
          kind: 'ORGANIZATION',
          isCustomer: true,
          isSupplier: false,
          legalName: 'Associazione Sportiva Lario',
          taxCode: withCheckDigit('9301234567'),
          address: 'Via Promessi Sposi 20',
          postalCode: '23900',
          city: 'Lecco',
          province: 'LC',
          pecEmail: 'aslario@pec.example.com',
          sdiCode: '0000000',
        },
        {
          key: 'muller',
          kind: 'COMPANY',
          isCustomer: true,
          isSupplier: false,
          legalName: 'Baustoffe Müller GmbH',
          vatNumber: 'DE811234567',
          country: 'DE',
          address: 'Hauptstraße 5',
          postalCode: '80331',
          city: 'München',
          notes: 'Prezzi concordati in euro.',
        },
        {
          ...company('riva', 'Elettroforniture Riva Snc', '1056789012', 'SNC', 'supplier', {
            city: 'Varese',
            province: 'VA',
          }),
          notes: 'Non più attivo: sostituito da Viteria Lombarda.',
          archived: true,
        },
      ],
      items: [
        good('VT-M6-20', 'Vite a testa esagonale M6x20 zincata', 'PZ', '0.12'),
        good('VT-M8-30', 'Vite a testa esagonale M8x30 zincata', 'PZ', '0.18'),
        good('DD-M6', 'Dado esagonale M6', 'PZ', '0.05'),
        good('RN-M6', 'Rondella piana M6', 'PZ', '0.03'),
        good('TS-8', 'Tasselli in nylon 8 mm (100 pezzi)', 'CF', '4.90'),
        good('CH-BRU', 'Set di chiavi a brugola', 'SET', '12.50'),
        good('TR-18V', 'Trapano avvitatore a batteria 18 V', 'PZ', '89.00'),
        good('SM-125', 'Smerigliatrice angolare 125 mm', 'PZ', '64.90'),
        good('CV-3G15', 'Cavo elettrico 3G1,5', 'M', '0.85'),
        good('CM-PORT', 'Cemento Portland', 'KG', '0.22'),
        good('VR-BIA', 'Idropittura bianca', 'L', '7.80'),
        good('GU-NIT', 'Guanti in nitrile (50 pezzi)', 'CF', '6.40'),
        good('MAN-INST', 'Manuale di installazione (libro)', 'PZ', '18.00', '4'),
        service('MDO-ORA', 'Manodopera specializzata', 'H', '35.00', '22'),
        service('CORSO-SIC', 'Corso di formazione sulla sicurezza', 'H', '50.00', 'N4'),
      ],
      // Per company, by position in `companies`: warehouses and reorder levels.
      warehouses: [
        {
          warehouses: [
            { code: 'SEDE', name: 'Magazzino della sede' },
            { code: 'DEP', name: 'Deposito Nord' },
          ],
          reorderLevels: [
            { warehouse: 'SEDE', item: 'TR-18V', reorderPoint: '5', reorderQuantity: '10' },
            { warehouse: 'SEDE', item: 'SM-125', reorderPoint: '3', reorderQuantity: '5' },
            { warehouse: 'SEDE', item: 'GU-NIT', reorderPoint: '30', reorderQuantity: '50' },
            { warehouse: 'SEDE', item: 'VT-M6-20', reorderPoint: '500', reorderQuantity: '2000' },
          ],
        },
        {
          warehouses: [{ code: 'HUB', name: 'Hub logistico' }],
          reorderLevels: [
            { warehouse: 'HUB', item: 'CM-PORT', reorderPoint: '1000', reorderQuantity: '2000' },
          ],
        },
      ],
      // Per company: header data for the invoices.
      profiles: [
        {
          address: "Via dell'Industria 21",
          postalCode: '20141',
          city: 'Milano',
          province: 'MI',
          reaOffice: 'MI',
          reaNumber: '1987654',
          shareCapital: '50000',
          soleShareholder: false,
          iban: 'IT60X0542811101000000123456',
          pecEmail: 'rossisrl@pec.example.com',
        },
        {
          address: 'Via del Porto 5',
          postalCode: '24121',
          city: 'Bergamo',
          province: 'BG',
          reaOffice: 'BG',
          reaNumber: '765432',
          shareCapital: '20000',
          soleShareholder: true,
          iban: 'IT07X0542811101000000654321',
        },
      ],
    },
    {
      slug: 'bianchi',
      name: 'Bianchi Snc',
      modules: ['registry', 'invoicing'],
      companies: [
        { legalName: 'Bianchi Snc', vatNumber: withCheckDigit('0519283746'), story: 'bianchi' },
      ],
      members: [
        { email: 'giorgio.bianchi', name: 'Giorgio Bianchi', role: 'ADMIN', companies: 'all' },
        { email: 'paola.conti', name: 'Paola Conti', role: 'READ_ONLY', companies: 'all' },
      ],
      parties: [
        company('cartoleria', 'Cartoleria Centrale Srl', '1167890123', 'SRL', 'supplier', {
          city: 'Bologna',
          province: 'BO',
        }),
        company('gentile', 'Studio Associato Gentile', '1278901234', null, 'customer', {
          address: 'Corso Canalgrande 40',
          postalCode: '41121',
          city: 'Modena',
          province: 'MO',
          pecEmail: 'gentile@pec.example.com',
          paymentTerms: '30DF',
          paymentMethod: 'MP05',
        }),
        company('ferraro', 'Studio Legale Ferraro', '1389012345', null, 'customer', {
          address: 'Via Farini 14',
          postalCode: '40124',
          city: 'Bologna',
          province: 'BO',
          pecEmail: 'ferraro@pec.example.com',
          paymentTerms: '30DF',
          paymentMethod: 'MP05',
        }),
      ],
      items: [
        service('CONS-ORA', 'Consulenza amministrativa', 'H', '60.00', '22'),
        good('CARTA-A4', 'Carta A4 80 g (5 risme)', 'CF', '24.90'),
        good('TONER-K', 'Toner nero per stampante laser', 'PZ', '49.00'),
      ],
      warehouses: [],
      profiles: [
        {
          address: 'Via Emilia Ponente 100',
          postalCode: '40133',
          city: 'Bologna',
          province: 'BO',
          reaOffice: 'BO',
          reaNumber: '345678',
          iban: 'IT20Y0306909606100000063789',
        },
      ],
    },
  ],
} as const;

/** The slugs of the demo tenants: `reset-demo` may delete these, and nothing else. */
export const DEMO_SLUGS: readonly string[] = DEMO.tenants.map((t) => t.slug);
/**
 * The platform operator of the demo, outside production only (fase-8a.md, question 4): in
 * production the demo has no shared credentials, and the real operator is granted from the
 * terminal. Belongs to no tenant.
 */
export const DEMO_OPERATOR = {
  email: 'operatore@example.com',
  name: 'Ornella Operatrice',
} as const;

/** The emails of the demo people (without a test suffix). */
export const DEMO_EMAILS: readonly string[] = [
  ...new Set(DEMO.tenants.flatMap((t) => t.members.map((m) => `${m.email}@example.com`))),
];

export interface SeedSummary {
  slug: string;
  /** False when the tenant was already there: nothing was added to it. */
  created: boolean;
  companies: number;
  members: number;
  parties: number;
  items: number;
  documents: number;
  orders: number;
  invoices: number;
}

export interface SeedServices {
  tenancy: TenancyService;
  identity: IdentityService;
  registry: RegistryService;
  warehouse: WarehouseService;
  orders: OrdersService;
  invoicing: InvoicingService;
}

export interface SeedOptions {
  /** The last day of the story; default today (Italian time). */
  today?: string;
  /** For tests only: makes slugs and emails unique, so tests never touch the real demo data. */
  suffix?: string;
}

/**
 * Creates the demo tenants that are missing, with their history (call it inside one
 * transaction). A demo tenant that exists is left as it is: its history is written once, from the
 * first day, because numbers and dates of invoices must grow together. To start again, use
 * `reset-demo`.
 */
export async function seedDemo(db: DbClient, services: SeedServices, options: SeedOptions = {}) {
  const suffix = options.suffix ?? '';
  const today = options.today ?? businessToday();
  const slug = (base: string) => (suffix ? `${base}-${suffix}` : base);
  const email = (local: string) => `${local}${suffix ? `.${suffix}` : ''}@example.com`;
  const summary: SeedSummary[] = [];
  const userIds = new Set<string>();
  const shown = new Set<Feature>();

  for (const tenant of DEMO.tenants) {
    if (await services.tenancy.findTenantBySlug(db, slug(tenant.slug))) {
      summary.push({
        slug: slug(tenant.slug),
        created: false,
        companies: tenant.companies.length,
        members: tenant.members.length,
        parties: 0,
        items: 0,
        documents: 0,
        orders: 0,
        invoices: 0,
      });
      continue;
    }
    const [first, ...others] = tenant.companies;
    const made = await services.tenancy.createTenant(db, {
      name: tenant.name,
      slug: slug(tenant.slug),
      modules: tenant.modules,
      company: { legalName: first.legalName, vatNumber: first.vatNumber },
    });
    const tenantId = made.tenant.id;
    const companyIds = [made.company.id];
    for (const company of others) {
      const added = await services.tenancy.addCompany(db, made.tenant.slug, {
        legalName: company.legalName,
        vatNumber: company.vatNumber,
      });
      companyIds.push(added.id);
    }
    for (const role of 'roles' in tenant ? tenant.roles : []) {
      await services.identity.createRole(db, tenantId, role);
    }
    for (const member of tenant.members) {
      const added = await services.identity.addMember(db, {
        tenantId,
        email: email(member.email),
        name: member.name,
        role: member.role,
        companies:
          member.companies === 'all' ? 'all' : member.companies.map((index) => companyIds[index]!),
      });
      // A pending person gets no demo credentials: they have not activated their account.
      if (!('pending' in member && member.pending)) userIds.add(added.userId);
    }

    const parties = new Map<string, string>();
    for (const { key, ...party } of tenant.parties as readonly DemoParty[]) {
      parties.set(key, (await services.registry.addPartyIfMissing(db, tenantId, party)).id);
    }
    for (const item of tenant.items) await services.registry.addItemIfMissing(db, tenantId, item);
    const itemIds = await services.registry.itemIdsByCode(
      db,
      tenantId,
      tenant.items.map((i) => i.code),
    );
    const items = new Map<string, HistoryItem>(
      tenant.items.map((i) => [i.code, { id: itemIds.get(i.code)!, salePrice: i.salePrice }]),
    );

    let documents = 0;
    let orders = 0;
    let invoices = 0;
    for (const [index, spec] of tenant.companies.entries()) {
      const company = { tenantId, companyId: companyIds[index]!, userId: null };
      const current = await services.tenancy.getCompany(db, company.companyId);
      await services.tenancy.updateCompanyProfile(
        db,
        company.companyId,
        current.version,
        tenant.profiles[index]!,
      );
      const warehouses = new Map<string, string>();
      const stock = (tenant.warehouses as readonly WarehouseSpec[])[index];
      for (const warehouse of stock?.warehouses ?? []) {
        warehouses.set(
          warehouse.code,
          (await services.warehouse.ensureWarehouse(db, company, warehouse)).id,
        );
      }
      const history = await writeHistory({
        db,
        services,
        company,
        story: spec.story as Story,
        today,
        items,
        parties,
        warehouses,
      });
      for (const level of stock?.reorderLevels ?? []) {
        await services.warehouse.setReorderLevelIfMissing(db, company, {
          warehouseId: warehouses.get(level.warehouse)!,
          itemId: items.get(level.item)!.id,
          reorderPoint: level.reorderPoint,
          reorderQuantity: level.reorderQuantity,
        });
      }
      documents += history.documents;
      orders += history.orders;
      invoices += history.invoices;
      for (const feature of history.features) shown.add(feature);
    }
    summary.push({
      slug: slug(tenant.slug),
      created: true,
      companies: tenant.companies.length,
      members: tenant.members.length,
      parties: tenant.parties.length,
      items: tenant.items.length,
      documents,
      orders,
      invoices,
    });
  }
  const created = summary.some((t) => t.created);
  return {
    tenants: summary,
    userIds: [...userIds],
    today,
    /** What the demo was meant to show and did not (empty when every tenant was there already). */
    missing: created ? FEATURES.filter((f) => !shown.has(f)) : [],
  };
}

interface WarehouseSpec {
  warehouses: readonly { code: string; name: string }[];
  reorderLevels: readonly {
    warehouse: string;
    item: string;
    reorderPoint: string;
    reorderQuantity: string;
  }[];
}

function company(
  key: string,
  legalName: string,
  vatFirst10: string,
  legalForm: string | null,
  role: 'customer' | 'supplier' | 'both',
  extra: Partial<PartyInput> = {},
): DemoParty {
  return {
    key,
    kind: 'COMPANY',
    isCustomer: role !== 'supplier',
    isSupplier: role !== 'customer',
    legalName,
    legalForm,
    vatNumber: withCheckDigit(vatFirst10),
    ...extra,
  };
}

function good(code: string, description: string, unit: string, salePrice: string, vatCode = '22') {
  return { code, description, unit, vatCode, salePrice, stockManaged: true };
}

function service(
  code: string,
  description: string,
  unit: string,
  salePrice: string,
  vatCode: string,
) {
  return { code, description, unit, vatCode, salePrice, stockManaged: false };
}

/** Completes the first 15 characters of a made-up personal tax code with its check letter. */
function withCheckChar(first15: string): string {
  return first15 + personalTaxCodeCheckChar(first15);
}

/** Appends the Italian VAT check digit to 10 digits, so demo numbers pass validation. */
function withCheckDigit(first10: string): string {
  return first10 + italianCheckDigit(first10);
}
