import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'mercurio:public';
export const REQUIRES_COMPANY = 'mercurio:requiresCompany';
export const STRICT_RATE_LIMIT = 'mercurio:strictRateLimit';
export const REQUIRES_PLATFORM_OPERATOR = 'mercurio:requiresPlatformOperator';

/**
 * Lets a route be called without signing in. Every route is protected by default (docs/adr/0014):
 * a new route needs this decorator to be open, and a test lists the open ones.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * The route works on one company: the request must carry a reachable company in the
 * `X-Company-Id` header (S5). Without it: 400 COMPANY_REQUIRED; with one the person cannot
 * reach: 403 COMPANY_NOT_ACCESSIBLE.
 */
export const RequiresCompany = () => SetMetadata(REQUIRES_COMPANY, true);

/**
 * The route belongs to the platform area (docs/adr/0038): only an active platform operator may
 * call it, whatever tenant they have chosen. Every route under `platform/` has it, and no other
 * route does (checked by the route inventory test).
 */
export const RequiresPlatformOperator = () => SetMetadata(REQUIRES_PLATFORM_OPERATOR, true);

/** Applies the stricter rate limit used by sign-in routes (AUTH_RATE_LIMIT_PER_MINUTE). */
export const StrictRateLimit = () => SetMetadata(STRICT_RATE_LIMIT, true);
