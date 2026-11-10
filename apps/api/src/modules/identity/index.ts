// Public surface of the identity module: other modules import from here only (B3).
export { type CompanyAccess, canAccessCompany } from './company-access.js';
export { newActivationCode, RECOVERY_CODE_DAYS } from './activation-code.js';
export { normalizeEmail } from './email.js';
export { IdentityModule } from './identity.module.js';
export {
  type Actor,
  IdentityService,
  type MemberInput,
  type MemberView,
  roleLabel,
  ROLES,
} from './identity.service.js';
export {
  ASSIGNABLE_PERMISSIONS,
  isPermission,
  missingRequirements,
  PERMISSION_MODULE,
  PERMISSION_REQUIRES,
  PERMISSIONS,
  type Permission,
  permissionsFor,
  REQUIRED_PERMISSION,
  RequiresPermission,
  RESERVED_PERMISSIONS,
  ROLE_PERMISSIONS,
} from './permissions.js';
export { BUILTIN_ROLES, isBuiltinRole, type RoleChoice, type RoleRef } from './roles.js';
export { RoleRefDto, toRoleRefDto } from './role-ref.dto.js';
