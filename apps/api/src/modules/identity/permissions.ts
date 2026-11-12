import { SetMetadata } from '@nestjs/common';
import type { MembershipRole } from '../../generated/prisma/client.js';

/**
 * What a person may do, as `area:action`. Roles are bundles of permissions; the code checks
 * permissions, never roles, so a role can change without touching the routes
 * (docs/adr/0014). Each area got its actions when it was built: the registry (parties and items
 * apart), the warehouse, orders (moving goods apart) and invoicing (payments and the company's
 * header data apart). Tenants may bundle them into roles of their own (docs/adr/0036).
 */
export const PERMISSIONS = [
  'parties:read',
  'parties:write',
  'items:read',
  'items:write',
  'stock:read',
  'stock:write',
  'warehouses:manage',
  'orders:read',
  'orders:write',
  'orders:fulfil',
  'invoicing:read',
  'invoicing:write',
  'invoicing:issue',
  'payments:write',
  'companies:manage',
  'members:read',
  'members:manage',
  'roles:manage',
  'audit:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Permissions only the built-in ADMIN role has. A custom role cannot hold them: whoever manages
 * people or roles could otherwise make a role with everything and give it to themselves
 * (docs/adr/0036). The database refuses them too (CHECK on tenant_roles.permissions).
 */
export const RESERVED_PERMISSIONS: readonly Permission[] = ['members:manage', 'roles:manage'];

/** What a custom role may contain. */
export const ASSIGNABLE_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter(
  (permission) => !RESERVED_PERMISSIONS.includes(permission),
);

/**
 * What each permission needs to make sense: writing something you cannot read is never useful,
 * and the interface would show a page whose list is forbidden. A role must contain the whole
 * chain; the role editor ticks it automatically.
 */
export const PERMISSION_REQUIRES: Readonly<Record<Permission, readonly Permission[]>> = {
  'parties:read': [],
  'parties:write': ['parties:read'],
  'items:read': [],
  'items:write': ['items:read'],
  'stock:read': [],
  'stock:write': ['stock:read'],
  'warehouses:manage': ['stock:read'],
  'orders:read': [],
  'orders:write': ['orders:read'],
  'orders:fulfil': ['orders:read'],
  'invoicing:read': [],
  'invoicing:write': ['invoicing:read'],
  'invoicing:issue': ['invoicing:write'],
  'payments:write': ['invoicing:read'],
  'companies:manage': [],
  'members:read': [],
  'members:manage': ['members:read'],
  'roles:manage': ['members:read'],
  'audit:read': [],
};

/**
 * The module a permission belongs to, or null for the administration of the tenant. A permission
 * of a module the tenant has not enabled can be saved in a role but has no effect: the module
 * guard still refuses the routes, and the role works as soon as the module is enabled.
 */
export const PERMISSION_MODULE: Readonly<Record<Permission, string | null>> = {
  'parties:read': 'registry',
  'parties:write': 'registry',
  'items:read': 'registry',
  'items:write': 'registry',
  'stock:read': 'warehouse',
  'stock:write': 'warehouse',
  'warehouses:manage': 'warehouse',
  'orders:read': 'orders',
  'orders:write': 'orders',
  'orders:fulfil': 'orders',
  'invoicing:read': 'invoicing',
  'invoicing:write': 'invoicing',
  'invoicing:issue': 'invoicing',
  'payments:write': 'invoicing',
  'companies:manage': null,
  'members:read': null,
  'members:manage': null,
  'roles:manage': null,
  'audit:read': null,
};

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/** Every permission `permissions` needs and does not contain, following the whole chain. */
export function missingRequirements(permissions: readonly Permission[]): Permission[] {
  const held = new Set(permissions);
  const missing = new Set<Permission>();
  const visit = (permission: Permission) => {
    for (const required of PERMISSION_REQUIRES[permission]) {
      if (!held.has(required)) missing.add(required);
      visit(required);
    }
  };
  permissions.forEach(visit);
  return PERMISSIONS.filter((p) => missing.has(p));
}

const READ: readonly Permission[] = [
  'parties:read',
  'items:read',
  'stock:read',
  'orders:read',
  'invoicing:read',
];

export const ROLE_PERMISSIONS: Record<MembershipRole, readonly Permission[]> = {
  ADMIN: PERMISSIONS,
  // The warehouse keeper maintains the item catalog, records stock documents and moves the goods
  // of orders; the accountant maintains customers and suppliers and takes orders, but moves no
  // goods. Only administrators set up warehouses (phase 3).
  WAREHOUSE_KEEPER: [
    'parties:read',
    'items:read',
    'items:write',
    'stock:read',
    'stock:write',
    'orders:read',
    'orders:write',
    'orders:fulfil',
  ],
  // The accountant also records what customers pay; only administrators change the company's
  // invoice header data (phase 5).
  ACCOUNTANT: [
    ...READ,
    'parties:write',
    'orders:write',
    'invoicing:write',
    'invoicing:issue',
    'payments:write',
  ],
  READ_ONLY: READ,
};

/** The permissions of a built-in role. */
export function permissionsFor(role: MembershipRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export const REQUIRED_PERMISSION = 'mercurio:requiredPermission';

/**
 * Marks a route (or a whole controller) as needing a permission, or any one of several. Enforced
 * by the guard of the `auth` module; a route without it only needs a signed-in person.
 *
 * @example
 * @RequiresPermission('audit:read')
 * @Get()
 */
export const RequiresPermission = (...anyOf: [Permission, ...Permission[]]) =>
  SetMetadata(REQUIRED_PERMISSION, anyOf);
