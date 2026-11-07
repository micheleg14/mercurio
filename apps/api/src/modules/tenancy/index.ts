// Public surface of the tenancy module: other modules import from here only (B3).
export {
  applyModuleChange,
  MODULE_CATALOG,
  MODULE_KEYS,
  type ModuleKey,
  parseModuleKeys,
} from './module-catalog.js';
export {
  type CompanyProfileData,
  type CompanyProfileInput,
  isTaxRegime,
  missingForInvoices,
  TAX_REGIMES,
  type TaxRegime,
} from './company-profile.js';
export { RequiresModule } from './requires-module.js';
export { TenancyModule } from './tenancy.module.js';
export { type CompanyInput, TenancyService } from './tenancy.service.js';
